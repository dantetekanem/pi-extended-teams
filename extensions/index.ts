import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as paths from "../src/utils/paths";
import * as teams from "../src/utils/teams";
import * as tasks from "../src/utils/tasks";
import * as messaging from "../src/utils/messaging";
import * as runtime from "../src/utils/runtime";
import * as claims from "../src/utils/claims";
import * as writeQueue from "../src/utils/write-queue";
import * as sharedMemory from "../src/utils/shared-memory";
import { Member } from "../src/utils/models";
import { getTerminalAdapter } from "../src/adapters/terminal-registry";
import * as predefined from "../src/utils/predefined-teams";
import { loadSettings, resolveAllowedExtensions, resolveModel, resolveRole, type AgentRole } from "../src/utils/settings";
import {
  isKnownQualifiedModel,
  listPreferredQualifiedModels,
  loadModelResolutionConfig,
  loadPiModelSettings,
  normalizeQualifiedModel,
  sortAvailableModels,
} from "../src/utils/model-resolution";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

/**
 * Creates a Google-compatible string enum schema using this package's TypeBox
 * instance. The upstream `@mariozechner/pi-ai` helper can resolve to a
 * different TypeBox instance in this package, which makes `Type.Optional()`
 * reject its `TUnsafe` type at compile time.
 */
function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] }
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}

/**
 * Build the command used to relaunch pi for teammate processes.
 *
 * There are three common cases:
 * - npm/node install: pi runs as `node .../dist/cli.js`
 * - standalone compiled binary: process.execPath is the actual `pi` executable
 * - shim-based installs (e.g. Volta): process.execPath is `node` and argv[1]
 *   may be a shim path, so the safest relaunch command is plain `pi`
 */
function getPiLaunchCommand(): string {
  const argv1 = process.argv[1];
  const execPath = process.execPath;

  // Regular Node install: relaunch the actual CLI script with node.
  if (argv1) {
    const ext = path.extname(argv1).toLowerCase();
    const looksLikeScript = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(ext)
      || /(?:^|[/\\])dist[/\\]cli\.js$/i.test(argv1);

    if (looksLikeScript) {
      return `node ${JSON.stringify(argv1)}`;
    }
  }

  // Standalone binary install: execPath is the pi executable itself.
  if (execPath) {
    const base = path.basename(execPath).toLowerCase();
    if (base !== "node" && base !== "node.exe" && base !== "bun" && base !== "bun.exe") {
      return JSON.stringify(execPath);
    }
  }

  // Shim-based installs (like Volta) are safest to relaunch through PATH.
  return "pi";
}

async function getAvailableModels(ctx: any): Promise<Array<{ provider: string; model: string }>> {
  try {
    const available = await ctx.modelRegistry.getAvailable();
    return available.map((model: any) => ({
      provider: model.provider,
      model: model.id,
    }));
  } catch {
    return [];
  }
}

async function getModelSelectionState(ctx: any, projectDir: string, preferredModels: string[] = []) {
  const availableModels = await getAvailableModels(ctx);
  const piSettings = loadPiModelSettings({ projectDir });
  const config = loadModelResolutionConfig({ projectDir });
  const preferredQualifiedModels = listPreferredQualifiedModels(availableModels, {
    projectDir,
    preferredModels,
  });
  const sortedModels = sortAvailableModels(availableModels, {
    preferredModels: preferredQualifiedModels,
    providerPriority: config.providerPriority,
  });

  return {
    availableModels,
    piSettings,
    providerPriority: config.providerPriority,
    preferredQualifiedModels,
    sortedModels,
  };
}

function getCurrentQualifiedModel(ctx: any): string | undefined {
  if (!ctx.model?.provider || !ctx.model?.id) {
    return undefined;
  }
  return `${ctx.model.provider}/${ctx.model.id}`;
}

function requireQualifiedKnownModel(
  model: string | undefined,
  availableModels: Array<{ provider: string; model: string }>,
  fieldName: string
): string | undefined {
  if (!model) {
    return undefined;
  }

  const normalized = normalizeQualifiedModel(model);
  if (!normalized) {
    throw new Error(
      `${fieldName} must be a fully qualified provider/model string. ` +
      `Use list_available_models to choose a valid model.`
    );
  }

  if (!isKnownQualifiedModel(normalized, availableModels)) {
    throw new Error(
      `${fieldName} \"${normalized}\" is not available. ` +
      `Use list_available_models to choose a valid model.`
    );
  }

  return normalized;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getPiExtendedTeamsExtensionSource(): string {
  return process.env.PI_EXTENDED_TEAMS_EXTENSION_SOURCE || process.env.PI_TEAMS_EXTENSION_SOURCE || __filename;
}

function buildExtensionArgs(allowedExtensions: string[] = []): string {
  const parts = ["--no-extensions", "--extension", shellQuote(getPiExtendedTeamsExtensionSource())];
  for (const source of allowedExtensions) {
    parts.push("--extension", shellQuote(source));
  }
  return parts.join(" ");
}

function buildPiCommand(
  piBinary: string,
  chosenModel?: string,
  thinking?: string,
  allowedExtensions: string[] = []
): string {
  const extensionArgs = buildExtensionArgs(allowedExtensions);

  if (chosenModel) {
    const modelArg = thinking ? `${chosenModel}:${thinking}` : chosenModel;
    return `${piBinary} ${extensionArgs} --model ${shellQuote(modelArg)}`;
  }

  if (thinking) {
    return `${piBinary} ${extensionArgs} --thinking ${shellQuote(thinking)}`;
  }

  return `${piBinary} ${extensionArgs}`;
}

interface RunningReadAgent {
  runId: string;
  name: string;
  teamName: string;
  startedAt: number;
  tokensUsed: number;
  status: "starting" | "running" | "finishing";
  recentEvents: string[];
  model?: string;
  thinking?: string;
  session?: AgentSession;
  stopRequested?: boolean;
}

interface CompletedAgentReport {
  name: string;
  role: string;
  status: "completed" | "failed";
  report: string;
  summary?: string;
  completedAt: number;
  startedAt?: number;
  elapsedMs?: number;
  tokensUsed?: number;
  model?: string;
  thinking?: string;
  color?: string;
  source: "read-agent" | "lead-inbox";
}

// Compact "provider/model · thinking" label for status/panel display.
function formatModelLabel(model?: string, thinking?: string): string {
  const shortModel = model ? model.split("/").pop() || model : "";
  const t = thinking && thinking !== "off" ? ` · ${thinking}` : "";
  return shortModel ? `${shortModel}${t}` : "";
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function formatTokenCount(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1000000) return `${(count / 1000).toFixed(count < 10000 ? 1 : 0)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function pushReadAgentEvent(agent: RunningReadAgent, text: string): void {
  agent.recentEvents.push(`${new Date().toLocaleTimeString()} ${text}`);
  agent.recentEvents = agent.recentEvents.slice(-12);
}

function extractTextParts(content: any): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}

function getLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    const text = extractTextParts(messages[i].content);
    if (text) return text;
  }
  return "";
}

// Flatten a read agent's in-process session into compact transcript lines for
// the /team viewer: user prompts, assistant text, terse tool calls/results.
// Thinking blocks are omitted to keep the pane quiet.
function formatTranscriptLines(messages: any[]): string[] {
  const out: string[] = [];
  for (const message of messages || []) {
    if (message?.role === "user") {
      const text = extractTextParts(message.content);
      if (text) out.push(`${pink("user ▸")} ${text}`);
    } else if (message?.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "text" && part.text?.trim()) out.push(part.text.trim());
        else if (part?.type === "toolCall") out.push(purple(`⚙ ${part.name}`));
      }
    } else if (message?.role === "toolResult") {
      const text = extractTextParts(message.content);
      const head = text.split("\n").find((line: string) => line.trim()) || "(no output)";
      out.push(dimAnsi(`  ↳ ${message.toolName || "tool"}: ${head}`));
    }
  }
  return out;
}

function summarizeInboxMessage(message: any): string {
  const from = message?.from || "unknown";
  const summary = message?.summary || "message";
  const timestamp = message?.timestamp ? new Date(message.timestamp).toLocaleTimeString() : "";
  return `${from}${timestamp ? ` ${timestamp}` : ""}: ${summary}`;
}

function formatInboxMessagesForModel(messages: any[]): string {
  if (messages.length === 0) return "No inbox messages.";

  return messages.map((message, index) => {
    const header = `[${index + 1}] ${summarizeInboxMessage(message)}`;
    const text = String(message?.text || "").trim() || "(empty message)";
    return `${header}\n${text}`;
  }).join("\n\n");
}

function renderInboxMessages(result: any, expanded: boolean, theme: any) {
  const messages = result.details?.messages || [];
  if (messages.length === 0) {
    return new Text(theme.fg("muted", "inbox: no messages"), 0, 0);
  }

  const lines = [theme.fg("toolTitle", theme.bold(`inbox: ${messages.length} message${messages.length === 1 ? "" : "s"}`))];
  if (expanded) {
    for (const [index, message] of messages.entries()) {
      lines.push(theme.fg("muted", `\n${index + 1}. ${summarizeInboxMessage(message)}`));
      lines.push(String(message?.text || "").trim() || theme.fg("dim", "(empty message)"));
    }
  } else {
    for (const [index, message] of messages.slice(0, 5).entries()) {
      lines.push(truncateToWidth(`${index + 1}. ${summarizeInboxMessage(message)}`, 120));
    }
    if (messages.length > 5) lines.push(theme.fg("dim", `… ${messages.length - 5} more`));
    lines.push(theme.fg("dim", "expand tool output to read full message text"));
  }

  return new Text(lines.join("\n"), 0, 0);
}

function formatTeammateStatusForModel(agentName: string, details: any): string {
  const heartbeat = details.hasRecentHeartbeat ? "fresh heartbeat" : "stale/no heartbeat";
  const ready = details.agentLoopReady ? "ready" : "not ready";
  const unread = `${details.unreadCount ?? 0} unread`;
  const released = details.releasedClaims?.length ? `; released claims: ${details.releasedClaims.join(", ")}` : "";
  return `${agentName}: ${details.health}; ${unread}; ${ready}; ${heartbeat}${released}`;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_PINK = "\x1b[38;5;213m";
const ANSI_PURPLE = "\x1b[38;5;141m";
const ANSI_DIM = "\x1b[2m";

function pink(text: string): string {
  return `${ANSI_PINK}${text}${ANSI_RESET}`;
}

function purple(text: string): string {
  return `${ANSI_PURPLE}${text}${ANSI_RESET}`;
}

function dimAnsi(text: string): string {
  return `${ANSI_DIM}${text}${ANSI_RESET}`;
}

const ANSI_PANEL_BG = "\x1b[48;5;235m";

// Fill a line to `width` visible columns with the dark panel background. Every
// full reset emitted by pink/purple/dimAnsi/theme.fg is followed by a fresh
// background code so embedded foreground colors don't punch holes in the fill.
export function panelBgFill(line: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(line));
  const reasserted = line.split(ANSI_RESET).join(ANSI_RESET + ANSI_PANEL_BG);
  return `${ANSI_PANEL_BG}${reasserted}${" ".repeat(pad)}${ANSI_RESET}`;
}

// Wrap content lines in a rounded border with a dark interior. `innerWidth` is
// the column count between the one-space padding inside each side border.
export function framePanel(contentLines: string[], innerWidth: number): string[] {
  const span = innerWidth + 2;
  const rule = "─".repeat(span);
  const border = (text: string) => `${ANSI_PANEL_BG}${ANSI_PURPLE}${text}${ANSI_RESET}`;
  const out: string[] = [border(`╭${rule}╮`)];
  for (const line of contentLines) {
    const boundedLine = truncateToWidth(line, innerWidth, "…", true);
    out.push(border("│") + panelBgFill(` ${boundedLine} `, span) + border("│"));
  }
  out.push(border(`╰${rule}╯`));
  return out;
}

// Self-sizing frame for compact panels so each reads as a distinct dark card.
export function frameWidget(contentLines: string[]): string[] {
  const innerWidth = contentLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  return framePanel(contentLines, innerWidth);
}

// Full-width frame for belowEditor status widgets. The returned lines consume
// the whole render width so the bottom bar has no left/right gutters.
export function frameWidgetFullWidth(contentLines: string[], width: number): string[] {
  if (width <= 0) return [];
  if (width < 4) {
    return contentLines.map((line) => panelBgFill(truncateToWidth(line, width, "", true), width));
  }
  return framePanel(contentLines, width - 4);
}

function bottomStatusWidget(contentLines: string[]) {
  return (_tui: any, _theme: any) => ({
    render(width: number): string[] {
      return frameWidgetFullWidth(contentLines, width);
    },
    invalidate() {},
  });
}

function isDownInput(data: string): boolean {
  return matchesKey(data, Key.down) || data === "\x1b[B" || data === "j" || data === "J" || data === "\x0e";
}

function isUpInput(data: string): boolean {
  return matchesKey(data, Key.up) || data === "\x1b[A" || data === "k" || data === "K" || data === "\x10";
}

function isLeftInput(data: string): boolean {
  return matchesKey(data, Key.left) || data === "\x1b[D" || data === "h" || data === "H";
}

function isRightInput(data: string): boolean {
  return matchesKey(data, Key.right) || data === "\x1b[C" || data === "l" || data === "L";
}

export function logWindowStart(totalRows: number, viewportRows: number, offsetFromBottom: number): number {
  const maxStart = Math.max(0, totalRows - viewportRows);
  return Math.max(0, maxStart - Math.max(0, Math.min(offsetFromBottom, maxStart)));
}

function renderTeammateStatus(result: any, expanded: boolean, theme: any) {
  const details = result.details || {};
  const agentName = details.agentName || "teammate";
  const health = details.health || (details.alive ? "alive" : "dead");
  const color = health === "dead" || health === "stalled" ? "warning" : "success";
  const headline = `${agentName}: ${health} • ${details.unreadCount ?? 0} unread • ${details.agentLoopReady ? "ready" : "not ready"}`;

  if (!expanded) {
    return new Text(theme.fg(color, headline), 0, 0);
  }

  const runtimeStatus = details.runtime || {};
  const lines = [theme.fg(color, theme.bold(headline))];
  lines.push(`alive: ${details.alive ? "yes" : "no"}`);
  lines.push(`heartbeat: ${details.hasRecentHeartbeat ? "fresh" : "stale/missing"}`);
  if (runtimeStatus.startedAt) lines.push(`started: ${new Date(runtimeStatus.startedAt).toLocaleString()}`);
  if (runtimeStatus.lastHeartbeatAt) lines.push(`last heartbeat: ${new Date(runtimeStatus.lastHeartbeatAt).toLocaleString()}`);
  if (details.startupStalled) lines.push(theme.fg("warning", "startup appears stalled"));
  if (details.releasedClaims?.length) lines.push(`released claims: ${details.releasedClaims.join(", ")}`);
  return new Text(lines.join("\n"), 0, 0);
}

function resolveSkillFile(skillName: string, cwd: string): string {
  const safeName = paths.sanitizeName(skillName);
  const candidates = [
    path.join(cwd, "skills", `${safeName}.md`),
    path.join(cwd, "skills", safeName, "SKILL.md"),
    path.join(getAgentDir(), "skills", safeName, "SKILL.md"),
    path.join(getAgentDir(), "skills", `${safeName}.md`),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Skill ${skillName} not found. Checked project and agent skill directories.`);
  }
  return found;
}

