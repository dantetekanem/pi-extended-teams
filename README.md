# pi-extended-teams

**pi-extended-teams** multiplies a single Pi session with helper agents while keeping the main agent in charge. Read agents run in-process for parallel investigation, review, and tests. Write agents are opt-in, background tmux screens for isolated edit work.

This package is intentionally narrower than the original pi-teams: tmux is the only supported write-agent screen backend, read agents do not open tmux screens, and the preferred flow is one-call team creation with automatic report delivery.

> **tmux is required only for write agents.** Read agents run in-process and work without opening tmux screens.

## Installation

Install directly from GitHub:

```bash
pi install git:github.com/dantetekanem/pi-extended-teams
```

Install from a local checkout while developing:

```bash
pi install /absolute/path/to/pi-extended-teams
```

To use write agents, start Pi inside a tmux session:

```bash
tmux
pi
```

## Quick Start

Usually you just describe the work and the lead does the rest. A team can be created with inline read agents, they run in parallel, and their reports come back to the main session automatically.

```text
Review the current changes with a couple of agents and summarize the findings.
```

Equivalent explicit shape:

```text
Create a team "review" with agents:
- git-check: inspect diffs and report risks
- test-gaps: find missing coverage
```

Watch active and completed agents:

```bash
/team
```

Spawn a write agent only when the work is isolated and safe to run in a background tmux screen:

```text
Spawn a write agent to fix only the typos in docs/guide.md.
```

## Core Features

- **One-call teams**: `team_create` can create a team and start inline agents immediately.
- **Read agents as the default multiplier**: in-process, parallel, full read/test/search tool access, directed to report without editing.
- **Auto-delivered reports**: finished read agents report back to the main session as collapsed entries that the lead can synthesize.
- **`/team` overlay**: inspect the lead view, active read agents, background write-agent screens, completed reports, models, thinking levels, tasks, and claims.
- **Writer screen cycling**: write agents spawn in detached tmux windows by default; press Alt/Option+Tab to cycle main + writer screens, or press Enter/a on a writer in `/team` to attach live.
- **Write-agent queue**: write agents are opt-in, capped, queued, and tmux-backed.
- **Advisory file claims**: write agents coordinate file ownership with `claim_file`, `release_file`, and `list_file_claims`.
- **Teammate messaging**: send direct messages, broadcasts, and inbox reports between team members.
- **Shared task board**: create, assign, plan, approve, update, and list team tasks.
- **Plan approval mode**: require a teammate to submit a plan before it starts implementation.
- **Model and thinking selection**: use fully qualified `provider/model` strings and optional thinking levels.
- **Watchdog cleanup**: stale teammate runtime state and dead write-agent screens are cleaned up.

## Supported Workflow

Use pi-extended-teams for parallel read-only investigation first, then add write agents only when the edit is isolated.

Good fits:

- Review a diff from several angles.
- Run independent test suites in parallel.
- Validate a refactor with separate static, focused-test, full-suite, and smoke lanes.
- Ask one agent to inspect architecture while another checks test coverage.
- Spawn a write agent for a narrow, non-overlapping file change.

Avoid:

- Treating write agents as the default path.
- Spawning multiple write agents for the same files.
- Using non-tmux backends for write agents.

## Common Examples

### List models

```text
List available models for team creation.
```

Models must be fully qualified, for example:

```text
openai-codex/gpt-5.5
```

### Create a team with read agents

```text
Create a team named "repo-review" with agents:
- architecture: review module boundaries and coupling
- tests: run focused tests and report failures
- docs: check README accuracy
```

### Spawn a teammate

```text
Spawn a teammate named "security-bot" in the current folder. Tell it to scan for hardcoded API keys.
```

### Promote a read agent into a write pane

```text
Move teammate "docs-bot" into a background tmux screen with the same mission.
```

### Use plan approval

```text
Spawn a teammate named "refactor-bot" and require plan approval before it makes changes.
```

### Work with tasks

```text
Create a task for security-bot: "Check the .env.example file for sensitive defaults".
```

```text
Review refactor-bot's plan for task 5. Approve it if it has enough test coverage, otherwise reject it with feedback.
```

### Send team messages

```text
Broadcast to the entire team: "The API endpoint has changed to /v2. Please update your work accordingly."
```

### Shut down

```text
Shut down team "repo-review".
```

## Configuration

Model-list ordering can be configured globally with `~/.pi/pi-extended-teams.json` or per project with `.pi/pi-extended-teams.json`.

```json
{
  "providerPriority": [
    "openai-codex",
    "claude-agent-sdk",
    "kimi-coding"
  ]
}
```

Project-local config overrides global config.

Pi model settings still come from Pi settings (`defaultProvider`, `defaultModel`, and `enabledModels`). The extension combines those settings with the available model registry and reports fully qualified model names through `list_available_models`.

## Terminal Requirements

Write agents require tmux because they run in separate background screens. Read agents run in-process.

Install tmux:

- macOS: `brew install tmux`
- Linux: `sudo apt install tmux`

Run Pi inside tmux when you want write agents:

```bash
tmux
pi
```

## Development

Use direct local binaries when pnpm script execution is blocked by ignored build-script policy:

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
```

Useful checks:

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run extensions/internal/pi-command.test.ts extensions/ui-frame.test.ts extensions/index.test.ts
./node_modules/.bin/vitest run
rg --files -g '*.ts' -g '!node_modules' | xargs wc -l | awk '$2 != "total" && $1 > 500 {print}'
```

The current source layout keeps TypeScript files under 500 lines. `extensions/index.ts` is a composition root; behavior lives in focused modules under `extensions/agents`, `extensions/events`, `extensions/internal`, `extensions/team`, `extensions/tools`, `extensions/ui`, and `extensions/runtime`.

## Learn More

- [Full Usage Guide](docs/guide.md)
- [Tool Reference](docs/reference.md)

## Credits & Attribution

pi-extended-teams is based on the original [pi-teams](https://github.com/burggraf/pi-teams) project and keeps a narrower tmux-first contract for this fork.

The broader team-agent coordination lineage also includes [claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp) by [cs50victor](https://github.com/cs50victor).

## License

MIT
