# pi-extended-teams 🚀

**pi-extended-teams** multiplies a single Pi session with helper agents. The **main agent stays the implementer** and keeps doing the real work; **read agents** run in-process to investigate, review, and test in parallel (unlimited, full toolset, directed read-only) and report straight back to the main window; **write agents** are an opt-in for isolated, independent edit work in **tmux** panes — with file-write coordination, a 3-writer cap, a watchdog that reaps anything stale, and agents that clean themselves up when their work is reported back.

> **tmux is the only supported backend for write agents.** Read agents run in-process and do not open panes.

### 🖥️ pi-extended-teams in Action

<a href="tmux.png"><img src="tmux.png" width="420" alt="pi-extended-teams in tmux"></a>

## 🛠 Installation

Install pi-extended-teams directly from GitHub:

```bash
pi install git:github.com/dantetekanem/pi-extended-teams
```

You can also install from a local checkout while developing:

```bash
pi install /absolute/path/to/pi-extended-teams
```

To use write agents after installation, launch Pi inside a **tmux** session.

## 🚀 Quick Start

Usually you just describe the work and the lead does the rest — one call creates
the team and spawns its agents, they run, and their reports come back collapsed in
your main window for the lead to synthesize. No manual tasks, polling, or inbox
reading.

```bash
# Investigate / review in parallel (read agents, the default)
"Review the current changes with a couple of agents and summarize the findings."

# Equivalent explicit one-call form the lead uses under the hood:
"Create a team 'review' with agents: git-check (inspect diffs, report risks) and
 test-gaps (find missing coverage)."

# Watch them live (floating overlay; ↑/↓ to switch views)
/team

# Opt in to a write agent only for isolated, independent edit work
"Spawn a write agent to fix only the typos in docs/guide.md."
```

## 🌟 What can it do?

### Core Features
- **One-call teams**: `team_create` with inline `agents` creates the team and spawns them running — no separate task/spawn ceremony.
- **Read agents as the multiplier**: in-process, unlimited, parallel, with the full toolset (read, run commands, search) but directed to investigate and report rather than edit.
- **Auto-delivered reports**: each finished agent's report lands in the main window as a collapsed one-line entry (name · elapsed · tokens, `ctrl+o` to expand) and the lead synthesizes it automatically — no polling, no inbox reading.
- **Floating `/team` view**: switch between the main session and each agent (↑/↓); read agents show their live transcript with model and thinking level, write agents point to their pane. Renders as an overlay that floats over a streaming session without flicker.
- **Move to a pane**: `promote_teammate` moves a running read agent into its own tmux pane to watch or interact with it.
- **Write-Agent Queue**: write agents are opt-in for isolated work; at most 3 run by default and overflow is queued, starting when a slot frees.
- **Advisory File Claims**: write agents coordinate file ownership through `claim_file`, `release_file`, and `list_file_claims`. Claims are lock-protected protocol state, not filesystem sandbox enforcement; cooperative agents must claim before editing.
- **No sleeps or polling**: the extension watches the lead inbox while idle and wakes the lead when results are ready.

### Advanced Features
- **Predefined Teams**: Define team templates in `teams.yaml` and spawn entire teams with a single command.
- **Save Teams as Templates**: Convert any runtime team into a reusable template with a single command.
- **Persistent Pane Titles**: Write-agent panes are automatically titled `[team-name]: [agent-name]` for easy identification.
- **Plan Approval Mode**: Require teammates to submit their implementation plans for your approval before they touch any code.
- **Broadcast Messaging**: Send a message to the entire team at once for global coordination and announcements.
- **Quality Gate Hooks**: Automated shell scripts run when tasks are completed (e.g., to run tests or linting).
- **Thinking Level Control**: Set per-teammate thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) to balance speed vs. reasoning depth.

## 💬 Key Examples

### 1. Start a Team
> **You:** "List available models for team creation, then create a team named 'my-app-audit' using 'openai-codex/gpt-5.4' for reviewing the codebase."

**Set a default model for the whole team:**
> **You:** "List available models for team creation, then create a team named 'Research' using 'openai-codex/gpt-5.4' for everyone."

### 2. Spawn Teammate with Custom Settings
> **You:** "Spawn a teammate named 'security-bot' using 'openai-codex/gpt-5.4' in the current folder. Tell them to scan for hardcoded API keys."

**Use a different model:**
> **You:** "List available models for team creation, then spawn a teammate named 'speed-bot' using 'claude-agent-sdk/claude-sonnet-4-6' to quickly run some benchmarks."

**Require plan approval:**
> **You:** "Spawn a teammate named 'refactor-bot' and require plan approval before they make any changes."

**Customize model and thinking level:**
> **You:** "List available models for team creation, then spawn a teammate named 'architect-bot' using 'openai-codex/gpt-5.4' with 'high' thinking level for deep reasoning."

**Explicit model selection:**
pi-extended-teams does **not** auto-resolve bare model names like `gpt-5` or `haiku`.
When creating a new team or spawning teammates, use `list_available_models` first and then pass a fully qualified `provider/model` string.

If you provide a model that is not fully qualified or not available, pi-extended-teams will fail fast and ask you to choose a valid model.

**Configuring model-list ordering:**
You can customize the order shown by `list_available_models` globally with `~/.pi/pi-extended-teams.json` or per-project with `.pi/pi-extended-teams.json`.
Project-local config overrides global config.

```json
{
  "providerPriority": [
    "openai-codex",
    "claude-agent-sdk",
    "kimi-coding"
  ]
}
```

- `providerPriority`: Controls the ordering shown by `list_available_models` after pi's preferred models are listed first.
- Preferred models themselves come from pi settings (`defaultProvider`, `defaultModel`, and `enabledModels`).