/**
 * Find the team this session is the lead for (if any).
 * Checks the lead-session.json file to match PID.
 */
function findLeadTeamForSession(): string | null {
  try {
    const teamsDir = paths.TEAMS_DIR;
    if (!fs.existsSync(teamsDir)) return null;

    for (const teamDir of fs.readdirSync(teamsDir)) {
      const sessionFile = paths.leadSessionPath(teamDir);
      if (fs.existsSync(sessionFile)) {
        try {
          const session = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
          if (session.pid === process.pid) {
            return teamDir;
          }
        } catch {
          // Ignore corrupted session files
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Register this session as the lead for a team.
 */
function registerLeadSession(teamName: string) {
  const sessionFile = paths.leadSessionPath(teamName);
  const dir = path.dirname(sessionFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
  }));
}

/**
 * Check if a process with the given PID is still alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check if process exists
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up a stale team if the lead process is dead.
 * Kills all teammate panes/windows and removes all state files.
 * Returns true if cleanup was performed, false otherwise.
 */
function cleanupStaleTeam(teamName: string, terminal: any): boolean {
  const sessionFile = paths.leadSessionPath(teamName);
  const configFile = paths.configPath(teamName);
  
  if (!fs.existsSync(sessionFile) || !fs.existsSync(configFile)) {
    return false;
  }
  
  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    
    // Only cleanup if the lead PID is actually dead
    if (session.pid && !isPidAlive(session.pid)) {
      // Read config to get member info for cleanup
      try {
        const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
        
        // Kill all teammate panes/windows
        for (const member of config.members || []) {
          if (member.name === "team-lead") continue;
          
          // Kill via PID file
          const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
          if (fs.existsSync(pidFile)) {
            try {
              const pid = fs.readFileSync(pidFile, "utf-8").trim();
              process.kill(parseInt(pid), "SIGKILL");
              fs.unlinkSync(pidFile);
            } catch {}
          }
          
          // Kill via terminal adapter
          if (terminal && member.tmuxPaneId) {
            try { terminal.kill(member.tmuxPaneId); } catch {}
          }
        }
      } catch {}
      
      // Delete entire team directory
      const teamDirectory = paths.teamDir(teamName);
      if (fs.existsSync(teamDirectory)) {
        fs.rmSync(teamDirectory, { recursive: true });
      }
      
      // Delete tasks directory
      const tasksDirectory = paths.taskDir(teamName);
      if (fs.existsSync(tasksDirectory)) {
        fs.rmSync(tasksDirectory, { recursive: true });
      }
      
      return true;
    }
  } catch {}
  
  return false;
}

/**
 * Clean up orphaned agent session folders from ~/.pi/agent/teams/
 * These are created by the pi core system when agents are spawned.
 * We remove folders that are older than 24 hours to avoid deleting active sessions.
 * Returns the number of folders cleaned up.
 */
function cleanupAgentSessionFolders(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const agentTeamsDir = path.join(os.homedir(), ".pi", "agent", "teams");
  if (!fs.existsSync(agentTeamsDir)) return 0;

  let cleaned = 0;
  const now = Date.now();

  for (const dir of fs.readdirSync(agentTeamsDir)) {
    const sessionDir = path.join(agentTeamsDir, dir);
    const configFile = path.join(sessionDir, "config.json");

    try {
      // Check if this is a directory with a config.json
      if (!fs.statSync(sessionDir).isDirectory()) continue;
      if (!fs.existsSync(configFile)) continue;

      // Read the config to check the creation time
      const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      const createdAt = config.createdAt ? new Date(config.createdAt).getTime() : 0;

      // If the folder is older than maxAgeMs, delete it
      if (createdAt > 0 && (now - createdAt) > maxAgeMs) {
        fs.rmSync(sessionDir, { recursive: true });
        cleaned++;
      }
    } catch {
      // Ignore errors for individual folders
    }
  }

  return cleaned;
}

export default function (pi: ExtensionAPI) {
  const isTeammate = !!process.env.PI_AGENT_NAME;
  const agentName = process.env.PI_AGENT_NAME || "team-lead";
  const envTeamName = process.env.PI_TEAM_NAME;

  // For leads without PI_TEAM_NAME, check if we're registered as lead for a team
  const detectedTeamName = envTeamName || findLeadTeamForSession();
  let teamName = detectedTeamName;

  const terminal = getTerminalAdapter();

  // Track whether lead inbox polling has been started (to avoid duplicates)
  let leadPollingStarted = false;
  let sessionCtx: any = null;
  const runningReadAgents = new Map<string, RunningReadAgent>();
  const completedAgentReports = new Map<string, CompletedAgentReport[]>();
  let readAgentStatusTimer: NodeJS.Timeout | null = null;
  let leadInboxUnreadCount = 0;
  // Highest unread count we've already nudged the lead about, so we wake once per
  // new batch of reports (not every poll) and re-wake when more arrive.
  let leadWakeNotifiedCount = 0;
  let writeQueueDraining = false;
  let leadWatchdogStarted = false;

  function readAgentKey(targetTeamName: string, targetAgentName: string): string {
    return `${targetTeamName}:${targetAgentName}`;
  }

  function isCurrentReadAgentRun(key: string, state: RunningReadAgent): boolean {
    return runningReadAgents.get(key) === state;
  }

  function rememberCompletedAgentReport(teamName: string, report: CompletedAgentReport): void {
    const current = completedAgentReports.get(teamName) ?? [];
    const dedupeKey = `${report.source}:${report.name}:${report.completedAt}:${report.summary || ""}`;
    const next = [
      ...current.filter((item) => `${item.source}:${item.name}:${item.completedAt}:${item.summary || ""}` !== dedupeKey),
      report,
    ].sort((a, b) => b.completedAt - a.completedAt).slice(0, 50);
    completedAgentReports.set(teamName, next);
  }

  // Quietly nudge this agent's loop without cluttering the transcript. A custom
  // message with display:false still reaches the model as a user turn (see
  // convertToLlm) but is never rendered, so team coordination stays silent.
  // Falls back to a visible user message on older pi builds without sendMessage.
  function quietTrigger(content: string): void {
    const api = pi as any;
    if (typeof api.sendMessage === "function") {
      api.sendMessage(
        { customType: "pi-extended-teams-wake", content, display: false },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    } else {
      pi.sendUserMessage(content);
    }
  }

  // Deliver a finished agent's report straight into the lead's main window: a
  // collapsed one-line entry (name · elapsed · tokens) that ctrl+o expands to the
  // full report. display:true also feeds the report into the lead's context as a
  // user turn (see convertToLlm), and triggerTurn makes the lead synthesize it
  // automatically — no read_inbox, no manual polling.
  function emitAgentReport(name: string, startedAt: number, tokens: number, report: string, ok: boolean): void {
    const api = pi as any;
    const details = { name, elapsedMs: Date.now() - startedAt, tokens, ok };
    if (typeof api.sendMessage === "function") {
      api.sendMessage(
        { customType: "pi-extended-teams-report", content: report, display: true, details },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    } else {
      pi.sendUserMessage(`Report from ${name}:\n${report}`);
    }
  }

  function wakeLeadForInboxReports(unread: any[]): void {
    if (!teamName) return;
    const count = unread.length;

    // Track reads/decreases so a fresh batch of reports re-triggers a wake.
    if (count <= leadWakeNotifiedCount) {
      leadWakeNotifiedCount = count;
      return;
    }
    // Reports grew but the lead is busy: leave the notified count untouched so the
    // next poll (when idle) or completion retries the wake instead of dropping it.
    if (!sessionCtx?.isIdle?.()) return;

    leadWakeNotifiedCount = count;
    const label = count === 1 ? "1 team report" : `${count} team reports`;
    const it = count === 1 ? "it" : "them";
    quietTrigger(
      `${label} ready in your inbox for ${teamName}. Read ${it} now with read_inbox, summarize the findings for the user, act on any blockers, and shut down finished teammates. If you are mid-task you may finish that first. Do not sleep or poll.`
    );
  }

  function renderReadAgentStatus() {
    if (!sessionCtx?.ui) return;

    const agents = Array.from(runningReadAgents.values());
    if (agents.length === 0) {
      sessionCtx.ui.setStatus?.("01-pi-extended-teams-read", undefined);
      sessionCtx.ui.setWidget?.("01-pi-extended-teams-readers", undefined);
      if (readAgentStatusTimer) {
        clearInterval(readAgentStatusTimer);
        readAgentStatusTimer = null;
      }
      return;
    }

    const lines = [pink(`▣ read agents running (${agents.length})  /team`)];
    for (const agent of agents.sort((a, b) => a.name.localeCompare(b.name))) {
      const elapsed = formatElapsed(Date.now() - agent.startedAt);
      const lastEvent = agent.recentEvents.at(-1)?.replace(/^\S+\s+/, "") || agent.status;
      const modelLabel = formatModelLabel(agent.model, agent.thinking);
      const detail = [modelLabel, elapsed, `${formatTokenCount(agent.tokensUsed)} tok`, lastEvent].filter(Boolean).join(" · ");
      lines.push(
        `${purple("  ├─")} ${pink(agent.name)} ${purple(agent.status)} ${dimAnsi(detail)}`
      );
    }
    lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
    sessionCtx.ui.setWidget?.("01-pi-extended-teams-readers", bottomStatusWidget(lines), { placement: "belowEditor" });
  }

  function ensureReadAgentStatusTicker() {
    if (readAgentStatusTimer) return;
    readAgentStatusTimer = setInterval(renderReadAgentStatus, 1000);
    renderReadAgentStatus();
  }

  async function renderLeadInboxStatus() {
    if (!sessionCtx?.ui) return;
    if (!teamName) {
      sessionCtx.ui.setWidget?.("02-pi-extended-teams-inbox", undefined);
      return;
    }

    // Authoritative: read actual unread, keep the count in sync, and clear the
    // widget when there is nothing pending so finished reports leave the bar.
    const unread = await messaging.readInbox(teamName, agentName, true, false).catch(() => []);
    leadInboxUnreadCount = unread.length;
    if (unread.length === 0) {
      sessionCtx.ui.setWidget?.("02-pi-extended-teams-inbox", undefined);
      return;
    }

    const lines = [pink(`▣ team reports ready (${unread.length})  read_inbox`)];
    for (const message of unread.slice(-5)) {
      const from = String(message.from || "unknown");
      const summary = String(message.summary || "message");
      lines.push(`${purple("  ├─")} ${pink(from)} ${dimAnsi(summary)}`);
    }
    if (unread.length > 5) lines.push(`${purple("  ├─")} ${dimAnsi(`${unread.length - 5} older unread report(s)`)}`);
    lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
    sessionCtx.ui.setWidget?.("02-pi-extended-teams-inbox", bottomStatusWidget(lines), { placement: "belowEditor" });
  }

  function requireTeamContext(explicitTeamName?: string): string {
    const targetTeamName = explicitTeamName || teamName;
    if (!targetTeamName) {
      throw new Error("No team name supplied and no current team context detected.");
    }
    return targetTeamName;
  }

  async function requireWriteAgentTeam(): Promise<string> {
    if (!teamName) {
      throw new Error("No team context available for file claims.");
    }
    if (!isTeammate) {
      throw new Error("claim_file and release_file are only available to teammates; leads should use list_file_claims.");
    }

    const teamConfig = await teams.readConfig(teamName);
    const member = teamConfig.members.find(m => m.name === agentName);
    const role = member?.role ?? "write";
    if (role !== "write") {
      throw new Error("File claim tools are only available to write agents.");
    }

    return teamName;
  }

  async function releaseAllClaimsForAgent(teamName: string, agentName: string): Promise<string[]> {
    try {
      return await claims.releaseAllForAgent(teamName, agentName);
    } catch {
      return [];
    }
  }

  async function countWriteMembers(teamName: string): Promise<number> {
    const config = await teams.readConfig(teamName);
    return config.members.filter(member => member.agentType === "teammate" && (member.role ?? "write") === "write").length;
  }

  async function buildRoster(teamName: string) {
    const config = await teams.readConfig(teamName);
    const allTasks = await tasks.listTasks(teamName).catch(() => []);
    const allClaims = await claims.listClaims(teamName).catch(() => []);
    const queue = await writeQueue.listWriteQueue(teamName).catch(() => []);

    const members = await Promise.all(config.members.map(async (member) => {
      const role = member.role ?? (member.name === "team-lead" ? "lead" : "write");
      const runtimeStatus = member.name === "team-lead" ? null : await runtime.readRuntimeStatus(teamName, member.name).catch(() => null);
      const unreadCount = member.name === "team-lead" ? 0 : (await messaging.readInbox(teamName, member.name, true, false).catch(() => [])).length;
      const memberTasks = allTasks.filter((task: any) => task.owner === member.name && task.status !== "completed" && task.status !== "deleted");
      const memberClaims = allClaims.filter(claim => claim.agent === member.name);
      const readState = runningReadAgents.get(readAgentKey(teamName, member.name));
      const alive = member.name === "team-lead"
        ? true
        : role === "read"
          ? !!readState || !!runtimeStatus?.ready
          : !!(member.tmuxPaneId && terminal?.isAlive(member.tmuxPaneId));

      return {
        name: member.name,
        role,
        status: member.name === "team-lead" ? "lead" : alive ? (readState?.status || "running") : "dead/idle",
        model: member.model,
        cwd: member.cwd,
        unreadCount,
        tasks: memberTasks.map((task: any) => ({ id: task.id, subject: task.subject, status: task.status })),
        claims: memberClaims.map(claim => claim.path),
        tmuxPaneId: member.tmuxPaneId || undefined,
        runtime: runtimeStatus,
      };
    }));

    return {
      teamName,
      members,
      writeQueue: queue.map((item, index) => ({ position: index + 1, id: item.id, name: item.name, requestedAt: item.requestedAt })),
    };
  }

  function formatRosterForPrompt(roster: Awaited<ReturnType<typeof buildRoster>>): string {
    const lines = [`Team roster for ${roster.teamName}:`];
    for (const member of roster.members) {
      const taskText = member.tasks.length > 0 ? ` tasks=${member.tasks.map(task => `#${task.id}:${task.status}`).join(",")}` : "";
      const claimText = member.claims.length > 0 ? ` claims=${member.claims.join(",")}` : "";
      lines.push(`- ${member.name}: ${member.role}, ${member.status}, unread=${member.unreadCount}${taskText}${claimText}`);
    }
    if (roster.writeQueue.length > 0) {
      lines.push(`Queued writers: ${roster.writeQueue.map(item => `${item.position}.${item.name}`).join(", ")}`);
    }
    return lines.join("\n");
  }

  async function startWriteAgent(teamName: string, member: Member, prompt: string): Promise<string> {
    if (!terminal) {
      throw new Error("pi-extended-teams requires running inside tmux for write agents.");
    }

    await teams.addMember(teamName, member);
    await messaging.sendPlainMessage(teamName, "team-lead", member.name, prompt, "Initial prompt");

    const settings = loadSettings({ projectDir: member.cwd });
    const piBinary = getPiLaunchCommand();
    const allowedExtensions = resolveAllowedExtensions(settings);
    const piCmd = buildPiCommand(piBinary, member.model, member.thinking, allowedExtensions);

    const env: Record<string, string> = {
      ...process.env,
      PI_TEAM_NAME: teamName,
      PI_AGENT_NAME: member.name,
    };

    try {
      const teamConfig = await teams.readConfig(teamName);
      const leadMember = teamConfig.members.find(m => m.name === "team-lead");
      const anchorPaneId = leadMember?.tmuxPaneId || process.env.TMUX_PANE || undefined;
      const terminalId = terminal.spawn({
        name: member.name,
        cwd: member.cwd,
        command: piCmd,
        env,
        anchorPaneId,
      });
      await teams.updateMember(teamName, member.name, { tmuxPaneId: terminalId });
      return terminalId;
    } catch (e) {
      await teams.removeMember(teamName, member.name);
      throw new Error(`Failed to spawn tmux pane: ${e}`);
    }
  }

  async function drainWriteQueue(teamName: string): Promise<void> {
    if (writeQueueDraining) return;
    writeQueueDraining = true;
    try {
      const settings = loadSettings();
      while (await countWriteMembers(teamName) < settings.writeAgents.maxConcurrent) {
        const queued = await writeQueue.dequeueWriteSpawn(teamName);
        if (!queued) return;

        const config = await teams.readConfig(teamName);
        if (config.members.some(member => member.name === queued.name)) {
          await messaging.sendPlainMessage(
            teamName,
            "system",
            "team-lead",
            `Skipped queued writer ${queued.name} because a teammate with that name already exists.`,
            `Skipped queued writer ${queued.name}`,
            "yellow"
          );
          continue;
        }

        const member = writeQueue.queuedWriteSpawnToMember(teamName, queued);
        try {
          const terminalId = await startWriteAgent(teamName, member, queued.prompt);
          await messaging.sendPlainMessage(
            teamName,
            "system",
            "team-lead",
            `Queued writer ${queued.name} started in pane ${terminalId}.`,
            `Queued writer ${queued.name} started`,
            "green"
          );
        } catch (e) {
          await messaging.sendPlainMessage(
            teamName,
            "system",
            "team-lead",
            `Queued writer ${queued.name} failed to start: ${e instanceof Error ? e.message : String(e)}`,
            `Queued writer ${queued.name} failed`,
            "red"
          );
        }
      }
    } finally {
      writeQueueDraining = false;
    }
  }

  async function runReadAgentInProcess(
    readTeamName: string,
    member: Member,
    prompt: string,
    ctx: any
  ): Promise<void> {
    const key = readAgentKey(readTeamName, member.name);
    const state: RunningReadAgent = {
      runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: member.name,
      teamName: readTeamName,
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "starting",
      recentEvents: [],
      model: member.model,
      thinking: member.thinking,
    };
    runningReadAgents.set(key, state);
    ensureReadAgentStatusTicker();

    let heartbeatTimer: NodeJS.Timeout | null = null;
    try {
      const [provider, modelId] = (member.model || "").split("/", 2);
      const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
      if (!model) {
        throw new Error(`Read agent model "${member.model}" is not available.`);
      }

      await runtime.writeRuntimeStatus(readTeamName, member.name, {
        pid: process.pid,
        startedAt: state.startedAt,
        lastHeartbeatAt: Date.now(),
        ready: true,
        lastError: undefined,
      });

      heartbeatTimer = setInterval(async () => {
        try {
          await runtime.writeRuntimeStatus(readTeamName, member.name, {
            lastHeartbeatAt: Date.now(),
          });
        } catch {
          // Ignore heartbeat races during shutdown.
        }
      }, 5000);

      const loader = new DefaultResourceLoader({
        cwd: member.cwd,
        agentDir: getAgentDir(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        appendSystemPrompt: [
          `You are read-only investigator '${member.name}' on team '${readTeamName}', running in-process in the lead session.`,
          "You have the full toolset and may run any read-only shell command you need to investigate — git status/log/diff/show, grep/rg, ls, cat, running tests or builds, etc.",
          "Even though the edit/write tools are available, do not use them: do not edit or write files, install or remove packages, start long-running services, commit, push, deploy, or make any other mutating or destructive change. Investigate and report; if a change is needed, recommend it to the lead instead of applying it.",
          "NEVER sleep, busy-wait, or poll. Do not use bash sleep, while-true, or any wait/poll loop. The extension wakes you when messages arrive.",
          "When finished, produce your final report and stop. Do not wait for the lead to kill you — report and exit cleanly.",
        ],
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd: member.cwd,
        model,
        thinkingLevel: member.thinking as any,
        modelRegistry: ctx.modelRegistry,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(member.cwd),
      });

      state.session = session;
      state.status = "running";
      pushReadAgentEvent(state, "started");
      renderReadAgentStatus();

      session.subscribe((event: any) => {
        if (event.type === "tool_execution_start") {
          pushReadAgentEvent(state, `tool ${event.toolName}`);
        }
        if (event.type === "turn_end") {
          pushReadAgentEvent(state, "turn complete");
        }
        if (event.type === "agent_end") {
          pushReadAgentEvent(state, "agent complete");
        }
        if (event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") {
          try {
            state.tokensUsed = session.getSessionStats().tokens.total;
            renderReadAgentStatus();
          } catch {
            // Ignore stats races while the nested session is shutting down.
          }
        }
      });

      await session.prompt(prompt, { source: "extension" as any });
      state.status = "finishing";
      state.tokensUsed = session.getSessionStats().tokens.total;
      pushReadAgentEvent(state, "sending report");
      renderReadAgentStatus();

      if (state.stopRequested || !isCurrentReadAgentRun(key, state)) return;

      const report = getLastAssistantText(session.messages) || "Read agent completed, but produced no assistant text.";
      rememberCompletedAgentReport(readTeamName, {
        name: member.name,
        role: "read",
        status: "completed",
        report,
        summary: `Read agent ${member.name} completed`,
        completedAt: Date.now(),
        startedAt: state.startedAt,
        elapsedMs: Date.now() - state.startedAt,
        tokensUsed: state.tokensUsed,
        model: member.model,
        thinking: member.thinking,
        color: member.color,
        source: "read-agent",
      });
      if (!isTeammate && teamName === readTeamName) {
        // In-process reader in the lead session: deliver the report straight to
        // the main window (collapsed, auto-synthesized). No inbox, no polling.
        emitAgentReport(member.name, state.startedAt, state.tokensUsed, report, true);
      } else {
        await messaging.sendPlainMessage(readTeamName, member.name, "team-lead", report, `Read agent ${member.name} completed`, member.color);
      }
    } catch (e) {
      if (!state.stopRequested && isCurrentReadAgentRun(key, state)) {
        const failureReport = `Read agent ${member.name} failed: ${e instanceof Error ? e.message : String(e)}`;
        rememberCompletedAgentReport(readTeamName, {
          name: member.name,
          role: "read",
          status: "failed",
          report: failureReport,
          summary: `Read agent ${member.name} failed`,
          completedAt: Date.now(),
          startedAt: state.startedAt,
          elapsedMs: Date.now() - state.startedAt,
          tokensUsed: state.tokensUsed,
          model: member.model,
          thinking: member.thinking,
          color: "red",
          source: "read-agent",
        });
        if (!isTeammate && teamName === readTeamName) {
          emitAgentReport(member.name, state.startedAt, state.tokensUsed, failureReport, false);
        } else {
          await messaging.sendPlainMessage(readTeamName, member.name, "team-lead", failureReport, `Read agent ${member.name} failed`, "red");
        }
        try {
          await runtime.writeRuntimeStatus(readTeamName, member.name, {
            lastHeartbeatAt: Date.now(),
            lastError: runtime.createRuntimeError(e),
          });
        } catch {
          // Ignore runtime cleanup races.
        }
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (state.session) {
        await shutdownReadAgentSession(state.session);
      }
      state.session?.dispose();
      if (isCurrentReadAgentRun(key, state)) {
        runningReadAgents.delete(key);
        await releaseAllClaimsForAgent(readTeamName, member.name);
        try {
          await runtime.deleteRuntimeStatus(readTeamName, member.name);
        } catch {
          // Ignore cleanup races.
        }
        try {
          await teams.removeMember(readTeamName, member.name);
        } catch {
          // Ignore cleanup races.
        }
      }
      renderReadAgentStatus();
    }
  }

  /**
   * Start inbox polling for the team lead.
   * Called when a team is created or when the lead reconnects to an existing team.
   * Requires sessionCtx to be set (from session_start).
   */
  function startLeadInboxPolling() {
    if (leadPollingStarted || isTeammate || !sessionCtx) return;
    leadPollingStarted = true;

    setInterval(async () => {
      if (!teamName) return;
      if (sessionCtx.isIdle()) {
        try {
          const unread = await messaging.readInbox(teamName, agentName, true, false);
          await renderLeadInboxStatus();
          // Retry any wake that was deferred while the lead was busy. Internal
          // gating ensures a batch of reports nudges at most once.
          wakeLeadForInboxReports(unread);
        } catch {
          // Ignore errors for lead polling
        }
      }
    }, 30000);
  }

  // Make this session the active lead for `name`: set the current team, register
  // the lead session, and start quiet background maintenance. Idempotent. Without
  // this, operating on an existing/reconnected team leaves `teamName` unset, which
  // silently breaks /team, the inbox poll, and report wakeups.
  function adoptTeamAsLead(name: string): void {
    if (isTeammate || !name) return;
    if (teamName !== name) {
      teamName = name;
      registerLeadSession(name);
    }
    startLeadInboxPolling();
    startLeadWatchdog();
  }

  // Collapsed, ctrl+o-expandable report entries delivered to the lead's main window.
  pi.registerMessageRenderer?.("pi-extended-teams-report", (message: any, options: any, theme: any) => {
    const d = message.details || {};
    const meta = [
      d.elapsedMs ? formatElapsed(d.elapsedMs) : "",
      typeof d.tokens === "number" ? `${formatTokenCount(d.tokens)} tok` : "",
    ].filter(Boolean).join(" · ");
    const mark = d.ok === false ? theme.fg("warning", "✗") : theme.fg("success", "✓");
    const headline = `${mark} ${d.name || "agent"} reported${meta ? ` · ${meta}` : ""}`;
    if (!options.expanded) {
      return new Text(`${headline}  ${theme.fg("dim", "(ctrl+o to expand)")}`, 0, 0);
    }
    const body = typeof message.content === "string" ? message.content : "";
    return new Text(`${theme.bold(headline)}\n\n${body}`, 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    paths.ensureDirs();
    sessionCtx = ctx;

    if (isTeammate) {
      if (teamName) {
        const pidFile = path.join(paths.teamDir(teamName), `${agentName}.pid`);
        fs.writeFileSync(pidFile, process.pid.toString());
        await runtime.writeRuntimeStatus(teamName, agentName, {
          pid: process.pid,
          startedAt: Date.now(),
          lastHeartbeatAt: Date.now(),
          ready: false,
          lastError: undefined,
        });
      }
      ctx.ui.notify(`Teammate: ${agentName} (Team: ${teamName})`, "info");

      if (terminal) {
        const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
        const setIt = () => {
          if ((ctx.ui as any).setTitle) (ctx.ui as any).setTitle(fullTitle);
          terminal.setTitle(fullTitle);
        };
        setIt();
        setTimeout(setIt, 500);
        setTimeout(setIt, 2000);
        setTimeout(setIt, 5000);
      }

      setTimeout(() => {
        quietTrigger(`read_inbox(team_name="${teamName}") to get your instructions, then begin your work.`);
      }, 1000);

      // Inbox polling for teammates
      if (teamName) {
        setInterval(async () => {
          if (ctx.isIdle()) {
            try {
              const unread = await messaging.readInbox(teamName!, agentName, true, false);
              await runtime.writeRuntimeStatus(teamName!, agentName, {
                lastHeartbeatAt: Date.now(),
              });
              if (unread.length > 0) {
                quietTrigger(`You have ${unread.length} new inbox message(s). Read them with read_inbox and act.`);
              }
            } catch (e) {
              await runtime.writeRuntimeStatus(teamName!, agentName, {
                lastHeartbeatAt: Date.now(),
                lastError: runtime.createRuntimeError(e),
              });
            }
          }
        }, 30000);
      }
    } else if (teamName) {
      // Lead reconnecting to an existing team
      startLeadInboxPolling();
      startLeadWatchdog();
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (isTeammate) {
      const fullTitle = teamName ? `${teamName}: ${agentName}` : agentName;
      if ((ctx.ui as any).setTitle) (ctx.ui as any).setTitle(fullTitle);
      if (terminal) terminal.setTitle(fullTitle);
      if (teamName) {
        await runtime.writeRuntimeStatus(teamName, agentName, {
          lastHeartbeatAt: Date.now(),
        });
      }
    }
  });

  let firstTurn = true;
  pi.on("before_agent_start", async (event, ctx) => {
    if (isTeammate && firstTurn) {
      firstTurn = false;

      if (teamName) {
        await runtime.writeRuntimeStatus(teamName, agentName, {
          lastHeartbeatAt: Date.now(),
        });
      }

      let modelInfo = "";
      let roleSpecificGuidance = "";
      let rosterInfo = "";
      if (teamName) {
        try {
          const teamConfig = await teams.readConfig(teamName);
          const member = teamConfig.members.find(m => m.name === agentName);
          if (member && member.model) {
            modelInfo = `\nYou are currently using model: ${member.model}`;
            if (member.thinking) {
              modelInfo += ` with thinking level: ${member.thinking}`;
            }
            modelInfo += `. When reporting your model or thinking level, use these exact values.`;
          }
          if ((member?.role ?? "write") === "write") {
            roleSpecificGuidance = `\n\nWrite-agent rules:\n- Before editing or writing any repository file, call claim_file with every path you intend to change and wait for the claim to be granted.\n- If claim_file reports conflicts, do not edit those files; coordinate with your lead instead.\n- Release claims with release_file as soon as you are done editing those paths.\n- When your work is finished, call report_and_exit. It sends your final report, releases any remaining file claims, and shuts you down. Do not wait for the lead to kill you.`;
          } else {
            roleSpecificGuidance = `\n\nRead-agent rules:\n- You are read-only: investigate and report. Do not edit files or make any mutating changes.\n- When finished, produce your final report and stop. Do not wait for the lead to kill you.`;
          }
          rosterInfo = `\n\n${formatRosterForPrompt(await buildRoster(teamName))}\nUse list_teammates when you need an updated roster; do not poll check_teammate unless diagnosing liveness.`;
        } catch (e) {
          // Ignore
        }
      }

      return {
        systemPrompt: event.systemPrompt + `\n\nYou are teammate '${agentName}' on team '${teamName}'.\nYour lead is 'team-lead'.${modelInfo}\n\nCore rules for every teammate:\n- NEVER sleep, busy-wait, or poll. Do not use bash sleep, while-true, or any wait/poll loop. The extension wakes you when messages arrive.\n- When your work is done, report and exit cleanly. Do not wait for the lead to shut you down.${roleSpecificGuidance}${rosterInfo}\nStart by calling read_inbox(team_name="${teamName}") to get your initial instructions.`,
      };
    }
  });

  async function shutdownReadAgentSession(session: AgentSession | undefined): Promise<void> {
    if (!session?.abort) return;

    try {
      await Promise.race([
        session.abort(),
        new Promise<void>((resolve) => setTimeout(resolve, 2500)),
      ]);
    } catch {
      // Ignore abort races: the read-agent should continue teardown regardless.
    }
  }

  async function shutdownTeammate(
    teamName: string,
    member: Member,
    options: { drainQueue?: boolean } = {}
  ): Promise<void> {
    if (member.name === "team-lead") return;

    const drainQueue = options.drainQueue ?? true;
    await releaseAllClaimsForAgent(teamName, member.name);
    await killTeammate(teamName, member);
    await teams.removeMember(teamName, member.name);
    if (drainQueue && (member.role ?? "write") === "write") {
      await drainWriteQueue(teamName);
    }
  }

  async function killTeammate(teamName: string, member: Member) {
    if (member.name === "team-lead") return;

    if (member.role === "read") {
      const key = readAgentKey(teamName, member.name);
      const state = runningReadAgents.get(key);
      if (state) {
        state.stopRequested = true;
      }
      if (state?.session) {
        await shutdownReadAgentSession(state.session);
        state.session.dispose();
      }
      if (state && isCurrentReadAgentRun(key, state)) {
        runningReadAgents.delete(key);
      }
      renderReadAgentStatus();
      await runtime.deleteRuntimeStatus(teamName, member.name);
      return;
    }

    const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
    if (fs.existsSync(pidFile)) {
      try {
        const pid = fs.readFileSync(pidFile, "utf-8").trim();
        process.kill(parseInt(pid), "SIGKILL");
        fs.unlinkSync(pidFile);
      } catch (e) {
        // ignore
      }
    }

    if (member.tmuxPaneId && terminal) {
      terminal.kill(member.tmuxPaneId);
    }

    await runtime.deleteRuntimeStatus(teamName, member.name);
  }
  function teammateRuntimeIsStale(status: runtime.AgentRuntimeStatus | null, maxAgeMs: number): boolean {
    if (!status) return false;
    const lastActivity = status.lastHeartbeatAt || status.startedAt || 0;
    return lastActivity > 0 && (Date.now() - lastActivity) > maxAgeMs;
  }

  async function reapTeammate(teamName: string, member: Member, reason: string): Promise<void> {
    await shutdownTeammate(teamName, member);
    await messaging.sendPlainMessage(
      teamName,
      "watchdog",
      "team-lead",
      `Reaped ${member.name}: ${reason}`,
      `Watchdog reaped ${member.name}`,
      "yellow"
    );
  }

  async function runWatchdogOnce(targetTeamName: string): Promise<void> {
    const settings = loadSettings({ projectDir: sessionCtx?.cwd || process.cwd() });
    const staleMs = runtime.HEARTBEAT_STALE_MS + settings.watchdog.bufferSeconds * 1000;
    const config = await teams.readConfig(targetTeamName);

    for (const member of config.members) {
      if (member.name === "team-lead") continue;
      const role = member.role ?? "write";
      const runtimeStatus = await runtime.readRuntimeStatus(targetTeamName, member.name);
      const runtimeStale = teammateRuntimeIsStale(runtimeStatus, staleMs);

      if (role === "read") {
        if (runtimeStale && !runningReadAgents.has(readAgentKey(targetTeamName, member.name))) {
          await reapTeammate(targetTeamName, member, "read-agent heartbeat is stale and no in-process session is running");
        }
        continue;
      }

      const paneAlive = !!(member.tmuxPaneId && terminal?.isAlive(member.tmuxPaneId));
      if (!paneAlive) {
        await reapTeammate(targetTeamName, member, "tmux pane is gone");
        continue;
      }

      if (runtimeStale) {
        await reapTeammate(targetTeamName, member, `heartbeat is stale for more than ${Math.round(staleMs / 1000)}s`);
      }
    }

    await runtime.cleanupStaleRuntimeFiles(targetTeamName);
  }

  function startLeadWatchdog() {
    if (leadWatchdogStarted || isTeammate || !sessionCtx) return;
    leadWatchdogStarted = true;
    setInterval(async () => {
      if (!teamName) return;
      try {
        await runWatchdogOnce(teamName);
      } catch {
        // Keep watchdog quiet; health is visible via /team and inbox messages on actual reaps.
      }
    }, 30000);
  }

  async function buildTeamPanelItems(panelTeamName: string) {
    const config = await teams.readConfig(panelTeamName);
    const allTasks = await tasks.listTasks(panelTeamName).catch(() => []);
    const allClaims = await claims.listClaims(panelTeamName).catch(() => []);
    const activeNames = new Set(config.members.filter((m) => m.name !== "team-lead").map((m) => m.name));
    const items = [] as Array<{
      name: string;
      role: string;
      status: string;
      model?: string;
      thinking?: string;
      unreadCount: number;
      elapsedMs: number;
      tokensUsed: number;
      taskSubjects: string[];
      claimPaths: string[];
      recentEvents: string[];
      runtimeStatus: any;
      completed: boolean;
      completedAt?: number;
      summary?: string;
      reportText?: string;
    }>;

    for (const member of config.members.filter((m) => m.name !== "team-lead")) {
      const readState = runningReadAgents.get(readAgentKey(panelTeamName, member.name));
      const runtimeStatus = await runtime.readRuntimeStatus(panelTeamName, member.name).catch(() => null);
      const unreadCount = (await messaging.readInbox(panelTeamName, member.name, true, false).catch(() => [])).length;
      const role = member.role || "write";
      const alive = role === "read"
        ? !!readState || !!runtimeStatus?.ready
        : !!(member.tmuxPaneId && terminal?.isAlive(member.tmuxPaneId));
      const status = readState?.status || (alive ? "running" : "idle/dead");
      const startedAt = readState?.startedAt || runtimeStatus?.startedAt || member.joinedAt;

      items.push({
        name: member.name,
        role,
        status,
        model: member.model,
        thinking: member.thinking,
        unreadCount,
        elapsedMs: Date.now() - startedAt,
        tokensUsed: readState?.tokensUsed || 0,
        taskSubjects: allTasks
          .filter((task: any) => task.owner === member.name && task.status !== "completed" && task.status !== "deleted")
          .map((task: any) => `#${task.id} ${task.subject}`),
        claimPaths: allClaims.filter((claim) => claim.agent === member.name).map((claim) => claim.path),
        recentEvents: readState?.recentEvents || [],
        runtimeStatus,
        completed: false,
      });
    }

    const leadInboxMessages = await messaging.readInbox(panelTeamName, "team-lead", false, false).catch(() => []);
    const completedFromInbox: CompletedAgentReport[] = leadInboxMessages
      .filter((message: any) => {
        const from = String(message.from || "");
        return from && from !== "team-lead" && from !== "system" && from !== "watchdog" && !activeNames.has(from);
      })
      .map((message: any) => ({
        name: String(message.from),
        role: "write",
        status: "completed" as const,
        report: String(message.text || ""),
        summary: String(message.summary || "Final report"),
        completedAt: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
        color: message.color,
        source: "lead-inbox" as const,
      }));

    const completed = [...(completedAgentReports.get(panelTeamName) ?? []), ...completedFromInbox]
      .filter((report) => report.report.trim().length > 0)
      .sort((a, b) => b.completedAt - a.completedAt);
    const seenCompleted = new Set<string>();
    for (const report of completed) {
      const dedupeKey = `${report.name}:${report.completedAt}:${report.summary || ""}`;
      if (seenCompleted.has(dedupeKey)) continue;
      seenCompleted.add(dedupeKey);
      items.push({
        name: report.name,
        role: report.role,
        status: report.status,
        model: report.model,
        thinking: report.thinking,
        unreadCount: 0,
        elapsedMs: report.elapsedMs ?? (report.startedAt ? report.completedAt - report.startedAt : 0),
        tokensUsed: report.tokensUsed || 0,
        taskSubjects: [],
        claimPaths: [],
        recentEvents: [],
        runtimeStatus: null,
        completed: true,
        completedAt: report.completedAt,
        summary: report.summary,
        reportText: report.report,
      });
    }

    return items.sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (a.completed && b.completed) return (b.completedAt || 0) - (a.completedAt || 0);
      return a.name.localeCompare(b.name);
    });
  }

  // Commands
  pi.registerCommand("team", {
    description: "Switch between main + teammates (↑/↓), refresh (r), or stop selected teammate (x).",
    handler: async (args, ctx) => {
      const panelTeamName = args.trim() || teamName;
      if (!panelTeamName) {
        ctx.ui.notify("No current team. Pass a team name: /team <name>", "warning");
        return;
      }

      let items = await buildTeamPanelItems(panelTeamName);
      // Entry 0 is the "main" lead session, like Claude Code's agent switcher:
      // press ↓ to move main → agent → next agent and the right pane changes.
      let selectedIndex = 0;
      let loading = false;
      let focusedPane: "list" | "log" = "list";
      let logOffsetFromBottom = 0;

      // pi's ExtensionAPI has no API to swap the primary transcript view, so this
      // lives in a focused custom() overlay. Read agents run in-process, so their
      // live transcript is rendered on the right; write agents run in their own
      // tmux pane, so we point the user there instead.
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const entryCount = () => items.length + 1;
        // Re-render while open so an in-process read agent's transcript streams live.
        const liveTimer = setInterval(() => tui.requestRender(), 1000);

        const refresh = () => {
          loading = true;
          tui.requestRender();
          void buildTeamPanelItems(panelTeamName)
            .then((nextItems) => {
              items = nextItems;
              selectedIndex = Math.min(selectedIndex, Math.max(0, entryCount() - 1));
              logOffsetFromBottom = 0;
            })
            .finally(() => {
              loading = false;
              tui.requestRender();
            });
        };

        const buildLeftRows = (): string[] => {
          const rows: string[] = [focusedPane === "list" ? pink("views ◂") : purple("views")];
          const mainSelected = selectedIndex === 0;
          rows.push(`${mainSelected ? pink("▸") : " "} ${mainSelected ? pink("main") : "main"}  ${dimAnsi("lead")}`);
          let completedHeadingShown = false;
          for (const [index, item] of items.entries()) {
            if (item.completed && !completedHeadingShown) {
              rows.push("");
              rows.push(purple("completed"));
              completedHeadingShown = true;
            }
            const selected = index + 1 === selectedIndex;
            const pointer = selected ? pink("▸") : " ";
            const role = item.completed ? dimAnsi("done") : item.role === "read" ? pink("read") : purple("write");
            const health = item.completed ? item.status : item.status.includes("dead") ? "dead" : item.status;
            rows.push(`${pointer} ${selected ? pink(item.name) : item.name}  ${role}  ${dimAnsi(health)}`);
          }
          return rows;
        };

        const buildRightRows = (width: number): string[] => {
          const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(10, width));
          const rows: string[] = [];

          if (selectedIndex === 0) {
            const activeReaders = items.filter((item) => !item.completed && item.role === "read");
            const activeWriters = items.filter((item) => !item.completed && item.role !== "read");
            const completed = items.filter((item) => item.completed);
            rows.push(pink(`main · ${panelTeamName}`));
            rows.push(focusedPane === "log" ? pink("log pane focused") : dimAnsi("press → to focus log pane"));
            rows.push("");
            rows.push(`${purple("read agents")}   ${activeReaders.length} (in-process)`);
            rows.push(`${purple("write agents")}  ${activeWriters.length} (tmux panes)`);
            rows.push(`${purple("completed")}     ${completed.length}`);
            rows.push(`${purple("lead inbox")}    ${leadInboxUnreadCount} unread`);
            rows.push("");
            rows.push(dimAnsi("Select an active or completed agent on the left to inspect its live transcript or final output."));
            return rows.flatMap(wrap);
          }

          const item = items[selectedIndex - 1];
          if (!item) return [dimAnsi("No teammates.")];

          rows.push(pink(item.name));
          if (item.completed) {
            rows.push(`${purple("status")} ${item.status}   ${purple("completed")} ${item.completedAt ? new Date(item.completedAt).toLocaleString() : "unknown"}`);
            if (item.elapsedMs > 0 || item.tokensUsed > 0) rows.push(`${purple("elapsed")} ${formatElapsed(item.elapsedMs)}   ${purple("tokens")} ${formatTokenCount(item.tokensUsed)}`);
            if (item.summary) rows.push(`${purple("summary")} ${item.summary}`);
            rows.push("");
            rows.push(purple("final output"));
            rows.push(item.reportText || dimAnsi("(completed agent produced no output)"));
            return rows.flatMap(wrap);
          }

          rows.push(`${purple("role")} ${item.role}   ${purple("status")} ${item.status}   ${purple("elapsed")} ${formatElapsed(item.elapsedMs)}   ${purple("tokens")} ${formatTokenCount(item.tokensUsed)}`);
          rows.push(`${purple("model")} ${item.model || "(inherited)"}${item.thinking && item.thinking !== "off" ? `   ${purple("thinking")} ${item.thinking}` : ""}`);
          if (item.role === "read") rows.push(dimAnsi("in-process · promote_teammate moves it into a tmux pane"));
          if (item.taskSubjects.length > 0) rows.push(dimAnsi(`tasks: ${item.taskSubjects.slice(0, 4).join(" · ")}`));
          if (item.claimPaths.length > 0) rows.push(dimAnsi(`claims: ${item.claimPaths.slice(0, 4).join(" · ")}`));
          if (item.runtimeStatus?.lastError?.message) rows.push(theme.fg("warning", `error: ${item.runtimeStatus.lastError.message}`));
          rows.push("");

          if (item.role === "read") {
            const session = runningReadAgents.get(readAgentKey(panelTeamName, item.name))?.session;
            const transcript = session ? formatTranscriptLines(session.messages) : [];
            if (transcript.length > 0) {
              rows.push(purple("transcript"));
              for (const line of transcript) rows.push(line);
            } else if (item.recentEvents.length > 0) {
              rows.push(purple("recent"));
              for (const event of item.recentEvents.slice(-12)) rows.push(`  ${event}`);
            } else {
              rows.push(dimAnsi("Waiting for the read agent's first turn…"));
            }
          } else {
            rows.push(dimAnsi(`Write agent runs in tmux pane ${item.runtimeStatus?.pid ? `(pid ${item.runtimeStatus.pid})` : ""}.`));
            rows.push(dimAnsi("Switch to that pane to see its full transcript."));
            if (item.recentEvents.length > 0) {
              rows.push("");
              rows.push(purple("recent"));
              for (const event of item.recentEvents.slice(-12)) rows.push(`  ${event}`);
            }
          }

          return rows.flatMap(wrap);
        };

        const shutdownSelected = async () => {
          if (selectedIndex === 0) {
            ctx.ui.notify("Select a teammate (not main) to stop.", "warning");
            return;
          }
          const item = items[selectedIndex - 1];
          if (!item) {
            ctx.ui.notify("No teammate is selected.", "warning");
            return;
          }
          if (item.completed) {
            ctx.ui.notify(`${item.name} is already completed.`, "info");
            return;
          }

          loading = true;
          tui.requestRender();
          try {
            const config = await teams.readConfig(panelTeamName);
            const member = config.members.find((member) => member.name === item.name && member.name !== "team-lead");
            if (!member) {
              ctx.ui.notify(`Could not find member ${item.name} in team config.`, "warning");
              return;
            }
            await shutdownTeammate(panelTeamName, member);
            items = await buildTeamPanelItems(panelTeamName);
            selectedIndex = Math.min(selectedIndex, Math.max(0, items.length));
            ctx.ui.notify(`Stopped ${item.name}.`, "info");
          } catch (error) {
            ctx.ui.notify(`Failed to stop ${item.name}: ${error instanceof Error ? error.message : String(error)}`, "warning");
          } finally {
            loading = false;
            tui.requestRender();
          }
        };

        const render = (width: number): string[] => {
          // Reserve the side borders and their one-space inner padding.
          const innerWidth = Math.max(48, width - 4);

          const header: string[] = [];
          header.push(pink(`▣ team ${panelTeamName}`) + (loading ? purple("  refreshing…") : ""));
          header.push(dimAnsi("←/→ or h/l: focus list/log   list ↑/↓: select   log ↑/↓: scroll 5   r: refresh   x: stop selected   esc: close"));

          const leftWidth = Math.min(30, Math.max(20, Math.floor(innerWidth * 0.34)));
          const rightWidth = Math.max(20, innerWidth - leftWidth - 3);
          const sep = dimAnsi(" │ ");

          // Fixed panel height (the overlay clips at maxHeight). A stable line
          // count keeps the floating panel from resizing as the transcript grows.
          // Budget rows for the two header lines, the mid rule, and both borders.
          const maxRows = Math.max(8, Math.floor((tui.terminal?.rows ?? 24) * 0.82));
          const bodyHeight = Math.max(3, maxRows - header.length - 3);

          const leftRows = buildLeftRows();
          const rightRows = buildRightRows(rightWidth);
          const rightStart = logWindowStart(rightRows.length, bodyHeight, logOffsetFromBottom);
          const rightWindow = rightRows.slice(rightStart, rightStart + bodyHeight);

          // Header spans the full width; a mid rule separates it from the
          // two-column body so the dark panel never blurs section boundaries.
          const content: string[] = [...header, purple("─".repeat(innerWidth))];
          for (let i = 0; i < bodyHeight; i++) {
            const left = truncateToWidth(leftRows[i] ?? "", leftWidth, "…", true);
            const right = truncateToWidth(rightWindow[i] ?? "", rightWidth);
            content.push(`${left}${sep}${right}`);
          }

          // Border + dark fill paints every cell so the transcript underneath
          // never bleeds through the floating panel.
          return framePanel(content, innerWidth);
        };

        return {
          render,
          invalidate() {},
          dispose() {
            clearInterval(liveTimer);
          },
          handleInput(data: string) {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q" || data === "Q") {
              done();
              return;
            }
            if (isRightInput(data)) {
              focusedPane = "log";
              tui.requestRender();
              return;
            }
            if (isLeftInput(data)) {
              focusedPane = "list";
              tui.requestRender();
              return;
            }
            if (isDownInput(data)) {
              if (focusedPane === "log") {
                logOffsetFromBottom = Math.max(0, logOffsetFromBottom - 5);
              } else {
                selectedIndex = Math.min(entryCount() - 1, selectedIndex + 1);
                logOffsetFromBottom = 0;
              }
              tui.requestRender();
              return;
            }
            if (isUpInput(data)) {
              if (focusedPane === "log") {
                logOffsetFromBottom += 5;
              } else {
                selectedIndex = Math.max(0, selectedIndex - 1);
                logOffsetFromBottom = 0;
              }
              tui.requestRender();
              return;
            }
            if (data === "r" || data === "R") {
              refresh();
              return;
            }
            if (data === "x" || data === "X") {
              void shutdownSelected();
              return;
            }
          },
        };
      }, {
        // Float over the transcript so the running main agent's streaming output
        // underneath never repositions or flickers the panel.
        overlay: true,
        overlayOptions: { width: "92%", maxHeight: "84%", anchor: "center" },
      });
    },
  });

  // Tools
  pi.registerTool({
    name: "list_available_models",
    label: "List Available Models",
    description: "List available fully qualified models for team creation and teammate spawning. Use this before creating a new team or spawning teammates. Models must be specified as provider/model.",
    parameters: Type.Object({}),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const state = await getModelSelectionState(ctx, ctx.cwd);
      const lines = [
        "Choose a fully qualified provider/model string from this list when creating teams or spawning teammates.",
        "Unqualified model names like \"gpt-5\" or \"haiku\" are not accepted.",
      ];

      if (state.preferredQualifiedModels.length > 0) {
        lines.push("", "Preferred models (from pi settings, in priority order):");
        for (const model of state.preferredQualifiedModels) {
          lines.push(`- ${model}`);
        }
      }

      if (state.providerPriority.length > 0) {
        lines.push("", "Provider priority (from pi-extended-teams config):");
        for (const provider of state.providerPriority) {
          lines.push(`- ${provider}`);
        }
      }

      if (state.piSettings.defaultModel || state.piSettings.enabledModels?.length) {
        lines.push("", "Pi model settings:");
        if (state.piSettings.defaultProvider) {
          lines.push(`- defaultProvider: ${state.piSettings.defaultProvider}`);
        }
        if (state.piSettings.defaultModel) {
          lines.push(`- defaultModel: ${state.piSettings.defaultModel}`);
        }
        if (state.piSettings.enabledModels?.length) {
          lines.push(`- enabledModels: ${state.piSettings.enabledModels.join(", ")}`);
        }
      }

      lines.push("", "Available models (already sorted with preferred models first):");
      for (const model of state.sortedModels) {
        const tags: string[] = [];
        if (model.preferred) tags.push("preferred");
        if (model.providerPriorityIndex !== Number.MAX_SAFE_INTEGER) tags.push(`provider-priority:${model.providerPriorityIndex + 1}`);
        lines.push(`- ${model.qualified}${tags.length ? ` [${tags.join(", ")}]` : ""}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          preferredModels: state.preferredQualifiedModels,
          providerPriority: state.providerPriority,
          piSettings: state.piSettings,
          models: state.sortedModels,
        },
      };
    },
  });

  // Shared spawn path used by spawn_teammate and team_create's inline agents.
  // Assumes the team exists and the lead has adopted it.
  async function spawnTeammate(params: any, ctx: any): Promise<{ content: any[]; details: any }> {
    const safeName = paths.sanitizeName(params.name);
    const safeTeamName = paths.sanitizeName(params.team_name);
    const cwd = params.cwd || ctx.cwd;

    const teamConfig = await teams.readConfig(safeTeamName);

    // If a teammate with this name already exists, replace it (handles restarts).
    const existingMember = teamConfig.members.find(m => m.name === safeName && m.agentType === "teammate");
    if (existingMember) {
      await shutdownTeammate(safeTeamName, existingMember);
    }

    const settings = loadSettings({ projectDir: cwd });
    const role: AgentRole = resolveRole(settings, params.role ?? "read", params.category);

    const currentModelHint = getCurrentQualifiedModel(ctx);
    const { availableModels } = await getModelSelectionState(ctx, ctx.cwd, [teamConfig.defaultModel, currentModelHint].filter(Boolean) as string[]);

    const resolved = resolveModel(settings, {
      role,
      category: params.category,
      explicitModel: params.model,
      explicitThinking: params.thinking,
      teamDefaultModel: teamConfig.defaultModel,
      currentModel: currentModelHint,
    });

    const chosenModel = requireQualifiedKnownModel(resolved.model ?? undefined, availableModels, "resolved model");
    if (!chosenModel) {
      throw new Error(
        "No model could be resolved. Pass a fully qualified model, configure a category/role default in settings.json, create the team with a default_model, or ensure the current session has an active model."
      );
    }

    const chosenThinking = (resolved.thinking ?? undefined) as Member["thinking"];

    if (role === "write" && !terminal) {
      throw new Error("pi-extended-teams requires running inside tmux for write agents.");
    }

    const member: Member = {
      agentId: `${safeName}@${safeTeamName}`,
      name: safeName,
      agentType: "teammate",
      role,
      category: params.category,
      model: chosenModel,
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd,
      subscriptions: [],
      prompt: params.prompt,
      color: role === "read" ? "cyan" : "blue",
      thinking: chosenThinking,
      planModeRequired: params.plan_mode_required,
    };

    if (role === "read") {
      await teams.addMember(safeTeamName, member);
      void runReadAgentInProcess(safeTeamName, member, params.prompt, ctx);
      return {
        content: [{ type: "text", text: `Read teammate ${params.name} started in-process.` }],
        details: { agentId: member.agentId, role, mode: "in-process", terminalId: null },
      };
    }

    await writeQueue.removeQueuedWriteSpawnsByName(safeTeamName, safeName);
    const activeWriteCount = await countWriteMembers(safeTeamName);
    if (activeWriteCount >= settings.writeAgents.maxConcurrent) {
      if (!settings.writeAgents.queueOverflow) {
        throw new Error(`Write-agent capacity reached (${activeWriteCount}/${settings.writeAgents.maxConcurrent}) and queueOverflow is disabled.`);
      }
      const queued = await writeQueue.enqueueWriteSpawn(safeTeamName, {
        name: safeName,
        prompt: params.prompt,
        cwd,
        category: params.category,
        model: chosenModel,
        thinking: chosenThinking,
        planModeRequired: params.plan_mode_required,
        color: "blue",
      });
      const queuedItems = await writeQueue.listWriteQueue(safeTeamName);
      return {
        content: [{ type: "text", text: `Write teammate ${params.name} queued at position ${queuedItems.findIndex(item => item.id === queued.id) + 1}; capacity is ${activeWriteCount}/${settings.writeAgents.maxConcurrent}.` }],
        details: { agentId: member.agentId, role, queued: true, queueId: queued.id, queuePosition: queuedItems.findIndex(item => item.id === queued.id) + 1 },
      };
    }

    const terminalId = await startWriteAgent(safeTeamName, member, params.prompt);
    return {
      content: [{ type: "text", text: `Teammate ${params.name} spawned in pane ${terminalId}.` }],
      details: { agentId: member.agentId, role, terminalId, queued: false },
    };
  }

  pi.registerTool({
    name: "team_create",
    label: "Create Team",
    description: "Create a team and (optionally) spawn its agents in one call. Pass `agents` to spawn them immediately — they start running and report back on their own; you do not need to create tasks, poll, or read an inbox. Agents default to read-only (investigation/review/testing); use role 'write' only for isolated independent edit work. If default_model is given it must be a fully qualified provider/model from list_available_models; otherwise the current model is used.",
    parameters: Type.Object({
      team_name: Type.String(),
      description: Type.Optional(Type.String()),
      default_model: Type.Optional(Type.String({ description: "Fully qualified default model (provider/model). Use list_available_models first. If omitted, the current active model is used." })),
      agents: Type.Optional(Type.Array(Type.Object({
        name: Type.String(),
        prompt: Type.String({ description: "The agent's mission and the report shape you want back." }),
        role: Type.Optional(StringEnum(["read", "write"], { description: "Defaults to 'read'. Use 'write' only for isolated independent edit work." })),
        cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the lead's cwd." })),
        category: Type.Optional(Type.String()),
        model: Type.Optional(Type.String({ description: "Fully qualified provider/model." })),
        thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"])),
      }, { description: "An agent to spawn immediately." }), { description: "Agents to define and spawn as soon as the team is created." })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const { availableModels } = await getModelSelectionState(ctx, ctx.cwd);
      const explicitDefaultModel = requireQualifiedKnownModel(params.default_model, availableModels, "default_model");
      const currentModel = requireQualifiedKnownModel(getCurrentQualifiedModel(ctx), availableModels, "current model");
      const defaultModel = explicitDefaultModel || currentModel;

      // Auto-cleanup stale team if the previous lead process is dead.
      if (teams.teamExists(params.team_name)) {
        cleanupStaleTeam(params.team_name, terminal);
      }

      const config = teams.createTeam(params.team_name, "local-session", "lead-agent", params.description, defaultModel);
      adoptTeamAsLead(paths.sanitizeName(params.team_name));

      const lines = [`Team ${params.team_name} created.`];
      const spawned: any[] = [];
      for (const agent of (params.agents ?? [])) {
        try {
          const result = await spawnTeammate({ ...agent, team_name: params.team_name }, ctx);
          spawned.push(result.details);
          lines.push(`- ${result.content?.[0]?.text ?? agent.name}`);
        } catch (e) {
          lines.push(`- ${agent.name}: failed to spawn — ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (spawned.length > 0) {
        lines.push("", "Agents are running. Their reports will arrive here automatically (collapsed; ctrl+o to expand) and you will synthesize them — no polling needed.");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { config, spawned },
      };
    },
  });

  pi.registerTool({
    name: "spawn_teammate",
    label: "Spawn Teammate",
    description: "Spawn one teammate. Default role is 'read' (read-only, in-process, unlimited, parallel — for investigation/review/testing). Use role 'write' only for isolated, independent edit work that should run in its own tmux pane; the lead normally writes itself. Model resolves from explicit arg -> category -> role default -> team default -> current model. Any explicit model must be a fully qualified provider/model from list_available_models.",
    parameters: Type.Object({
      team_name: Type.String(),
      name: Type.String(),
      prompt: Type.String(),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the lead's cwd." })),
      role: Type.Optional(StringEnum(["read", "write"], { description: "Agent role. 'read' (default) is read-only and in-process. 'write' spawns in tmux and can edit files — use only for isolated independent work." })),
      category: Type.Optional(Type.String({ description: "Optional category preset name from settings.json (bundles role + model + thinking)." })),
      model: Type.Optional(Type.String({ description: "Fully qualified model (provider/model). Use list_available_models first. If omitted, the category/role/team default or current model is used." })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"])),
      plan_mode_required: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const safeTeamName = paths.sanitizeName(params.team_name);
      if (!teams.teamExists(safeTeamName)) {
        throw new Error(`Team ${params.team_name} does not exist`);
      }
      adoptTeamAsLead(safeTeamName);
      return spawnTeammate(params, ctx);
    },
  });

  pi.registerTool({
    name: "promote_teammate",
    label: "Move Teammate to tmux pane",
    description: "Move a running in-process read agent into its own tmux pane so you can watch and interact with it there. Stops the in-process session and re-spawns the same mission as a tmux teammate. Requires running inside tmux.",
    parameters: Type.Object({
      team_name: Type.String(),
      name: Type.String(),
      prompt: Type.Optional(Type.String({ description: "Optional updated mission. Defaults to the agent's original mission." })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const safeTeamName = paths.sanitizeName(params.team_name);
      const safeName = paths.sanitizeName(params.name);
      if (!teams.teamExists(safeTeamName)) {
        throw new Error(`Team ${params.team_name} does not exist`);
      }
      adoptTeamAsLead(safeTeamName);
      if (!terminal) {
        throw new Error("pi-extended-teams requires running inside tmux to move an agent into a pane.");
      }

      const config = await teams.readConfig(safeTeamName);
      const member = config.members.find(m => m.name === safeName);
      const key = readAgentKey(safeTeamName, safeName);
      const state = runningReadAgents.get(key);
      const prompt = params.prompt || member?.prompt;
      if (!prompt) {
        throw new Error(`No mission found for ${params.name}; pass prompt to set one.`);
      }

      // Stop the in-process session and clear its runtime state.
      if (state) {
        state.stopRequested = true;
      }
      if (state?.session) {
        await shutdownReadAgentSession(state.session);
        state.session.dispose();
      }
      if (state && isCurrentReadAgentRun(key, state)) {
        runningReadAgents.delete(key);
      }
      renderReadAgentStatus();
      await runtime.deleteRuntimeStatus(safeTeamName, safeName).catch(() => {});
      if (member) await teams.removeMember(safeTeamName, safeName).catch(() => {});

      const result = await spawnTeammate({
        team_name: safeTeamName,
        name: safeName,
        prompt,
        role: "write",
        model: member?.model,
        thinking: member?.thinking,
        cwd: member?.cwd,
      }, ctx);

      return {
        content: [{ type: "text", text: `Moved ${params.name} into a tmux pane. ${result.content?.[0]?.text ?? ""}`.trim() }],
        details: { ...result.details, promoted: true },
      };
    },
  });

  pi.registerTool({
    name: "list_teammates",
    label: "List Teammates",
    description: "List live team roster with roles, status, current tasks, held claims, unread inbox counts, and queued writers.",
    parameters: Type.Object({
      team_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      if (teams.teamExists(paths.sanitizeName(params.team_name))) adoptTeamAsLead(paths.sanitizeName(params.team_name));
      const roster = await buildRoster(params.team_name);
      return {
        content: [{ type: "text", text: formatRosterForPrompt(roster) }],
        details: roster,
      };
    },
  });

  pi.registerTool({
    name: "list_write_queue",
    label: "List Write Queue",
    description: "List queued write-agent spawns for a team.",
    parameters: Type.Object({
      team_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const queue = await writeQueue.listWriteQueue(params.team_name);
      const text = queue.length > 0
        ? [
            `Queued write agents for ${params.team_name}:`,
            ...queue.map((item, index) => `${index + 1}. ${item.name} (${item.id}) requested ${new Date(item.requestedAt).toISOString()}`),
          ].join("\n")
        : `No queued write agents for ${params.team_name}.`;
      return {
        content: [{ type: "text", text }],
        details: { teamName: params.team_name, queue },
      };
    },
  });

  pi.registerTool({
    name: "cancel_write_queue",
    label: "Cancel Write Queue Item",
    description: "Cancel one pending write-agent spawn by queue id.",
    parameters: Type.Object({
      team_name: Type.String(),
      id: Type.String({ description: "Queue item id returned by list_write_queue or a queued spawn." }),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const removed = await writeQueue.cancelQueuedWriteSpawn(params.team_name, params.id);
      if (!removed) {
        throw new Error(`Queued write-agent spawn ${params.id} not found for team ${params.team_name}.`);
      }
      return {
        content: [{ type: "text", text: `Canceled queued writer ${removed.name} (${removed.id}).` }],
        details: { teamName: params.team_name, canceled: removed },
      };
    },
  });

  pi.registerTool({
    name: "claim_file",
    label: "Claim File",
    description: "Claim one or more file paths before a write agent edits them. The claim is exclusive per path within the current team.",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { description: "Repository-relative file paths to claim atomically." }),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const targetTeamName = await requireWriteAgentTeam();
      const result = await claims.claimFiles(targetTeamName, agentName, params.paths);
      const blockedTasks = result.conflicts.length > 0
        ? await tasks.markOwnerTasksBlockedByFileClaims(targetTeamName, agentName, result.conflicts)
        : [];
      const unblockedTasks = result.granted.length > 0
        ? await tasks.clearOwnerFileClaimBlocks(targetTeamName, agentName, result.granted)
        : [];
      const text = result.conflicts.length > 0
        ? [
            `File claim request blocked for ${agentName}.`,
            "Conflicts:",
            ...result.conflicts.map(conflict => `- ${conflict.path} held by ${conflict.heldBy}`),
            blockedTasks.length > 0
              ? `Marked owned task(s) blocked: ${blockedTasks.map(task => task.id).join(", ")}`
              : "No owned open task was available to mark blocked.",
          ].join("\n")
        : result.granted.length > 0
          ? [
              `Claimed ${result.granted.length} file(s) for ${agentName}:`,
              ...result.granted.map(path => `- ${path}`),
              unblockedTasks.length > 0
                ? `Cleared file-claim blocker(s) from task(s): ${unblockedTasks.map(task => task.id).join(", ")}`
                : "No file-claim task blockers needed clearing.",
            ].join("\n")
          : `No file paths claimed for ${agentName}.`;

      return {
        content: [{ type: "text", text }],
        details: {
          agent: agentName,
          teamName: targetTeamName,
          ...result,
          blockedTaskIds: blockedTasks.map(task => task.id),
          unblockedTaskIds: unblockedTasks.map(task => task.id),
        },
      };
    },
  });

  pi.registerTool({
    name: "release_file",
    label: "Release File",
    description: "Release one or more file claims held by the current write agent.",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { description: "Repository-relative file paths to release." }),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const targetTeamName = await requireWriteAgentTeam();
      const released = await claims.releaseFiles(targetTeamName, agentName, params.paths);
      const text = released.length > 0
        ? `Released ${released.length} file claim(s) for ${agentName}:\n${released.map(path => `- ${path}`).join("\n")}`
        : `No matching file claims held by ${agentName} were released.`;

      return {
        content: [{ type: "text", text }],
        details: { agent: agentName, teamName: targetTeamName, released },
      };
    },
  });

  pi.registerTool({
    name: "list_file_claims",
    label: "List File Claims",
    description: "List the current file claims for a team. Defaults to the current team context when available.",
    parameters: Type.Object({
      team_name: Type.Optional(Type.String({ description: "Team name. Defaults to the current team context." })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const targetTeamName = requireTeamContext(params.team_name);
      const currentClaims = (await claims.listClaims(targetTeamName))
        .sort((a, b) => a.path.localeCompare(b.path));
      const text = currentClaims.length > 0
        ? [
            `Current file claims for ${targetTeamName}:`,
            ...currentClaims.map(claim => `- ${claim.path} held by ${claim.agent} since ${new Date(claim.since).toISOString()}`),
          ].join("\n")
        : `No current file claims for ${targetTeamName}.`;

      return {
        content: [{ type: "text", text }],
        details: { teamName: targetTeamName, claims: currentClaims },
      };
    },
  });

  pi.registerTool({
    name: "report_and_exit",
    label: "Report and Exit",
    description: "Send a final report to the team lead, release all file claims, and shut down this teammate.",
    parameters: Type.Object({
      team_name: Type.Optional(Type.String({ description: "Team name. Defaults to the current team context." })),
      content: Type.String({ description: "Final report to send to team-lead." }),
      summary: Type.Optional(Type.String({ description: "Short inbox summary for the final report." })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const targetTeamName = requireTeamContext(params.team_name);
      if (!isTeammate) {
        throw new Error("report_and_exit is only available to teammates.");
      }

      const config = await teams.readConfig(targetTeamName);
      const member = config.members.find(m => m.name === agentName);
      const tmuxPaneId = member?.tmuxPaneId;

      await messaging.sendPlainMessage(
        targetTeamName,
        agentName,
        "team-lead",
        params.content,
        params.summary || "Final report"
      );
      const releasedClaims = await releaseAllClaimsForAgent(targetTeamName, agentName);
      await runtime.deleteRuntimeStatus(targetTeamName, agentName);
      await teams.removeMember(targetTeamName, agentName);
      await drainWriteQueue(targetTeamName);

      setTimeout(() => {
        void (async () => {
          try {
            if (tmuxPaneId && terminal) {
              terminal.kill(tmuxPaneId);
            }
          } catch {
            // Ignore shutdown cleanup races; this tool is already exiting.
          } finally {
            try {
              ctx.shutdown();
            } catch {
              process.exit(0);
            }
          }
        })();
      }, 250);

      return {
        content: [{ type: "text", text: `Final report sent to team-lead. Released ${releasedClaims.length} file claim(s). Exiting.` }],
        details: { teamName: targetTeamName, releasedClaims },
      };
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description: "Send a message to a teammate.",
    parameters: Type.Object({
      team_name: Type.String(),
      recipient: Type.String(),
      content: Type.String(),
      summary: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      await messaging.sendPlainMessage(params.team_name, agentName, params.recipient, params.content, params.summary);
      return {
        content: [{ type: "text", text: `Message sent to ${params.recipient}.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "broadcast_message",
    label: "Broadcast Message",
    description: "Broadcast a message to all team members except the sender.",
    parameters: Type.Object({
      team_name: Type.String(),
      content: Type.String(),
      summary: Type.String(),
      color: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      await messaging.broadcastMessage(params.team_name, agentName, params.content, params.summary, params.color);
      return {
        content: [{ type: "text", text: `Message broadcasted to all team members.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "write_shared_memory",
    label: "Write Shared Memory",
    description: "Write or replace a team-shared memory entry by key. Use for durable coordination facts within the current team.",
    parameters: Type.Object({
      team_name: Type.String(),
      key: Type.String(),
      value: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const entry = await sharedMemory.writeSharedMemory(params.team_name, agentName, params.key, params.value);
      return {
        content: [{ type: "text", text: `Shared memory '${entry.key}' saved.` }],
        details: { entry },
      };
    },
  });

  pi.registerTool({
    name: "read_shared_memory",
    label: "Read Shared Memory",
    description: "Read team-shared memory entries. Omit key to list all entries.",
    parameters: Type.Object({
      team_name: Type.String(),
      key: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const entries = await sharedMemory.readSharedMemory(params.team_name, params.key);
      const text = entries.length > 0
        ? entries.map(entry => `${entry.key} (${entry.author}, ${new Date(entry.updatedAt).toISOString()}):\n${entry.value}`).join("\n\n")
        : params.key ? `No shared memory entry for '${params.key}'.` : "No shared memory entries.";
      return {
        content: [{ type: "text", text }],
        details: { entries },
      };
    },
  });

  pi.registerTool({
    name: "delete_shared_memory",
    label: "Delete Shared Memory",
    description: "Delete one team-shared memory entry by key.",
    parameters: Type.Object({
      team_name: Type.String(),
      key: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const entry = await sharedMemory.deleteSharedMemory(params.team_name, params.key);
      if (!entry) throw new Error(`Shared memory entry '${params.key}' not found.`);
      return {
        content: [{ type: "text", text: `Shared memory '${entry.key}' deleted.` }],
        details: { entry },
      };
    },
  });

  pi.registerTool({
    name: "use_skill",
    label: "Use Skill",
    description: "Load a named skill file into the current agent context.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name, for example teams." }),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const file = resolveSkillFile(params.name, ctx.cwd);
      const content = fs.readFileSync(file, "utf-8");
      return {
        content: [{ type: "text", text: `Loaded skill '${params.name}' from ${file}:\n\n${content}` }],
        details: { name: params.name, path: file },
      };
    },
  });

  pi.registerTool({
    name: "read_inbox",
    label: "Read Inbox",
    description: "Read messages from an agent's inbox.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.Optional(Type.String({ description: "Whose inbox to read. Defaults to your own." })),
      unread_only: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const targetAgent = params.agent_name || agentName;
      if (!isTeammate && teams.teamExists(paths.sanitizeName(params.team_name))) adoptTeamAsLead(paths.sanitizeName(params.team_name));
      const msgs = await messaging.readInbox(params.team_name, targetAgent, params.unread_only);

      if (isTeammate && teamName && params.team_name === teamName && targetAgent === agentName) {
        await runtime.writeRuntimeStatus(teamName, agentName, {
          lastHeartbeatAt: Date.now(),
          lastInboxReadAt: Date.now(),
          ready: true,
          lastError: undefined,
        });
      }

      if (!isTeammate && params.team_name === teamName && targetAgent === agentName) {
        // Lead read its own inbox: refresh the widget (clears when empty) and
        // reset the wake gate so the next batch of reports nudges again.
        leadWakeNotifiedCount = 0;
        await renderLeadInboxStatus();
      }

      return {
        content: [{ type: "text", text: formatInboxMessagesForModel(msgs) }],
        details: { messages: msgs, targetAgent },
      };
    },
    renderResult(result, { expanded }, theme) {
      return renderInboxMessages(result, expanded, theme);
    },
  });

  pi.registerTool({
    name: "task_create",
    label: "Create Task",
    description: "Create a new team task.",
    parameters: Type.Object({
      team_name: Type.String(),
      subject: Type.String(),
      description: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const task = await tasks.createTask(params.team_name, params.subject, params.description);
      return {
        content: [{ type: "text", text: `Task ${task.id} created.` }],
        details: { task },
      };
    },
  });

  pi.registerTool({
    name: "task_submit_plan",
    label: "Submit Plan",
    description: "Submit a plan for a task, updating its status to 'planning'.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
      plan: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const updated = await tasks.submitPlan(params.team_name, params.task_id, params.plan);
      return {
        content: [{ type: "text", text: `Plan submitted for task ${params.task_id}.` }],
        details: { task: updated },
      };
    },
  });

  pi.registerTool({
    name: "task_evaluate_plan",
    label: "Evaluate Plan",
    description: "Evaluate a submitted plan for a task.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
      action: StringEnum(["approve", "reject"]),
      feedback: Type.Optional(Type.String({ description: "Required for rejection" })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const updated = await tasks.evaluatePlan(params.team_name, params.task_id, params.action as any, params.feedback);
      return {
        content: [{ type: "text", text: `Plan for task ${params.task_id} has been ${params.action}d.` }],
        details: { task: updated },
      };
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "List Tasks",
    description: "List all tasks for a team.",
    parameters: Type.Object({
      team_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const taskList = await tasks.listTasks(params.team_name);
      return {
        content: [{ type: "text", text: JSON.stringify(taskList, null, 2) }],
        details: { tasks: taskList },
      };
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "Update Task",
    description: "Update a task's status or owner.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
      status: Type.Optional(StringEnum(["pending", "planning", "in_progress", "completed", "deleted"])),
      owner: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const updated = await tasks.updateTask(params.team_name, params.task_id, {
        status: params.status as any,
        owner: params.owner,
      });
      return {
        content: [{ type: "text", text: `Task ${params.task_id} updated.` }],
        details: { task: updated },
      };
    },
  });

  pi.registerTool({
    name: "team_shutdown",
    label: "Shutdown Team",
    description: "Shutdown the entire team and close all panes/windows.",
    parameters: Type.Object({
      team_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const teamName = params.team_name;
      try {
        const config = await teams.readConfig(teamName);
        for (const member of config.members) {
          await shutdownTeammate(teamName, member, { drainQueue: false });
        }
        const dir = paths.teamDir(teamName);
        const tasksDir = paths.taskDir(teamName);
        if (fs.existsSync(tasksDir)) fs.rmSync(tasksDir, { recursive: true });
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });

        // Clean up orphaned agent session folders (older than 1 hour)
        const cleanedSessions = cleanupAgentSessionFolders(60 * 60 * 1000);

        return {
          content: [{
            type: "text",
            text: `Team ${teamName} shut down.${cleanedSessions > 0 ? ` Cleaned up ${cleanedSessions} orphaned agent session folder(s).` : ""}`
          }],
          details: { cleanedSessions }
        };
      } catch (e) {
        throw new Error(`Failed to shutdown team: ${e}`);
      }
    },
  });

  pi.registerTool({
    name: "cleanup_agent_sessions",
    label: "Cleanup Agent Sessions",
    description: "Clean up orphaned agent session folders from ~/.pi/agent/teams/ that are older than a specified age.",
    parameters: Type.Object({
      max_age_hours: Type.Optional(Type.Number()),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const maxAgeHours = params.max_age_hours ?? 24;
      const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
      const cleaned = cleanupAgentSessionFolders(maxAgeMs);
      return {
        content: [{
          type: "text",
          text: `Cleaned up ${cleaned} orphaned agent session folder(s) older than ${maxAgeHours} hour(s).`
        }],
        details: { cleaned, maxAgeHours }
      };
    },
  });

  pi.registerTool({
    name: "task_read",
    label: "Read Task",
    description: "Read details of a specific task.",
    parameters: Type.Object({
      team_name: Type.String(),
      task_id: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const task = await tasks.readTask(params.team_name, params.task_id);
      return {
        content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
        details: { task },
      };
    },
  });

  pi.registerTool({
    name: "check_teammate",
    label: "Check Teammate",
    description: "Check a single teammate's status.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const config = await teams.readConfig(params.team_name);
      const member = config.members.find(m => m.name === params.agent_name);
      if (!member) throw new Error(`Teammate ${params.agent_name} not found`);

      const unreadCount = (await messaging.readInbox(params.team_name, params.agent_name, true, false)).length;
      const runtimeStatus = await runtime.readRuntimeStatus(params.team_name, params.agent_name);
      const now = Date.now();
      const hasRecentHeartbeat = !!runtimeStatus?.lastHeartbeatAt
        && (now - runtimeStatus.lastHeartbeatAt) <= runtime.HEARTBEAT_STALE_MS;

      let alive = false;
      if (member.role === "read") {
        alive = runningReadAgents.has(readAgentKey(params.team_name, member.name)) || (!!runtimeStatus && hasRecentHeartbeat && member.isActive !== false);
      } else if (member.tmuxPaneId && terminal) {
        alive = terminal.isAlive(member.tmuxPaneId);
      }
      const startupStalled = alive
        && unreadCount > 0
        && (now - member.joinedAt) > runtime.STARTUP_STALL_MS
        && !(runtimeStatus?.ready);
      const health = !alive
        ? "dead"
        : startupStalled
          ? "stalled"
          : runtimeStatus?.ready
            ? (hasRecentHeartbeat ? "healthy" : "idle")
            : "starting";

      const releasedClaims = !alive
        ? await releaseAllClaimsForAgent(params.team_name, params.agent_name)
        : [];

      const details = {
        agentName: params.agent_name,
        alive,
        unreadCount,
        health,
        agentLoopReady: !!runtimeStatus?.ready,
        hasRecentHeartbeat,
        startupStalled,
        runtime: runtimeStatus,
        releasedClaims,
      };

      // Clean up runtime status and stale claims for dead teammates
      if (!alive && runtimeStatus) {
        await runtime.deleteRuntimeStatus(params.team_name, params.agent_name);
      }

      return {
        content: [{ type: "text", text: formatTeammateStatusForModel(params.agent_name, details) }],
        details,
      };
    },
    renderResult(result, { expanded }, theme) {
      return renderTeammateStatus(result, expanded, theme);
    },
  });

  pi.registerTool({
    name: "process_shutdown_approved",
    label: "Process Shutdown Approved",
    description: "Process a teammate's shutdown.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.String(),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const config = await teams.readConfig(params.team_name);
      const member = config.members.find(m => m.name === params.agent_name);
      if (!member) throw new Error(`Teammate ${params.agent_name} not found`);

      await shutdownTeammate(params.team_name, member);
      return {
        content: [{ type: "text", text: `Teammate ${params.agent_name} has been shut down.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "list_predefined_teams",
    label: "List Predefined Teams",
    description: "List all available predefined team configurations from teams.yaml files. These are team templates that can be instantiated with create_predefined_team.",
    parameters: Type.Object({}),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const projectDir = ctx.cwd;
      const predefinedTeams = predefined.getAllPredefinedTeams(projectDir);
      const agents = predefined.getAllAgentDefinitions(projectDir);
      
      const result = predefinedTeams.map(team => {
        const teamAgents = team.agents.map(agentName => {
          const agentDef = agents.find(a => a.name === agentName);
          return {
            name: agentName,
            description: agentDef?.description || "(agent definition not found)",
            found: !!agentDef,
          };
        });
        
        return {
          name: team.name,
          agents: teamAgents,
        };
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { teams: result },
      };
    },
  });

  pi.registerTool({
    name: "list_predefined_agents",
    label: "List Predefined Agents",
    description: "List all available predefined agent definitions from .md files. These can be used individually or as part of predefined teams.",
    parameters: Type.Object({}),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const projectDir = ctx.cwd;
      const agents = predefined.getAllAgentDefinitions(projectDir);
      
      const result = agents.map(agent => ({
        name: agent.name,
        description: agent.description,
        tools: agent.tools,
        model: agent.model,
        thinking: agent.thinking,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { agents: result },
      };
    },
  });

  pi.registerTool({
    name: "create_predefined_team",
    label: "Create Predefined Team",
    description: "Create a team from a predefined team configuration. Any default_model you pass must be a fully qualified provider/model string from list_available_models. If omitted, the current active model is used. Agent definitions with models must also already be fully qualified.",
    parameters: Type.Object({
      team_name: Type.String({ description: "Name for the new team instance" }),
      predefined_team: Type.String({ description: "Name of the predefined team template from teams.yaml" }),
      cwd: Type.String({ description: "Working directory for spawned agents" }),
      default_model: Type.Optional(Type.String({ description: "Fully qualified default model (provider/model) for agents without a specified model. Use list_available_models first. If omitted, the current active model is used." })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const projectDir = ctx.cwd;
      const predefinedTeam = predefined.getPredefinedTeam(params.predefined_team, projectDir);
      
      if (!predefinedTeam) {
        const available = predefined.getAllPredefinedTeams(projectDir).map(t => t.name);
        throw new Error(`Predefined team "${params.predefined_team}" not found. Available teams: ${available.join(", ") || "none"}`);
      }

      if (!terminal) {
        throw new Error("pi-extended-teams requires running inside tmux.");
      }

      const { availableModels } = await getModelSelectionState(ctx, ctx.cwd);
      const explicitDefaultModel = requireQualifiedKnownModel(params.default_model, availableModels, "default_model");
      const currentModel = requireQualifiedKnownModel(getCurrentQualifiedModel(ctx), availableModels, "current model");
      const defaultModel = explicitDefaultModel || currentModel;
      const allowedExtensions = resolveAllowedExtensions(loadSettings({ projectDir: ctx.cwd }));

      // Create the team
      const config = teams.createTeam(params.team_name, "local-session", "lead-agent", `Predefined team: ${params.predefined_team}`, defaultModel);
      adoptTeamAsLead(paths.sanitizeName(params.team_name));

      const agentDefinitions = predefined.getAllAgentDefinitions(projectDir);
      const spawnResults: Array<{ name: string; status: string; error?: string }> = [];

      // Spawn each agent in the predefined team
      for (const agentName of predefinedTeam.agents) {
        const agentDef = agentDefinitions.find(a => a.name === agentName);
        
        if (!agentDef) {
          spawnResults.push({ name: agentName, status: "skipped", error: "Agent definition not found" });
          continue;
        }

        try {
          const safeName = paths.sanitizeName(agentName);
          const safeTeamName = paths.sanitizeName(params.team_name);
          
          const agentModel = requireQualifiedKnownModel(agentDef.model, availableModels, `model for predefined agent \"${agentName}\"`);
          const chosenModel = agentModel || defaultModel || config.defaultModel;

          if (!chosenModel) {
            throw new Error(
              `No model specified for predefined agent \"${agentName}\". Add a fully qualified model to the agent definition or pass a fully qualified default_model.`
            );
          }

          const member: Member = {
            agentId: `${safeName}@${safeTeamName}`,
            name: safeName,
            agentType: "teammate",
            role: "write",
            model: chosenModel,
            joinedAt: Date.now(),
            tmuxPaneId: "",
            cwd: params.cwd,
            subscriptions: [],
            prompt: agentDef.prompt,
            color: "blue",
            thinking: agentDef.thinking,
          };

          await teams.addMember(safeTeamName, member);
          await messaging.sendPlainMessage(safeTeamName, "team-lead", safeName, agentDef.prompt, "Initial prompt from predefined team");

          const piBinary = getPiLaunchCommand();
          const piCmd = buildPiCommand(piBinary, chosenModel, agentDef.thinking, allowedExtensions);

          const env: Record<string, string> = {
            ...process.env,
            PI_TEAM_NAME: safeTeamName,
            PI_AGENT_NAME: safeName,
          };

          let terminalId = "";

          try {
            const leadMember = (await teams.readConfig(safeTeamName)).members.find(m => m.name === "team-lead");
            const anchorPaneId = leadMember?.tmuxPaneId || process.env.TMUX_PANE || undefined;

            terminalId = terminal.spawn({
              name: safeName,
              cwd: params.cwd,
              command: piCmd,
              env: env,
              anchorPaneId,
            });
            await teams.updateMember(safeTeamName, safeName, { tmuxPaneId: terminalId });

            spawnResults.push({ name: agentName, status: "spawned", error: undefined });
          } catch (e) {
            spawnResults.push({ name: agentName, status: "error", error: `Failed to spawn: ${e}` });
          }
        } catch (e) {
          spawnResults.push({ name: agentName, status: "error", error: String(e) });
        }
      }

      const summary = spawnResults.map(r => `${r.name}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join("\n");
      
      return {
        content: [{ type: "text", text: `Team "${params.team_name}" created from predefined team "${params.predefined_team}".\n\nAgent spawn results:\n${summary}` }],
        details: { teamName: params.team_name, predefinedTeam: params.predefined_team, results: spawnResults },
      };
    },
  });

  pi.registerTool({
    name: "save_team_as_template",
    label: "Save Team as Template",
    description: "Save a runtime team as a reusable predefined team template. Creates agent definition files and updates teams.yaml. Use this when you've created a team with custom prompts and want to reuse it later.",
    parameters: Type.Object({
      team_name: Type.String({ description: "Name of the runtime team to save" }),
      template_name: Type.String({ description: "Name for the template (e.g., 'modularization', 'frontend-team')" }),
      description: Type.Optional(Type.String({ description: "Description for the template" })),
      scope: Type.Optional(StringEnum(["user", "project"], { description: "Where to save: 'user' for global (~/.pi), 'project' for project-local (.pi). Defaults to 'user'." })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const teamName = params.team_name;
      
      // Verify the team exists
      if (!teams.teamExists(teamName)) {
        throw new Error(`Team "${teamName}" does not exist. Use list_runtime_teams to see available teams.`);
      }

      // Read the team configuration
      const config = await teams.readConfig(teamName);
      
      // Check that there are teammates to save
      const teammates = config.members.filter(m => m.agentType === "teammate");
      if (teammates.length === 0) {
        throw new Error(`Team "${teamName}" has no teammates to save. Only teams with spawned teammates can be saved as templates.`);
      }

      // Save the team as a template
      const result = predefined.saveTeamTemplate(config, {
        templateName: params.template_name,
        description: params.description,
        scope: params.scope || "user",
        projectDir: ctx.cwd,
      });

      // Build summary message
      const agentSummary = result.savedAgents.map(a => 
        `  - ${a.name}: ${a.existed ? "updated" : "created"} at ${a.path}`
      ).join("\n");
      
      const message = `Team "${teamName}" saved as template "${params.template_name}".

Agents saved:
${agentSummary}

Template location: ${result.teamsYamlPath}

You can now use this template with:
  create_predefined_team({ team_name: "new-team", predefined_team: "${params.template_name}", cwd: "..." })`;

      return {
        content: [{ type: "text", text: message }],
        details: {
          teamName,
          templateName: params.template_name,
          agentsDir: result.agentsDir,
          teamsYamlPath: result.teamsYamlPath,
          savedAgents: result.savedAgents,
          templateExisted: result.templateExisted,
        },
      };
    },
  });

  pi.registerTool({
    name: "list_runtime_teams",
    label: "List Runtime Teams",
    description: "List all runtime team configurations that can be saved as templates. These are active or saved teams from ~/.pi/teams/.",
    parameters: Type.Object({}),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const runtimeTeams = predefined.listRuntimeTeams();
      
      if (runtimeTeams.length === 0) {
        return {
          content: [{ type: "text", text: "No runtime teams found. Create a team with team_create first." }],
          details: { teams: [] },
        };
      }

      const result = runtimeTeams.map(team => ({
        name: team.name,
        description: team.description,
        memberCount: team.memberCount,
        createdAt: team.createdAt ? new Date(team.createdAt).toISOString() : undefined,
      }));

      const summary = result.map(t => 
        `- ${t.name}: ${t.memberCount} teammate(s)${t.description ? ` - ${t.description}` : ""}`
      ).join("\n");

      return {
        content: [{ type: "text", text: `Runtime teams:\n${summary}` }],
        details: { teams: result },
      };
    },
  });
}
