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
      expect.objectContaining({ id: "ui.agent-follow-navigation" }),
      expect.objectContaining({ id: "helpers.requested-by-writer" }),
      expect.objectContaining({ id: "writers.request-only-lead-spawns" }),
      expect.objectContaining({ id: "messaging.push-on-completion" }),
      expect.objectContaining({ id: "completion.remove-from-active-keep-history" }),
      expect.objectContaining({ id: "runtime.reload-disposes-background-handles" }),
      expect.objectContaining({ id: "writers.tmux-closes-when-done" }),
    ]));

    const byId = Object.fromEntries(contract.contracts.map((entry: any) => [entry.id, entry.description]));
    expect(byId["ui.team-activity-card"]).not.toContain("writers are tmux agents and are not mirrored");
    expect(byId["ui.team-activity-card"]).not.toContain("lead inbox reports");
    expect(byId["ui.team-activity-card"]).toContain("reports arrive as messages");
    expect(byId["ui.team-activity-card"]).toContain("stable below-editor pi-emote-style card");
    expect(byId["ui.team-activity-card"]).toContain("updates progress, elapsed time, and token counts in place without flicker");
    expect(byId["ui.team-activity-card"]).toContain("revealing the new phrase left-to-right");
    expect(byId["ui.team-activity-card"]).toContain("Each active writer row shows +N");
    expect(byId["ui.team-activity-card"]).toContain("without changing global active/read/write counts");
    expect(byId["ui.active-reader-writer-info"]).toContain("team activity card");
    expect(byId["ui.active-reader-writer-info"]).toContain("Active reader and writer information");
    expect(byId["ui.agent-follow-navigation"]).toContain("full-window interactive live-follow view");
    expect(byId["ui.agent-follow-navigation"]).toContain("Up moves to the previous agent");
    expect(byId["ui.agent-follow-navigation"]).toContain("pairs tool calls with their results in readable blocks");
    expect(byId["ui.agent-follow-navigation"]).toContain("provides an input for direct messages");
    expect(byId["ui.agent-follow-navigation"]).toContain("Pressing x stops the selected subagent");
    expect(byId["writers.request-only-lead-spawns"]).toContain("explicitly opted-in depth-0 write-feature/write-critical");
    expect(byId["writers.request-only-lead-spawns"]).toContain("any canonical read tier and any count subject to global capacity");
    expect(byId["writers.request-only-lead-spawns"]).toContain("Read agents, depth-1 children, write-patch, and write-system remain denied");
    expect(byId["writers.request-only-lead-spawns"]).toContain("requesting writer and cannot delegate");
    expect(byId["messaging.push-on-completion"]).toContain("classified completion notice to the lead");
    expect(byId["runtime.reload-disposes-background-handles"]).toContain("title/initial-trigger timers");
    expect(byId["runtime.reload-disposes-background-handles"]).toContain("active in-process agent sessions/heartbeats");
  });

  it("documents the public nested read opt-in and denial boundary consistently", () => {
    for (const documentPath of ["README.md", "TIPS.md", "docs/reference.md", "docs/guide.md", "skills/teams.md"]) {
      const document = fs.readFileSync(path.resolve(process.cwd(), documentPath), "utf-8");
      expect(document, documentPath).toContain("allow_nested_read_agents");
      expect(document, documentPath).toContain("write-feature");
      expect(document, documentPath).toContain("write-critical");
      expect(document, documentPath).toContain("write-patch");
      expect(document, documentPath).toContain("write-system");
      expect(document, documentPath).toContain("depth-1");
      expect(document, documentPath).toMatch(/children[^.]*cannot delegate/i);
    }

    const reference = fs.readFileSync(path.resolve(process.cwd(), "docs/reference.md"), "utf-8");
    expect(reference).toContain("`allow_nested_read_agents` (optional, default `false`)");
    expect(reference).toContain("any canonical `read-*` tier and any helper count");
  });
});