### 3. Assign Task & Get Approval
> **You:** "Create a task for security-bot: 'Check the .env.example file for sensitive defaults' and set it to in_progress."

Teammates in `planning` mode will use `task_submit_plan`. As the lead, review their work:
> **You:** "Review refactor-bot's plan for task 5. If it looks good, approve it. If not, reject it with feedback on the test coverage."

### 4. Broadcast to Team
> **You:** "Broadcast to the entire team: 'The API endpoint has changed to /v2. Please update your work accordingly.'"

### 5. Shut Down Team
> **You:** "We're done. Shut down the team and close the panes."

**Automatic Cleanup:**
When you shut down a team, pi-extended-teams automatically cleans up orphaned agent session folders from `~/.pi/agent/teams/` that are older than 1 hour. This prevents accumulation of stale session data over time.

**Manual Cleanup:**
If you need to clean up agent sessions without shutting down a team, or want to use a different age threshold:
> **You:** "Clean up agent session folders older than 24 hours."

---

## 🏗️ Predefined Teams

Predefined teams let you define reusable team templates in a `teams.yaml` file. This is perfect for common workflows where you always want the same set of specialists.

### Define Team Templates

Create `~/.pi/teams.yaml` (global) or `.pi/teams.yaml` in your project:

```yaml
# Full development team
full:
  - scout
  - planner
  - builder
  - reviewer
  - documenter

# Quick plan-build cycle
plan-build:
  - planner
  - builder
  - reviewer

# Research and documentation
research:
  - scout
  - documenter

# Frontend specialists
frontend:
  - planner
  - builder
  - bowser
```

### Define Agent Definitions

Create agent definitions in `~/.pi/agent/agents/` (global) or `.pi/agents/` (project-local):

**scout.md:**
```markdown
---
name: scout
description: Fast recon and codebase exploration
tools: read,grep,find,ls
---
You are a scout agent. Investigate the codebase quickly and report findings concisely. Do NOT modify any files. Focus on structure, patterns, and key entry points.
```

**builder.md:**
```markdown
---
name: builder
description: Implementation specialist
tools: read,write,edit,bash
model: claude-agent-sdk/claude-sonnet-4-6
thinking: medium
---
You are a builder agent. Implement code following the plan provided. Write clean, tested code.
```

**Agent Definition Fields:**
- `name` (required): The agent's name
- `description` (required): What the agent does
- `tools` (optional): Comma or space-separated list of allowed tools
- `model` (optional): Fully qualified model to use (e.g., `claude-agent-sdk/claude-sonnet-4-6`, `openai-codex/gpt-5.4`)
- `thinking` (optional): Thinking level (`off`, `minimal`, `low`, `medium`, `high`)

### Use Predefined Teams

**List available team templates:**
> **You:** "List all predefined teams I can use."

**List available agent definitions:**
> **You:** "Show me all predefined agents."

**Create a team from a template:**
> **You:** "Create a team named 'my-project' from the 'plan-build' predefined team in the current directory."

This single command:
1. Creates the team
2. Spawns all agents defined in the template
3. Each agent gets its predefined prompt, tools, model, and thinking settings

**With options:**
> **You:** "Create a team named 'big-team' from 'full' predefined team using 'openai-codex/gpt-5.4' as default model."

---

## 💾 Save Teams as Templates

Sometimes you create a team with custom prompts and settings that you'd like to reuse later. Instead of manually creating `teams.yaml` and agent definition files, you can save any runtime team as a template.

### The Workflow

```
CREATE → USE → SAVE → REUSE
```

1. **Create** a team with custom teammates and prompts
2. **Use** the team for your task
3. **Save** the team as a reusable template
4. **Reuse** the template later (even on different projects)

### List Runtime Teams

See which teams you have that can be saved:

> **You:** "List all runtime teams."

### Save a Team as a Template

> **You:** "Save team 'my-modularization-team' as template 'code-modularization'"

This creates:
- Agent definition files in `~/.pi/agent/agents/` for each teammate
- Updates `~/.pi/teams.yaml` with the new template

### Save to Project-Local Scope

To save a template that's specific to the current project:

> **You:** "Save team 'my-frontend-team' as template 'frontend-sprint' with scope 'project'"

This creates files in `.pi/agents/` and `.pi/teams.yaml` in the current project directory.

### Reuse Your Template

Once saved, use it just like any predefined team:

> **You:** "Create a team named 'auth-refactor' from the 'code-modularization' template in the current directory"

---

## 📚 Learn More

- **[Full Usage Guide](docs/guide.md)** - Detailed examples, hook system, best practices, and troubleshooting
- **[Tool Reference](docs/reference.md)** - Complete documentation of all tools and parameters

## 🪟 Terminal Requirements

**pi-extended-teams is tmux-only.** It spawns and manages teammate write agents
as tmux panes, and fails fast if `pi` is not launched inside a tmux session.

Install tmux:
- **macOS**: `brew install tmux`
- **Linux**: `sudo apt install tmux`

How to run:
```bash
tmux   # Start a tmux session
pi     # Start pi inside tmux
```

> Read agents run **in-process** (no tmux pane) and are surfaced in a compact
> status line and the `/team` overlay. Only write agents occupy panes.

## 📜 Credits & Attribution

This project adapts the coordination ideas from [claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp) by [cs50victor](https://github.com/cs50victor) into a native **Pi Package**.

pi-extended-teams adds role-aware read/write agents, in-process read agents, tmux-managed write panes, compact inbox status, `/team` overview, plan approval mode, broadcast messaging, quality gate hooks, advisory file-claim coordination, write-agent queueing, and watchdog cleanup.

## 📄 License
MIT
