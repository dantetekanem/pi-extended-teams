import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendTeamReportEvent, listTeamReportEvents } from "./report-events";
import * as paths from "./paths";
import type { TeamReportEvent } from "./models";

let root: string;

function reportsPath(teamName = "team"): string {
  return path.join(root, "teams", paths.sanitizeName(teamName), "reports.json");
}

function event(overrides: Partial<TeamReportEvent>): TeamReportEvent {
  return {
    id: overrides.id || `event-${overrides.createdAt}`,
    teamName: overrides.teamName || "team",
    agentName: overrides.agentName || "reader",
    status: overrides.status || "completed",
    report: overrides.report || "done",
    createdAt: overrides.createdAt || Date.now(),
    source: overrides.source || "read-agent",
    ...overrides,
  };
}

describe("report events", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-reports-"));
    vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName))));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("filters before applying latest-limit pagination", async () => {
    await appendTeamReportEvent("team", event({ id: "a-100", agentName: "agent-a", createdAt: 100, summary: "a100" }));
    await appendTeamReportEvent("team", event({ id: "b-200", agentName: "agent-b", createdAt: 200, summary: "b200" }));
    await appendTeamReportEvent("team", event({ id: "a-300", agentName: "agent-a", createdAt: 300, summary: "a300" }));
    await appendTeamReportEvent("team", event({ id: "b-400", agentName: "agent-b", createdAt: 400, summary: "b400" }));
    await appendTeamReportEvent("team", event({ id: "a-500", agentName: "agent-a", createdAt: 500, summary: "a500" }));

    const agentReports = await listTeamReportEvents("team", { agentName: "agent-a", limit: 2 });
    expect(agentReports.map(report => report.summary)).toEqual(["a300", "a500"]);

    const sinceReports = await listTeamReportEvents("team", { since: 250, limit: 2 });
    expect(sinceReports.map(report => report.summary)).toEqual(["b400", "a500"]);

    await expect(listTeamReportEvents("team", { limit: 0 })).resolves.toEqual([]);
  });

  it("sorts externally-written files before slicing latest events", async () => {
    const p = reportsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify([
      event({ id: "300", createdAt: 300, summary: "third" }),
      event({ id: "100", createdAt: 100, summary: "first" }),
      event({ id: "200", createdAt: 200, summary: "second" }),
    ]));

    const reports = await listTeamReportEvents("team", { limit: 2 });

    expect(reports.map(report => report.summary)).toEqual(["second", "third"]);
  });

  it("reuses the in-process index until the report file changes", async () => {
    await appendTeamReportEvent("team", event({ id: "one", createdAt: 100, summary: "one" }));

    const readSpy = vi.spyOn(fs, "readFileSync");
    const first = await listTeamReportEvents("team");
    const second = await listTeamReportEvents("team");

    expect(first.map(report => report.id)).toEqual(["one"]);
    expect(second.map(report => report.id)).toEqual(["one"]);
    expect(readSpy.mock.calls.filter(call => String(call[0]).endsWith("reports.json"))).toHaveLength(0);

    const p = reportsPath();
    fs.writeFileSync(p, JSON.stringify([
      ...first,
      event({ id: "two", createdAt: 200, summary: "two" }),
    ]));

    const afterExternalWrite = await listTeamReportEvents("team");
    expect(afterExternalWrite.map(report => report.id)).toEqual(["one", "two"]);
    expect(readSpy.mock.calls.filter(call => String(call[0]).endsWith("reports.json"))).toHaveLength(1);
  });

  it("isolates cached report objects from caller mutation", async () => {
    const appended = await appendTeamReportEvent("team", event({
      id: "immutable",
      createdAt: 100,
      summary: "original",
      metadata: { nested: { value: "original" } },
    }));

    appended.summary = "mutated append result";
    appended.metadata!.nested.value = "mutated append result";

    const firstList = await listTeamReportEvents("team");
    expect(firstList[0].summary).toBe("original");
    expect(firstList[0].metadata).toEqual({ nested: { value: "original" } });

    firstList[0].summary = "mutated list result";
    firstList[0].metadata!.nested.value = "mutated list result";

    const secondList = await listTeamReportEvents("team");
    expect(secondList[0].summary).toBe("original");
    expect(secondList[0].metadata).toEqual({ nested: { value: "original" } });
  });

  it("does not resort when inserting into an already sorted cache", async () => {
    await appendTeamReportEvent("team", event({ id: "one", createdAt: 100, summary: "one" }));

    const sortSpy = vi.spyOn(Array.prototype, "sort");
    await appendTeamReportEvent("team", event({ id: "two", createdAt: 200, summary: "two" }));

    expect(sortSpy).not.toHaveBeenCalled();
    sortSpy.mockRestore();
    await expect(listTeamReportEvents("team")).resolves.toMatchObject([{ id: "one" }, { id: "two" }]);
  });

  it("returns the original event for duplicate ids", async () => {
    const first = await appendTeamReportEvent("team", event({ id: "same", createdAt: 100, summary: "first" }));
    const second = await appendTeamReportEvent("team", event({ id: "same", createdAt: 200, summary: "second" }));

    expect(second).toEqual(first);
    await expect(listTeamReportEvents("team")).resolves.toMatchObject([{ id: "same", summary: "first" }]);
  });
});
