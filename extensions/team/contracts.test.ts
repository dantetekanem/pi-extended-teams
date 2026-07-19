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
    for (const documentPath of ["README.md", "TIPS.md", "skills/teams.md"]) {
      const document = fs.readFileSync(path.resolve(process.cwd(), documentPath), "utf-8");
      expect(document, documentPath).toContain("allow_nested_read_agents");
      expect(document, documentPath).toContain("write-feature");
      expect(document, documentPath).toContain("write-critical");
      expect(document, documentPath).toContain("write-patch");
      expect(document, documentPath).toContain("write-system");
      expect(document, documentPath).toContain("depth-1");
      expect(document, documentPath).toMatch(/children[^.]*cannot delegate/i);
    }

    const readme = fs.readFileSync(path.resolve(process.cwd(), "README.md"), "utf-8");
    expect(readme).toContain("spawned with `allow_nested_read_agents: true`");
    expect(readme).toContain("any number of helpers at any canonical `read-*` tier");
  });

  it("requires context-rich missions for isolated agent sessions", () => {
    const skill = fs.readFileSync(path.resolve(process.cwd(), "skills/teams.md"), "utf-8");

    expect(skill).toContain("they do not inherit the lead or parent conversation");
    expect(skill).toContain("## Context handoff contract");
    expect(skill).toContain("make a context-selection pass");
    expect(skill).toContain("### Lazy session reference");
    expect(skill).toContain("session_context: \"lazy\"");
    expect(skill).toContain("Do not enable it by default or use it as an excuse for a weak mission");
    expect(skill).toContain("The child should not open it by default");
    expect(skill).toContain("excludes thinking, images, raw tool arguments, and raw tool-result bodies");
    expect(skill).toContain("**Augment/reuse (default):**");
    expect(skill).toContain("**Corroborate:**");
    expect(skill).toContain("**Blind re-derive (exception):**");
    for (const field of [
      "**Question:**",
      "**Expected delta:**",
      "**Known:**",
      "**Inspected:**",
      "**Do not rediscover:**",
      "**Dependencies consumed:**",
    ]) {
      expect(skill).toContain(field);
    }
    for (const label of ["`[verified]`", "`[reported]`", "`[hypothesis]`", "`[open]`", "`[conflict]`", "`[decision]`"]) {
      expect(skill).toContain(label);
    }
    expect(skill).toContain("an **Evidence delta**");
    expect(skill).toContain("what the next lane must not repeat plus its next bounded question");
    expect(skill).toContain("Give each child the same Context handoff contract");

    const exampleSlice = (name: string, endMarker: string) => {
      const start = skill.indexOf(`name: "${name}"`);
      const end = skill.indexOf(endMarker, start);
      expect(start, `${name} example start`).toBeGreaterThan(-1);
      expect(end, `${name} example end`).toBeGreaterThan(start);
      return skill.slice(start, end);
    };
    const writerExamples = [
      exampleSlice("docs-fix", "For a bounded feature or critical writer"),
      exampleSlice("parser-feature", "## Hot-word trigger"),
    ];
    for (const example of writerExamples) {
      expect(example).toContain("Mode: EDIT-ALLOWED");
      for (const field of ["Question:", "Expected delta:", "Known:", "Inspected:", "Do not rediscover:", "Dependencies consumed:"]) {
        expect(example).toContain(field);
      }
    }
    expect(writerExamples[1]).toContain("same Context handoff contract");

    const knownExampleLines = skill.split("\n").filter((line) => line.startsWith("Known:"));
    expect(knownExampleLines.length).toBeGreaterThanOrEqual(5);
    for (const line of knownExampleLines) {
      const claims = line.match(/\[(?:verified|reported|decision)\]/g) ?? [];
      const sources = line.match(/source:/g) ?? [];
      expect(claims.length, line).toBeGreaterThan(0);
      expect(sources.length, line).toBe(claims.length);
    }
    expect(skill).toMatch(/Prior result: \[verified\] source:/);
    expect(skill).toContain("replace illustrative placeholders with real evidence before using the `docs-fix` template");
  });
});
