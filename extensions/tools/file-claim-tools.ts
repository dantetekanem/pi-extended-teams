import { Type } from "@sinclair/typebox";
import type * as claimOperations from "../../src/utils/claims";

export interface FileClaimOperations {
  claimFiles: typeof claimOperations.claimFiles;
  releaseFiles: typeof claimOperations.releaseFiles;
  listClaims: typeof claimOperations.listClaims;
}

export interface FileClaimToolsOptions {
  agentName: string;
  getAuthorizedWriteTeam(): Promise<string>;
  getCurrentTeam(): string;
  claims: FileClaimOperations;
}

export function createFileClaimTools(options: FileClaimToolsOptions): any[] {
  return [
    {
      name: "claim_file",
      label: "Claim File",
      description: "Claim file paths before an edit agent changes them. Claims are scoped to the current Pi session.",
      parameters: Type.Object({ paths: Type.Array(Type.String({ description: "Repository-relative file path." })) }),
      async execute(_toolCallId: string, params: any) {
        const targetTeamName = await options.getAuthorizedWriteTeam();
        const result = await options.claims.claimFiles(targetTeamName, options.agentName, params.paths);
        const text = result.conflicts.length > 0
          ? [
              `File claim request blocked for ${options.agentName}.`,
              "Conflicts:",
              ...result.conflicts.map(conflict => `- ${conflict.path} held by ${conflict.heldBy}`),
            ].join("\n")
          : result.granted.length > 0
            ? [`Claimed ${result.granted.length} file(s) for ${options.agentName}:`, ...result.granted.map(item => `- ${item}`)].join("\n")
            : `No file paths claimed for ${options.agentName}.`;
        return { content: [{ type: "text", text }], details: { agent: options.agentName, session: targetTeamName, ...result } };
      },
    },
    {
      name: "release_file",
      label: "Release File",
      description: "Release file claims held by the current edit agent.",
      parameters: Type.Object({ paths: Type.Array(Type.String({ description: "Repository-relative file path." })) }),
      async execute(_toolCallId: string, params: any) {
        const targetTeamName = await options.getAuthorizedWriteTeam();
        const released = await options.claims.releaseFiles(targetTeamName, options.agentName, params.paths);
        const text = released.length > 0
          ? `Released ${released.length} file claim(s) for ${options.agentName}:\n${released.map(item => `- ${item}`).join("\n")}`
          : `No matching file claims held by ${options.agentName} were released.`;
        return { content: [{ type: "text", text }], details: { agent: options.agentName, session: targetTeamName, released } };
      },
    },
    {
      name: "list_file_claims",
      label: "List File Claims",
      description: "List file claims in the current Pi session.",
      parameters: Type.Object({}),
      async execute() {
        const targetTeamName = options.getCurrentTeam();
        const currentClaims = (await options.claims.listClaims(targetTeamName)).sort((a, b) => a.path.localeCompare(b.path));
        const text = currentClaims.length > 0
          ? ["Current file claims:", ...currentClaims.map(claim => `- ${claim.path} held by ${claim.agent} since ${new Date(claim.since).toISOString()}`)].join("\n")
          : "No current file claims.";
        return { content: [{ type: "text", text }], details: { session: targetTeamName, claims: currentClaims } };
      },
    },
  ];
}
