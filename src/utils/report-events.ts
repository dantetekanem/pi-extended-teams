import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { TeamReportEvent } from "./models";
import * as paths from "./paths";
import { withLock } from "./lock";

export type NewTeamReportEvent = Omit<TeamReportEvent, "id" | "teamName" | "createdAt"> & Partial<Pick<TeamReportEvent, "id" | "teamName" | "createdAt">>;

export interface ListTeamReportEventsOptions {
  since?: number;
  agentName?: string;
  limit?: number;
}

function ensureReportEventsFile(teamName: string): string {
  const p = path.join(paths.teamDir(teamName), "reports.json");
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return p;
}

function readEventsRaw(p: string): TeamReportEvent[] {
  if (!fs.existsSync(p)) return [];
  const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Array.isArray(parsed) ? parsed : [];
}

function writeEventsRaw(p: string, events: TeamReportEvent[]): void {
  fs.writeFileSync(p, JSON.stringify(events, null, 2));
}

function defaultEventId(teamName: string, event: NewTeamReportEvent): string {
  if (event.operationId) {
    return ["report", teamName, event.agentName, event.operationId, event.workflowRunId || ""].join(":");
  }
  return crypto.randomUUID();
}

export async function appendTeamReportEvent(teamName: string, event: NewTeamReportEvent): Promise<TeamReportEvent> {
  const p = ensureReportEventsFile(teamName);

  return await withLock(p, async () => {
    const events = readEventsRaw(p);
    const normalized: TeamReportEvent = {
      ...event,
      id: event.id || defaultEventId(teamName, event),
      teamName,
      createdAt: event.createdAt || Date.now(),
    };

    const existing = events.find((item) => item.id === normalized.id);
    if (existing) return existing;

    events.push(normalized);
    events.sort((a, b) => a.createdAt - b.createdAt);
    writeEventsRaw(p, events);
    return normalized;
  });
}

export async function listTeamReportEvents(
  teamName: string,
  options: ListTeamReportEventsOptions = {}
): Promise<TeamReportEvent[]> {
  const p = ensureReportEventsFile(teamName);

  return await withLock(p, async () => {
    let events = readEventsRaw(p);
    if (options.since !== undefined) events = events.filter((event) => event.createdAt >= options.since!);
    if (options.agentName) events = events.filter((event) => event.agentName === options.agentName);
    events = events.sort((a, b) => a.createdAt - b.createdAt);
    if (options.limit !== undefined && options.limit >= 0) events = events.slice(Math.max(0, events.length - options.limit));
    return events;
  });
}
