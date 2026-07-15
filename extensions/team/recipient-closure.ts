import * as teams from "../../src/utils/teams";
import {
  generateExtensionInstanceId,
  withLifecycleTombstoneLock,
} from "../../src/utils/lifecycle-tombstone";

export interface ClosePersistedRecipientOptions {
  removeOnFailure?: boolean;
  role?: "read" | "write";
  reason?: string;
  extensionInstanceId?: string;
}

const FALLBACK_EXTENSION_INSTANCE_ID = generateExtensionInstanceId();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function closePersistedRecipient(
  teamName: string,
  agentName: string,
  expectedRunId: string,
  options: ClosePersistedRecipientOptions = {}
): Promise<void> {
  await withLifecycleTombstoneLock(teamName, agentName, async lifecycleLock => {
    const tombstoneInput = {
      team: teamName,
      agent: agentName,
      runId: expectedRunId,
      role: options.role ?? "read",
      reason: options.reason ?? "quit",
      extensionInstanceId: options.extensionInstanceId ?? FALLBACK_EXTENSION_INSTANCE_ID,
    } as const;

    if (!teams.teamExists(teamName)) {
      lifecycleLock.occupy(tombstoneInput);
      lifecycleLock.updateMatching(expectedRunId, { phase: "persistence_closed", error: undefined });
      return;
    }

    const readExpectedMember = async () => {
      const config = await teams.readConfig(teamName);
      const member = config.members.find(item => item.name === agentName);
      if (member && member.lifecycleRunId !== expectedRunId) {
        throw new Error(
          `Refusing to close ${agentName} in ${teamName}: expected run ${expectedRunId}, found ${member.lifecycleRunId || "missing run id"}.`
        );
      }
      return member;
    };

    // Establish run identity under the recipient lock before creating a fence.
    // A wrong-run caller performs zero shared mutation. Unreadable persistence
    // cannot establish safety, so it is fenced fail-closed before returning.
    let initialMember: Awaited<ReturnType<typeof readExpectedMember>>;
    try {
      initialMember = await readExpectedMember();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing to close")) throw error;
      lifecycleLock.occupy(tombstoneInput);
      const message = `Could not close message admission for ${agentName} in ${teamName}: verification failed: ${errorText(error)}`;
      lifecycleLock.updateMatching(expectedRunId, { phase: "cleanup_failed", error: message });
      throw new Error(message);
    }

    lifecycleLock.occupy(tombstoneInput);
    if (!initialMember) {
      lifecycleLock.updateMatching(expectedRunId, { phase: "persistence_closed", error: undefined });
      return;
    }

    let updateError: unknown;
    try {
      await teams.updateMember(teamName, agentName, { isActive: false });
    } catch (error) {
      updateError = error;
    }

    let closed = false;
    let verificationError: unknown;
    try {
      const member = await readExpectedMember();
      closed = !member || member.isActive === false;
    } catch (error) {
      verificationError = error;
    }
    if (closed) {
      lifecycleLock.updateMatching(expectedRunId, { phase: "persistence_closed", error: undefined });
      return;
    }

    let removalError: unknown;
    if (options.removeOnFailure) {
      try {
        await readExpectedMember();
        await teams.removeMemberMatchingRun(teamName, agentName, expectedRunId);
      } catch (error) {
        removalError = error;
      }
      try {
        if (!(await readExpectedMember())) {
          lifecycleLock.updateMatching(expectedRunId, { phase: "persistence_closed", error: undefined });
          return;
        }
      } catch (error) {
        verificationError = error;
      }
    }

    const causes = [
      updateError ? `inactive update failed: ${errorText(updateError)}` : "inactive update did not close membership",
      verificationError ? `verification failed: ${errorText(verificationError)}` : undefined,
      removalError ? `removal failed: ${errorText(removalError)}` : undefined,
    ].filter(Boolean).join("; ");
    const message = `Could not close message admission for ${agentName} in ${teamName}: ${causes}`;
    lifecycleLock.updateMatching(expectedRunId, { phase: "cleanup_failed", error: message });
    throw new Error(message);
  });
}
