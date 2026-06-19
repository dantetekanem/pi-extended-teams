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
      expect.objectContaining({ id: "ui.team-activity-card" }),
      expect.objectContaining({ id: "ui.active-reader-writer-info" }),
      expect.objectContaining({ id: "helpers.requested-by-writer" }),
      expect.objectContaining({ id: "writers.request-only-lead-spawns" }),
      expect.objectContaining({ id: "messaging.push-on-completion" }),
      expect.objectContaining({ id: "completion.remove-from-active-keep-history" }),
      expect.objectContaining({ id: "team-command.no-team-safe" }),
      expect.objectContaining({ id: "writers.tmux-closes-when-done" }),
    ]));

    const byId = Object.fromEntries(contract.contracts.map((entry: any) => [entry.id, entry.description]));
    expect(byId["ui.team-activity-card"]).not.toContain("writers are tmux agents and are not mirrored");
    expect(byId["ui.team-activity-card"]).not.toContain("lead inbox reports");
    expect(byId["ui.team-activity-card"]).toContain("reports arrive as messages");
    expect(byId["ui.team-activity-card"]).toContain("above-editor pi-emote-style card");
    expect(byId["ui.active-reader-writer-info"]).toContain("team activity card");
    expect(byId["ui.active-reader-writer-info"]).toContain("readers and writers");
  });
});
