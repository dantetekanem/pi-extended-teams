import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const contractPath = path.resolve(process.cwd(), "extensions/team/team-contracts.json");

describe("persisted team behavior contracts", () => {
  it("saves Leo's required team lifecycle/UI contracts locally", () => {
    expect(fs.existsSync(contractPath)).toBe(true);
    const contract = JSON.parse(fs.readFileSync(contractPath, "utf-8"));

    expect(contract.version).toBe(1);
    expect(contract.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ui.old-bottom-status-kept" }),
      expect.objectContaining({ id: "ui.active-reader-writer-info" }),
      expect.objectContaining({ id: "helpers.requested-by-writer" }),
      expect.objectContaining({ id: "writers.request-only-lead-spawns" }),
      expect.objectContaining({ id: "messaging.push-on-completion" }),
      expect.objectContaining({ id: "completion.remove-from-active-keep-history" }),
      expect.objectContaining({ id: "team-command.no-team-safe" }),
      expect.objectContaining({ id: "writers.tmux-closes-when-done" }),
    ]));

    const byId = Object.fromEntries(contract.contracts.map((entry: any) => [entry.id, entry.description]));
    expect(byId["ui.old-bottom-status-kept"]).not.toContain("writers are tmux agents and are not mirrored");
    expect(byId["ui.old-bottom-status-kept"]).not.toContain("lead inbox reports");
    expect(byId["ui.old-bottom-status-kept"]).toContain("reports arrive as messages");
    expect(byId["ui.active-reader-writer-info"]).toContain("below-main status");
    expect(byId["ui.active-reader-writer-info"]).toContain("readers and writers");
  });
});
