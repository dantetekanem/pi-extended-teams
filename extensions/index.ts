import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
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
  name: string;
  teamName: string;
  startedAt: number;
  tokensUsed: number;
  status: "starting" | "running" | "finishing";
  recentEvents: string[];
  session?: AgentSession;
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

function getLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
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

function isDownInput(data: string): boolean {
  return matchesKey(data, Key.down) || data === "\x1b[B" || data === "j" || data === "J" || data === "\x0e";
}

function isUpInput(data: string): boolean {
  return matchesKey(data, Key.up) || data === "\x1b[A" || data === "k" || data === "K" || data === "\x10";
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
  let readAgentStatusTimer: NodeJS.Timeout | null = null;
  let leadInboxUnreadCount = 0;
  let writeQueueDraining = false;
  let leadWatchdogStarted = false;

  function wakeLeadForInboxReports(unread: any[]): void {
    if (!teamName || unread.length === 0 || !sessionCtx?.isIdle?.()) return;

    const reportText = unread.length === 1 ? "1 unread team report is" : `${unread.length} unread team reports are`;
    pi.sendUserMessage(
      `${reportText} ready for ${teamName}. Read the lead inbox, process blockers/final reports, update team tasks and ADA if relevant, and shut down completed teammates. Do not use sleeps or ad hoc polling loops.`
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

    sessionCtx.ui.setStatus?.("01-pi-extended-teams-read", undefined);
    const lines = [pink(`▣ read agents running (${agents.length})  /team`)];
    for (const agent of agents.sort((a, b) => a.name.localeCompare(b.name))) {
      const elapsed = formatElapsed(Date.now() - agent.startedAt);
      const lastEvent = agent.recentEvents.at(-1)?.replace(/^\S+\s+/, "") || agent.status;
      lines.push(
        `${purple("  ├─")} ${pink(agent.name)} ${purple(agent.status)} ${dimAnsi(`${elapsed} · ${formatTokenCount(agent.tokensUsed)} tok · ${lastEvent}`)}`
      );
    }
    lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
    sessionCtx.ui.setWidget?.("01-pi-extended-teams-readers", lines, { placement: "belowEditor" });
  }

  function ensureReadAgentStatusTicker() {
    if (readAgentStatusTimer) return;
    readAgentStatusTimer = setInterval(renderReadAgentStatus, 1000);
    renderReadAgentStatus();
  }

  async function renderLeadInboxStatus() {
    if (!sessionCtx?.ui) return;
    if (leadInboxUnreadCount <= 0 || !teamName) {
      sessionCtx.ui.setStatus?.("02-pi-extended-teams-inbox", undefined);
      sessionCtx.ui.setWidget?.("02-pi-extended-teams-inbox", undefined);
      return;
    }

    sessionCtx.ui.setStatus?.("02-pi-extended-teams-inbox", undefined);
    const unread = await messaging.readInbox(teamName, agentName, true, false).catch(() => []);
    const lines = [pink(`▣ team reports ready (${unread.length})  read_inbox`)];
    for (const message of unread.slice(-5)) {
      const from = String(message.from || "unknown");
      const summary = String(message.summary || "message");
      lines.push(`${purple("  ├─")} ${pink(from)} ${dimAnsi(summary)}`);
    }
    if (unread.length > 5) lines.push(`${purple("  ├─")} ${dimAnsi(`${unread.length - 5} older unread report(s)`)}`);
    lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
    sessionCtx.ui.setWidget?.("02-pi-extended-teams-inbox", lines, { placement: "belowEditor" });
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
      const readState = runningReadAgents.get(member.name);
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
    const state: RunningReadAgent = {
      name: member.name,
      teamName: readTeamName,
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "starting",
      recentEvents: [],
    };
    runningReadAgents.set(member.name, state);
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
          `You are read-only teammate '${member.name}' on team '${readTeamName}'.`,
          "You run in-process in the lead session, not in a tmux pane.",
          "Use only read/search/listing tools. Do not write files, edit files, run commands, install packages, start services, commit, push, deploy, or broaden scope.",
          "When finished, answer with a concise final report for the team lead: summary, evidence, files inspected, risks, and next recommended action.",
        ],
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd: member.cwd,
        model,
        thinkingLevel: member.thinking as any,
        modelRegistry: ctx.modelRegistry,
        tools: ["read", "grep", "find", "ls"],
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

      const report = getLastAssistantText(session.messages) || "Read agent completed, but produced no assistant text.";
      await messaging.sendPlainMessage(
        readTeamName,
        member.name,
        "team-lead",
        report,
        `Read agent ${member.name} completed`,
        member.color
      );
      if (!isTeammate && teamName === readTeamName) {
        leadInboxUnreadCount = (await messaging.readInbox(readTeamName, agentName, true, false).catch(() => [])).length;
        await renderLeadInboxStatus();
        sessionCtx?.ui?.notify?.(`Read agent ${member.name} completed and reported back.`, "info");
      }
    } catch (e) {
      await messaging.sendPlainMessage(
        readTeamName,
        member.name,
        "team-lead",
        `Read agent ${member.name} failed: ${e instanceof Error ? e.message : String(e)}`,
        `Read agent ${member.name} failed`,
        "red"
      );
      if (!isTeammate && teamName === readTeamName) {
        leadInboxUnreadCount = (await messaging.readInbox(readTeamName, agentName, true, false).catch(() => [])).length;
        await renderLeadInboxStatus();
        sessionCtx?.ui?.notify?.(`Read agent ${member.name} failed and reported back.`, "warning");
      }
      try {
        await runtime.writeRuntimeStatus(readTeamName, member.name, {
          lastHeartbeatAt: Date.now(),
          lastError: runtime.createRuntimeError(e),
        });
      } catch {
        // Ignore runtime cleanup races.
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try {
        if (state.session?.isStreaming) {
          await state.session.abort();
        }
      } catch {
        // Ignore abort errors after normal completion.
      }
      state.session?.dispose();
      runningReadAgents.delete(member.name);
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
          if (unread.length !== leadInboxUnreadCount) {
            const previousUnreadCount = leadInboxUnreadCount;
            leadInboxUnreadCount = unread.length;
            await renderLeadInboxStatus();
            if (unread.length > previousUnreadCount) {
              wakeLeadForInboxReports(unread);
            }
          }
        } catch {
          // Ignore errors for lead polling
        }
      }
    }, 30000);
  }

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
        pi.sendUserMessage(`I am starting my work as '${agentName}' on team '${teamName}'. Checking my inbox for instructions...`);
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
                pi.sendUserMessage(`I have ${unread.length} new message(s) in my inbox. Reading them now...`);
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
      let fileClaimGuidance = "";
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
            fileClaimGuidance = `\n\nWrite-agent file-claim rules:\n- Before editing or writing any repository file, call claim_file with every path you intend to change and wait for the claim to be granted.\n- If claim_file reports conflicts, do not edit those files; coordinate with your lead instead. The owned task is marked blocked by that file claim.\n- Release claims with release_file as soon as you are done editing those paths.\n- Send your final report with report_and_exit; it releases any remaining file claims automatically before shutting you down.`;
          }
          rosterInfo = `\n\n${formatRosterForPrompt(await buildRoster(teamName))}\nUse list_teammates when you need an updated roster; do not poll check_teammate unless diagnosing liveness.`;
        } catch (e) {
          // Ignore
        }
      }

      return {
        systemPrompt: event.systemPrompt + `\n\nYou are teammate '${agentName}' on team '${teamName}'.\nYour lead is 'team-lead'.${modelInfo}${fileClaimGuidance}${rosterInfo}\nStart by calling read_inbox(team_name="${teamName}") to get your initial instructions.`,
      };
    }
  });

  async function killTeammate(teamName: string, member: Member) {
    if (member.name === "team-lead") return;

    await releaseAllClaimsForAgent(teamName, member.name);

    if (member.role === "read") {
      const state = runningReadAgents.get(member.name);
      if (state?.session) {
        try {
          await state.session.abort();
        } catch {
          // Ignore abort errors during shutdown.
        }
        state.session.dispose();
      }
      runningReadAgents.delete(member.name);
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
    await killTeammate(teamName, member);
    await teams.removeMember(teamName, member.name);
    await messaging.sendPlainMessage(
      teamName,
      "watchdog",
      "team-lead",
      `Reaped ${member.name}: ${reason}`,
      `Watchdog reaped ${member.name}`,
      "yellow"
    );
    if ((member.role ?? "write") === "write") {
      await drainWriteQueue(teamName);
    }
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
        if (runtimeStale && !runningReadAgents.has(member.name)) {
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
    const items = [] as Array<{
      name: string;
      role: string;
      status: string;
      unreadCount: number;
      elapsedMs: number;
      tokensUsed: number;
      taskSubjects: string[];
      claimPaths: string[];
      recentEvents: string[];
      runtimeStatus: any;
    }>;

    for (const member of config.members.filter((m) => m.name !== "team-lead")) {
      const readState = runningReadAgents.get(member.name);
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
        unreadCount,
        elapsedMs: Date.now() - startedAt,
        tokensUsed: readState?.tokensUsed || 0,
        taskSubjects: allTasks
          .filter((task: any) => task.owner === member.name && task.status !== "completed" && task.status !== "deleted")
          .map((task: any) => `#${task.id} ${task.subject}`),
        claimPaths: allClaims.filter((claim) => claim.agent === member.name).map((claim) => claim.path),
        recentEvents: readState?.recentEvents || [],
        runtimeStatus,
      });
    }

    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Commands
  pi.registerCommand("team", {
    description: "Open the pi-extended-teams teammate overview.",
    handler: async (args, ctx) => {
      const panelTeamName = args.trim() || teamName;
      if (!panelTeamName) {
        ctx.ui.notify("No current team. Pass a team name: /team <name>", "warning");
        return;
      }

      let items = await buildTeamPanelItems(panelTeamName);
      let selectedIndex = 0;
      let loading = false;

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const refresh = () => {
          loading = true;
          tui.requestRender();
          void buildTeamPanelItems(panelTeamName)
            .then((nextItems) => {
              items = nextItems;
              selectedIndex = Math.min(selectedIndex, Math.max(0, items.length - 1));
            })
            .finally(() => {
              loading = false;
              tui.requestRender();
            });
        };

        const render = (width: number): string[] => {
          const usable = Math.max(50, width - 2);
          const lines: string[] = [];
          lines.push(pink(`▣ team ${panelTeamName}`));
          lines.push(dimAnsi("↑/↓ or j/k: select   r: refresh   esc: close"));
          if (loading) lines.push(purple("refreshing…"));
          lines.push("");

          if (items.length === 0) {
            lines.push(dimAnsi("No teammates."));
            return lines.map((line) => truncateToWidth(line, usable));
          }

          lines.push(purple("agents"));
          for (const [index, item] of items.entries()) {
            const selected = index === selectedIndex;
            const pointer = selected ? pink("▸") : dimAnsi(" ");
            const role = item.role === "read" ? pink("read") : purple("write");
            const health = item.status.includes("dead") ? "dead" : item.status;
            const row = `${pointer} ${selected ? pink(item.name) : item.name}  ${role}  ${health}  ${formatElapsed(item.elapsedMs)}  inbox:${item.unreadCount}`;
            lines.push(row);
          }

          const item = items[selectedIndex];
          lines.push("");
          lines.push(pink(`inspect ${item.name}`));
          lines.push(`${purple("role")}       ${item.role}`);
          lines.push(`${purple("status")}     ${item.status}`);
          lines.push(`${purple("elapsed")}    ${formatElapsed(item.elapsedMs)}`);
          lines.push(`${purple("tokens")}     ${formatTokenCount(item.tokensUsed)}`);
          lines.push(`${purple("inbox")}      ${item.unreadCount} unread`);
          if (item.taskSubjects.length > 0) {
            lines.push(purple("tasks"));
            for (const task of item.taskSubjects.slice(0, 6)) lines.push(`  ${task}`);
          }
          if (item.claimPaths.length > 0) {
            lines.push(purple("claims"));
            for (const claim of item.claimPaths.slice(0, 6)) lines.push(`  ${claim}`);
          }
          if (item.recentEvents.length > 0) {
            lines.push(purple("recent"));
            for (const event of item.recentEvents.slice(-10)) lines.push(`  ${event}`);
          }
          if (item.runtimeStatus?.lastError?.message) {
            lines.push(`${purple("last error")} ${item.runtimeStatus.lastError.message}`);
          }

          return lines.map((line) => truncateToWidth(line, usable));
        };

        return {
          render,
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q" || data === "Q") {
              done();
              return;
            }
            if (isDownInput(data)) {
              selectedIndex = Math.min(items.length - 1, selectedIndex + 1);
              tui.requestRender();
              return;
            }
            if (isUpInput(data)) {
              selectedIndex = Math.max(0, selectedIndex - 1);
              tui.requestRender();
              return;
            }
            if (data === "r" || data === "R") {
              refresh();
            }
          },
        };
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

  pi.registerTool({
    name: "team_create",
    label: "Create Team",
    description: "Create a new agent team. If you specify default_model, it must be a fully qualified provider/model string from list_available_models. If omitted, the current active model is used.",
    parameters: Type.Object({
      team_name: Type.String(),
      description: Type.Optional(Type.String()),
      default_model: Type.Optional(Type.String({ description: "Fully qualified default model (provider/model). Use list_available_models first. If omitted, the current active model is used." })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const { availableModels } = await getModelSelectionState(ctx, ctx.cwd);
      const explicitDefaultModel = requireQualifiedKnownModel(params.default_model, availableModels, "default_model");
      const currentModel = requireQualifiedKnownModel(getCurrentQualifiedModel(ctx), availableModels, "current model");
      const defaultModel = explicitDefaultModel || currentModel;

      // Auto-cleanup stale team if the previous lead process is dead
      // This handles the case where a session was aborted and restarted
      if (teams.teamExists(params.team_name)) {
        cleanupStaleTeam(params.team_name, terminal);
      }

      const config = teams.createTeam(params.team_name, "local-session", "lead-agent", params.description, defaultModel);
      // Register this session as the lead so it can receive inbox messages
      registerLeadSession(params.team_name);
      // Update teamName and start quiet background maintenance for the lead
      teamName = params.team_name;
      startLeadInboxPolling();
      startLeadWatchdog();
      return {
        content: [{ type: "text", text: `Team ${params.team_name} created.` }],
        details: { config },
      };
    },
  });

  pi.registerTool({
    name: "spawn_teammate",
    label: "Spawn Teammate",
    description: "Spawn a new teammate in a tmux pane. Set role to 'write' (default, can edit files) or 'read' (read-only investigation). Model resolves from explicit arg -> category -> role default -> team default -> current model, using settings.json. Any explicit model must be a fully qualified provider/model from list_available_models.",
    parameters: Type.Object({
      team_name: Type.String(),
      name: Type.String(),
      prompt: Type.String(),
      cwd: Type.String(),
      role: Type.Optional(StringEnum(["read", "write"], { description: "Agent role. 'write' agents spawn in tmux and can edit files (default). 'read' agents are read-only. Defaults to 'write'." })),
      category: Type.Optional(Type.String({ description: "Optional category preset name from settings.json (bundles role + model + thinking)." })),
      model: Type.Optional(Type.String({ description: "Fully qualified model (provider/model). Use list_available_models first. If omitted, the category/role/team default or current model is used." })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"])),
      plan_mode_required: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const safeName = paths.sanitizeName(params.name);
      const safeTeamName = paths.sanitizeName(params.team_name);

      if (!teams.teamExists(safeTeamName)) {
        throw new Error(`Team ${params.team_name} does not exist`);
      }

      const teamConfig = await teams.readConfig(safeTeamName);

      // Check if a teammate with this name already exists - kill them first
      // This handles the case where the user aborts mid-execution and restarts
      const existingMember = teamConfig.members.find(m => m.name === safeName && m.agentType === "teammate");
      if (existingMember) {
        await killTeammate(safeTeamName, existingMember);
        await teams.removeMember(safeTeamName, safeName);
      }

      const settings = loadSettings({ projectDir: ctx.cwd });
      const role: AgentRole = resolveRole(settings, params.role ?? "write", params.category);

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
        cwd: params.cwd,
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
          content: [{ type: "text", text: `Read teammate ${params.name} started in-process. No tmux pane was created.` }],
          details: { agentId: member.agentId, mode: "in-process", terminalId: null },
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
          cwd: params.cwd,
          category: params.category,
          model: chosenModel,
          thinking: chosenThinking,
          planModeRequired: params.plan_mode_required,
          color: "blue",
        });
        const queuedItems = await writeQueue.listWriteQueue(safeTeamName);
        return {
          content: [{ type: "text", text: `Write teammate ${params.name} queued at position ${queuedItems.findIndex(item => item.id === queued.id) + 1}; capacity is ${activeWriteCount}/${settings.writeAgents.maxConcurrent}.` }],
          details: { agentId: member.agentId, queued: true, queueId: queued.id, queuePosition: queuedItems.findIndex(item => item.id === queued.id) + 1 },
        };
      }

      const terminalId = await startWriteAgent(safeTeamName, member, params.prompt);

      return {
        content: [{ type: "text", text: `Teammate ${params.name} spawned in pane ${terminalId}.` }],
        details: { agentId: member.agentId, terminalId, queued: false },
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
        leadInboxUnreadCount = 0;
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
          await killTeammate(teamName, member);
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
        alive = runningReadAgents.has(member.name) || (!!runtimeStatus && hasRecentHeartbeat && member.isActive !== false);
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

      await killTeammate(params.team_name, member);
      await teams.removeMember(params.team_name, params.agent_name);
      await drainWriteQueue(params.team_name);
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
      registerLeadSession(params.team_name);
      // Update teamName and start inbox polling for the lead
      teamName = params.team_name;
      startLeadInboxPolling();

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
