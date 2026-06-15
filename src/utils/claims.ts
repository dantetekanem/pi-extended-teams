/**
 * File write-claim registry.
 *
 * Coordinates write intent across agents. Claims are advisory protocol state,
 * not OS-level or tool-level sandbox enforcement. Cooperative write agents must
 * claim before editing; the registry prevents two granted claims for the same
 * path. Claims are held in a single lock-guarded `claims.json` per team so multi-file claims are
 * atomic and all-or-nothing: if any requested path is held by another agent,
 * none are granted.
 */

import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock";
import { claimsPath } from "./paths";

export interface FileClaim {
  agent: string;
  path: string;
  since: number;
}

/** Map of normalized file path -> claim. */
type ClaimMap = Record<string, FileClaim>;

export interface ClaimResult {
  granted: string[];
  conflicts: Array<{ path: string; heldBy: string }>;
}

/**
 * Normalize a repository-relative path so "./a", "a", and "a/" map to the
 * same claim key. Blank, absolute, and parent-traversal paths are rejected so a
 * bad claim cannot accidentally reserve the repository root or escape it.
 */
export function normalizeClaimPath(p: string): string {
  const raw = p.trim().replace(/\\/g, "/");
  if (!raw) {
    throw new Error("File claim path must not be empty.");
  }
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`File claim path must be repository-relative: ${p}`);
  }

  const normalized = path.posix.normalize(raw).replace(/\/+$/, "");
  if (!normalized || normalized === ".") {
    throw new Error("File claim path must not refer to the repository root.");
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(`File claim path must not traverse outside the repository: ${p}`);
  }

  return normalized;
}

function readClaims(p: string): ClaimMap {
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as ClaimMap) : {};
  } catch {
    return {};
  }
}

function writeClaims(p: string, claims: ClaimMap): void {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(claims, null, 2));
}

/**
 * Attempt to claim a set of paths for an agent.
 *
 * All-or-nothing: if any path is held by a *different* agent, nothing is
 * granted and the conflicts are returned. Re-claiming a path the agent already
 * holds is idempotent (refreshes `since`).
 */
export async function claimFiles(
  teamName: string,
  agent: string,
  paths: string[],
  now: number = Date.now()
): Promise<ClaimResult> {
  const p = claimsPath(teamName);
  const normalized = Array.from(new Set(paths.map(normalizeClaimPath).filter(Boolean)));

  return await withLock(p, async () => {
    const claims = readClaims(p);
    const conflicts: ClaimResult["conflicts"] = [];

    for (const target of normalized) {
      const existing = claims[target];
      if (existing && existing.agent !== agent) {
        conflicts.push({ path: target, heldBy: existing.agent });
      }
    }

    if (conflicts.length > 0) {
      return { granted: [], conflicts };
    }

    for (const target of normalized) {
      claims[target] = { agent, path: target, since: claims[target]?.since ?? now };
    }
    writeClaims(p, claims);

    return { granted: normalized, conflicts: [] };
  });
}

/**
 * Release specific paths, but only those held by this agent.
 */
export async function releaseFiles(
  teamName: string,
  agent: string,
  paths: string[]
): Promise<string[]> {
  const p = claimsPath(teamName);
  const normalized = new Set(paths.map(normalizeClaimPath).filter(Boolean));

  return await withLock(p, async () => {
    const claims = readClaims(p);
    const released: string[] = [];

    for (const target of normalized) {
      if (claims[target]?.agent === agent) {
        delete claims[target];
        released.push(target);
      }
    }

    if (released.length > 0) writeClaims(p, claims);
    return released;
  });
}

/**
 * Release every claim held by an agent. Called on orderly exit and on
 * watchdog-confirmed death.
 */
export async function releaseAllForAgent(teamName: string, agent: string): Promise<string[]> {
  const p = claimsPath(teamName);

  return await withLock(p, async () => {
    const claims = readClaims(p);
    const released: string[] = [];

    for (const [target, claim] of Object.entries(claims)) {
      if (claim.agent === agent) {
        delete claims[target];
        released.push(target);
      }
    }

    if (released.length > 0) writeClaims(p, claims);
    return released;
  });
}

/**
 * List all current claims.
 */
export async function listClaims(teamName: string): Promise<FileClaim[]> {
  const p = claimsPath(teamName);
  return await withLock(p, async () => {
    return Object.values(readClaims(p));
  });
}
