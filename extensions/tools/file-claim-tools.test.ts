import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFileClaimTools } from "./file-claim-tools.js";
import * as claims from "../../src/utils/claims.js";
import * as paths from "../../src/utils/paths.js";

let root: string;

type Tool = {
  name: string;
  execute: (toolCallId: string, params: any) => Promise<any>;
};

function makeTools(agentName: string, authorize = vi.fn(async () => "session")) {
  const tools = createFileClaimTools({
    agentName,
    getAuthorizedWriteTeam: authorize,
    getCurrentTeam: () => "session",
    claims,
  });
  return { authorize, tools: new Map<string, Tool>(tools.map((tool: Tool) => [tool.name, tool])) };
}

describe("identity-bound file claim tools", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-file-claims-"));
    vi.spyOn(paths, "claimsPath").mockImplementation((teamName: string) => path.join(root, `${teamName}.json`));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("authorizes the bound writer and preserves normalized atomic grants", async () => {
    const { authorize, tools } = makeTools("writer");

    const result = await tools.get("claim_file")!.execute("claim", {
      paths: ["./src/a.ts", "src/a.ts/"],
    });

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      agent: "writer",
      session: "session",
      granted: ["src/a.ts"],
      conflicts: [],
    });
    expect(await claims.listClaims("session")).toEqual([
      expect.objectContaining({ agent: "writer", path: "src/a.ts" }),
    ]);
  });

  it("returns conflict holder details without partially granting the request", async () => {
    await claims.claimFiles("session", "other-writer", ["src/a.ts"]);
    const { tools } = makeTools("writer");

    const result = await tools.get("claim_file")!.execute("claim", {
      paths: ["src/a.ts", "src/b.ts"],
    });

    expect(result.details).toMatchObject({
      agent: "writer",
      session: "session",
      granted: [],
      conflicts: [{ path: "src/a.ts", heldBy: "other-writer" }],
    });
    expect(result.content[0].text).toContain("src/a.ts held by other-writer");
    expect((await claims.listClaims("session")).map(claim => claim.path)).toEqual(["src/a.ts"]);
  });

  it("lists active claims and releases only claims owned by the bound writer", async () => {
    await claims.claimFiles("session", "writer", ["src/b.ts"]);
    await claims.claimFiles("session", "other-writer", ["src/a.ts"]);
    const { tools } = makeTools("writer");

    const listed = await tools.get("list_file_claims")!.execute("list", {});
    expect(listed.details.claims.map((claim: any) => [claim.path, claim.agent])).toEqual([
      ["src/a.ts", "other-writer"],
      ["src/b.ts", "writer"],
    ]);

    const released = await tools.get("release_file")!.execute("release", {
      paths: ["src/a.ts", "./src/b.ts"],
    });
    expect(released.details.released).toEqual(["src/b.ts"]);
    expect(await claims.listClaims("session")).toEqual([
      expect.objectContaining({ agent: "other-writer", path: "src/a.ts" }),
    ]);
  });

  it("does not touch claim storage when writer authorization fails", async () => {
    const authorize = vi.fn(async () => {
      throw new Error("File claim tools are only available to write agents.");
    });
    const { tools } = makeTools("reader", authorize);

    await expect(tools.get("claim_file")!.execute("claim", { paths: ["src/a.ts"] }))
      .rejects.toThrow("only available to write agents");
    expect(await claims.listClaims("session")).toEqual([]);
  });
});
