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

interface ReportEventsCache {
  statKey: string;
  events: TeamReportEvent[];
  byId: Map<string, TeamReportEvent>;
  byAgent: Map<string, TeamReportEvent[]>;
}

const MAX_REPORT_EVENTS_CACHE_ENTRIES = 128;

const eventCache = new Map<string, ReportEventsCache>();

function rememberReportEventsCache(p: string, cache: ReportEventsCache): ReportEventsCache {
  if (eventCache.has(p)) eventCache.delete(p);
  eventCache.set(p, cache);

  while (eventCache.size > MAX_REPORT_EVENTS_CACHE_ENTRIES) {
    const oldestKey = eventCache.keys().next().value;
    if (oldestKey === undefined) break;
    eventCache.delete(oldestKey);
  }

  return cache;
}

function getFreshReportEventsCache(p: string, statKey: string): ReportEventsCache | undefined {
  const cached = eventCache.get(p);
  if (!cached) return undefined;

  if (cached.statKey !== statKey) {
    eventCache.delete(p);
    return undefined;
  }

  return rememberReportEventsCache(p, cached);
}

function ensureReportEventsFile(teamName: string): string {
  const p = path.join(paths.teamDir(teamName), "reports.json");
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return p;
}

function reportEventsStatKey(p: string): string {
  if (!fs.existsSync(p)) return "missing";
  const stat = fs.statSync(p, { bigint: true });
  return `${stat.size}:${stat.mtimeNs}`;
}

function compareCreatedAt(a: TeamReportEvent, b: TeamReportEvent): number {
  return a.createdAt - b.createdAt;
}

function cloneTeamReportEvent(event: TeamReportEvent): TeamReportEvent {
  const cloned = { ...event };
  if (event.metadata !== undefined) cloned.metadata = structuredClone(event.metadata);
  return cloned;
}

function cloneTeamReportEvents(events: readonly TeamReportEvent[]): TeamReportEvent[] {
  return events.map(cloneTeamReportEvent);
}

function buildCache(
  p: string,
  events: TeamReportEvent[],
  statKey: string,
  options: { sorted?: boolean } = {}
): ReportEventsCache {
  const sortedEvents = cloneTeamReportEvents(events);
  if (!options.sorted) sortedEvents.sort(compareCreatedAt);

  const byId = new Map<string, TeamReportEvent>();
  const byAgent = new Map<string, TeamReportEvent[]>();

  for (const event of sortedEvents) {
    if (!byId.has(event.id)) byId.set(event.id, event);

    const agentEvents = byAgent.get(event.agentName);
    if (agentEvents) agentEvents.push(event);
    else byAgent.set(event.agentName, [event]);
  }

  return rememberReportEventsCache(p, { statKey, events: sortedEvents, byId, byAgent });
}

function readEventsRaw(p: string): TeamReportEvent[] {
  if (!fs.existsSync(p)) return [];
  const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Array.isArray(parsed) ? parsed : [];
}

function readEventsCache(p: string): ReportEventsCache {
  const statKey = reportEventsStatKey(p);
  const cached = getFreshReportEventsCache(p, statKey);
  if (cached) return cached;

  const events = readEventsRaw(p);
  return buildCache(p, events, reportEventsStatKey(p));
}

function writeEventsRaw(p: string, events: TeamReportEvent[], options: { sorted?: boolean } = {}): void {
  fs.writeFileSync(p, JSON.stringify(events, null, 2));
  buildCache(p, events, reportEventsStatKey(p), options);
}

function defaultEventId(teamName: string, event: NewTeamReportEvent): string {
  if (event.operationId) {
    return ["report", teamName, event.agentName, event.operationId, event.workflowRunId || ""].join(":");
  }
  return crypto.randomUUID();
}

function lowerBoundCreatedAt(events: TeamReportEvent[], since: number): number {
  let low = 0;
  let high = events.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (events[mid].createdAt < since) low = mid + 1;
    else high = mid;
  }

  return low;
}

function upperBoundCreatedAt(events: TeamReportEvent[], createdAt: number): number {
  let low = 0;
  let high = events.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (events[mid].createdAt <= createdAt) low = mid + 1;
    else high = mid;
  }

  return low;
}

function applyLimit(events: TeamReportEvent[], limit?: number): TeamReportEvent[] {
  if (limit !== undefined && limit >= 0) return events.slice(Math.max(0, events.length - limit));
  return events.slice();
}

function selectEvents(cache: ReportEventsCache, options: ListTeamReportEventsOptions): TeamReportEvent[] {
  if (options.since !== undefined && Number.isNaN(options.since)) return [];

  const source = options.agentName ? cache.byAgent.get(options.agentName) || [] : cache.events;
  const start = options.since === undefined ? 0 : lowerBoundCreatedAt(source, options.since);
  const filtered = start === 0 ? source : source.slice(start);
  return cloneTeamReportEvents(applyLimit(filtered, options.limit));
}

function insertEvent(events: TeamReportEvent[], event: TeamReportEvent): TeamReportEvent[] {
  const next = events.slice();
  next.splice(upperBoundCreatedAt(next, event.createdAt), 0, event);
  return next;
}

export async function appendTeamReportEvent(teamName: string, event: NewTeamReportEvent): Promise<TeamReportEvent> {
  const p = ensureReportEventsFile(teamName);

  return await withLock(p, async () => {
    const cache = readEventsCache(p);
    const normalized: TeamReportEvent = cloneTeamReportEvent({
      ...event,
      id: event.id || defaultEventId(teamName, event),
      teamName,
      createdAt: event.createdAt || Date.now(),
    });

    const existing = cache.byId.get(normalized.id);
    if (existing) return cloneTeamReportEvent(existing);

    writeEventsRaw(p, insertEvent(cache.events, normalized), { sorted: true });
    return cloneTeamReportEvent(normalized);
  });
}

export async function listTeamReportEvents(
  teamName: string,
  options: ListTeamReportEventsOptions = {}
): Promise<TeamReportEvent[]> {
  const p = ensureReportEventsFile(teamName);

  return await withLock(p, async () => {
    return selectEvents(readEventsCache(p), options);
  });
}
