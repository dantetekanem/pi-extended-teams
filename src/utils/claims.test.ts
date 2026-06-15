import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as paths from "./paths";
import {
  claimFiles,
  releaseFiles,
  releaseAllForAgent,
  listClaims,
  normalizeClaimPath,
} from "./claims";

const testDir = path.join(os.tmpdir(), "pi-claims-test-" + Date.now());

beforeEach(() => {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });
  vi.spyOn(paths, "claimsPath").mockReturnValue(path.join(testDir, "claims.json"));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
});

describe("normalizeClaimPath", () => {
  it("collapses equivalent repository-relative paths", () => {
    expect(normalizeClaimPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeClaimPath("src/a.ts/")).toBe("src/a.ts");
    expect(normalizeClaimPath("  src/a.ts  ")).toBe("src/a.ts");
    expect(normalizeClaimPath("src\\a.ts")).toBe("src/a.ts");
  });

  it("rejects empty, root, absolute, and parent-traversal paths", () => {
    expect(() => normalizeClaimPath("")).toThrow("must not be empty");
    expect(() => normalizeClaimPath("   ")).toThrow("must not be empty");
    expect(() => normalizeClaimPath(".")).toThrow("must not refer to the repository root");
    expect(() => normalizeClaimPath("/")).toThrow("must be repository-relative");
    expect(() => normalizeClaimPath("/tmp/a.ts")).toThrow("must be repository-relative");
    expect(() => normalizeClaimPath("C:\\tmp\\a.ts")).toThrow("must be repository-relative");
    expect(() => normalizeClaimPath("../a.ts")).toThrow("must not traverse outside");
    expect(() => normalizeClaimPath("src/../../a.ts")).toThrow("must not traverse outside");
  });
});

describe("claimFiles", () => {
  it("grants free paths", async () => {
    const r = await claimFiles("t", "alice", ["src/a.ts", "src/b.ts"]);
    expect(r.granted.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.conflicts).toEqual([]);
  });

  it("blocks a path already held by another agent (all-or-nothing)", async () => {
    await claimFiles("t", "alice", ["src/a.ts"]);
    const r = await claimFiles("t", "bob", ["src/a.ts", "src/b.ts"]);
    expect(r.granted).toEqual([]);
    expect(r.conflicts).toEqual([{ path: "src/a.ts", heldBy: "alice" }]);
    // b.ts must NOT have been granted to bob since the batch failed
    const claims = await listClaims("t");
    expect(claims.find((c) => c.path === "src/b.ts")).toBeUndefined();
  });

  it("treats normalized variants as the same file", async () => {
    await claimFiles("t", "alice", ["src/a.ts"]);
    const r = await claimFiles("t", "bob", ["./src/a.ts"]);
    expect(r.conflicts[0]).toEqual({ path: "src/a.ts", heldBy: "alice" });
  });

  it("rejects an invalid path before writing any claims", async () => {
    await expect(claimFiles("t", "alice", ["src/a.ts", ""])).rejects.toThrow("must not be empty");
    expect(await listClaims("t")).toEqual([]);
  });

  it("re-claiming your own path is idempotent and keeps original since", async () => {
    const first = await claimFiles("t", "alice", ["src/a.ts"], 1000);
    expect(first.granted).toEqual(["src/a.ts"]);
    const again = await claimFiles("t", "alice", ["src/a.ts"], 2000);
    expect(again.granted).toEqual(["src/a.ts"]);
    const claims = await listClaims("t");
    expect(claims[0].since).toBe(1000);
  });
});

describe("releaseFiles", () => {
  it("only releases paths held by the agent", async () => {
    await claimFiles("t", "alice", ["src/a.ts"]);
    await claimFiles("t", "bob", ["src/b.ts"]);
    const released = await releaseFiles("t", "bob", ["src/a.ts", "src/b.ts"]);
    expect(released).toEqual(["src/b.ts"]); // bob cannot release alice's claim
    const remaining = await listClaims("t");
    expect(remaining.map((c) => c.path).sort()).toEqual(["src/a.ts"]);
  });
});

describe("releaseAllForAgent", () => {
  it("drops every claim for an agent", async () => {
    await claimFiles("t", "alice", ["src/a.ts", "src/b.ts"]);
    await claimFiles("t", "bob", ["src/c.ts"]);
    const released = await releaseAllForAgent("t", "alice");
    expect(released.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const remaining = await listClaims("t");
    expect(remaining.map((c) => c.path)).toEqual(["src/c.ts"]);
  });
});

describe("concurrent contention", () => {
  it("never grants the same path to two agents", async () => {
    const results = await Promise.all([
      claimFiles("t", "alice", ["shared.ts"]),
      claimFiles("t", "bob", ["shared.ts"]),
    ]);
    const granted = results.filter((r) => r.granted.includes("shared.ts"));
    expect(granted.length).toBe(1); // exactly one winner
    const claims = await listClaims("t");
    expect(claims.length).toBe(1);
  });
});
