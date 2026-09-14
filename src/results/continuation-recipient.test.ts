import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "../utils/paths";
import { assertUnusedContinuationRecipient, freshContinuationName } from "./continuation-recipient";

let root: string;
describe("continuation recipient namespaces", () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "continuation-recipient-")));
    vi.spyOn(paths, "teamDir").mockReturnValue(root);
    for (const [helper, suffix] of [["inboxPath", "inboxes/name.json"], ["runtimeStatusPath", "runtime/name.json"], ["lifecycleTombstonePath", "lifecycle/name.json"],
      ["claimsPath", "claims.json"], ["writeQueuePath", "write-queue.json"], ["readHelperQueuePath", "read-queue.json"]] as const) {
      vi.spyOn(paths, helper).mockReturnValue(path.join(root, suffix));
    }
    vi.spyOn(paths, "reportFilesDir").mockReturnValue(path.join(root, "reports"));
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  it("generates separate bounded recipients without creating namespace artifacts", () => {
    const first = freshContinuationName("reviewer");
    expect(first).toMatch(/^reviewer-[a-f0-9-]{36}$/);
    expect(freshContinuationName("reviewer")).not.toBe(first);
    expect(() => freshContinuationName("../old")).toThrow();
    expect(() => freshContinuationName("a".repeat(129))).toThrow();
    assertUnusedContinuationRecipient("team", "name");
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it.each(["inbox", "runtime", "fence", "claim", "writer-queue", "reader-queue", "report", "transcript", "lazy", "corrupt-claims"])("rejects retained %s evidence without changing it", kind => {
    const cases: Record<string, [string, unknown]> = {
      inbox: [paths.inboxPath("team", "name"), []], runtime: [paths.runtimeStatusPath("team", "name"), "corrupt"], fence: [paths.lifecycleTombstonePath("team", "name"), "corrupt"],
      claim: [paths.claimsPath("team"), { "src/a.ts": { agent: "name", path: "src/a.ts", since: 1 } }],
      "writer-queue": [paths.writeQueuePath("team"), [{ name: "name" }]], "reader-queue": [paths.readHelperQueuePath("team"), [{ name: "name" }]],
      report: [path.join(root, "reports.json"), [{ agentName: "name" }]], transcript: [path.join(root, "agent-sessions/name/old.jsonl"), {}],
      lazy: [path.join(root, "session-context/name--old.md"), {}], "corrupt-claims": [paths.claimsPath("team"), "corrupt"],
    };
    const [file, value] = cases[kind]; fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = typeof value === "string" ? value : JSON.stringify(value); fs.writeFileSync(file, bytes);
    expect(() => assertUnusedContinuationRecipient("team", "name")).toThrow(/continuation|namespace/i);
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  });
});
