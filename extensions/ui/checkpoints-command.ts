import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { listCheckpointRecords, retireCheckpoint } from "../../src/results/specialist-checkpoint";

export function registerCheckpointsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("agents-checkpoints", {
    description: "List saved specialist checkpoints or delete an exact checkpoint ID.",
    handler: async (args, ctx) => {
      try {
        const input = args.trim();
        if (!input || input === "list") {
          const { records, errors } = listCheckpointRecords();
          const lines = records.map(record => record.state === "ready"
            ? `${record.id} | ${record.author.agentName} | ${record.author.modelSlot} | ${record.expiresAt <= Date.now() ? "expired" : "ready"} | expires ${new Date(record.expiresAt).toISOString()}`
            : `${record.id} | ${record.state}`);
          ctx.ui.notify(lines.join("\n") || "No specialist checkpoints saved.", "info");
          for (const error of errors) ctx.ui.notify(error.message, "warning");
          return;
        }
        const match = /^delete\s+(\S+)$/.exec(input);
        if (!match) throw new Error("Usage: /agents-checkpoints [list | delete <checkpoint ID>]");
        const retired = await retireCheckpoint(match[1], "deleted");
        ctx.ui.notify(`${retired.id} is ${retired.state}. Future continuations cannot load it. Independent reports and previously delivered context are unchanged.`, "info");
      } catch (error) {
        ctx.ui.notify(String(error), "warning");
      }
    },
  });
}
