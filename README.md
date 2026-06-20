# pi-extended-teams

**pi-extended-teams** multiplies a single Pi session with helper agents while keeping the main agent in charge. Agents run in-process so Pi can follow, track, and surface their reports without a separate setup ceremony.

The preferred workflow is simple: ask for agents, or call `spawn_agent` / `spawn_swarm_agents`. The current Pi session is the implicit agent group.

## Installation

Install directly from GitHub:

```bash
pi install git:github.com/dantetekanem/pi-extended-teams
```

Install from a local checkout while developing:

```bash
pi install /absolute/path/to/pi-extended-teams
```

## Quick start

Usually you just describe the work and the lead spawns agents when parallel coverage helps:

```text
Review the current changes with a couple of agents and summarize the findings.
```

Equivalent explicit shape:

```text
spawn_swarm_agents({
  defaults: { role: "read", thinking: "high" },
  agents: [
    { name: "git-check", prompt: "Inspect diffs and report risks." },
    { name: "test-gaps", prompt: "Find missing coverage and concrete test gaps." }
  ]
})
```

Watch active and completed agents:

```text
/agents
```

`/team` remains a compatibility alias for `/agents`.

Spawn an edit-allowed agent only when the work is isolated and safe to run in parallel:

```text
spawn_agent({
  name: "docs-fix",
  role: "write",
  prompt: "Claim docs/guide.md, fix only stale public tool names, verify, then call report_and_exit."
})
```

## Core features

- **Implicit current-session workflow**: no public team setup step is required.
- **Read agents as the default multiplier**: in-process, parallel, full read/test/search tool access, directed to report without editing.
- **Optional edit agents**: in-process and followable from Pi; use them only for isolated, non-overlapping edits.
- **Auto-delivered reports**: completed agents report back to the lead session for synthesis.
- **`/agents` overlay**: inspect active agents, completed reports, transcripts, models, thinking levels, elapsed time, tokens, and claims.
- **Advisory file claims**: edit agents coordinate file ownership with `claim_file`, `release_file`, and `list_file_claims`.
- **Direct messaging**: agents and the lead can coordinate with `send_message` and `read_inbox`.
- **Targeted health checks**: use `check_teammate` only when a specific agent appears stalled.

## Public tool surface

Lead/session tools:

- `spawn_agent`
- `spawn_swarm_agents`
- `check_teammate`
- `send_message`
- `read_inbox`

Edit-agent coordination tools:

- `claim_file`
- `release_file`
- `list_file_claims`
- `report_and_exit`

## Supported workflow

Use pi-extended-teams for parallel read-only investigation first. Add edit agents only when the edit is isolated.

Good fits:

- Review a diff from several angles.
- Run independent test suites in parallel.
- Validate a refactor with separate static, focused-test, full-suite, and smoke lanes.
- Ask one agent to inspect architecture while another checks test coverage.
- Spawn an edit agent for a narrow, non-overlapping file change.

Avoid:

- Treating edit agents as the default implementation path.
- Spawning multiple edit agents for the same files.
- Having agents create more agents; they should ask the lead with `send_message`.
- Polling for completion with sleeps or loops; the extension wakes the lead.

## Common examples

### Spawn one read agent

```text
spawn_agent({
  name: "security-reviewer",
  role: "read",
  prompt: "Review the auth module for injection and authorization risks. Report findings with file:line evidence."
})
```

### Spawn a swarm

```text
spawn_swarm_agents({
  defaults: { role: "read", cwd: "/path/to/project", thinking: "high" },
  agents: [
    { name: "architecture", prompt: "Review module boundaries and coupling." },
    { name: "tests", prompt: "Run focused tests and report failures or gaps." },
    { name: "docs", prompt: "Check README accuracy against the current public tools." }
  ]
})
```

### Spawn an edit agent

```text
spawn_agent({
  name: "typo-fix",
  role: "write",
  prompt: "Claim README.md, fix typos only, run the focused docs check, then call report_and_exit. Do not commit or push."
})
```

### Send a direct message

```text
send_message({ recipient: "security-reviewer", content: "Also check webhook signature validation.", summary: "Scope update" })
```

### Check one agent

```text
check_teammate({ agent_name: "security-reviewer" })
```

## Configuration

Model and thinking defaults come from Pi and optional pi-extended-teams settings.

Project-local config lives at `.pi/pi-extended-teams.json`; global config lives at `~/.pi/pi-extended-teams.json`.

Example:

```json
{
  "providerPriority": [
    "openai-codex",
    "claude-agent-sdk",
    "kimi-coding"
  ],
  "readAgents": {
    "maxConcurrent": 8,
    "queueOverflow": true
  },
  "writeAgents": {
    "maxConcurrent": 1
  }
}
```

You can also pass fully qualified `provider/model` strings and thinking levels directly to `spawn_agent` or `spawn_swarm_agents`.

## Development

Use direct local binaries when pnpm script execution is blocked by ignored build-script policy:

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
```

Useful checks:

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run extensions/index.test.ts extensions/events/register-events.test.ts extensions/tools/team-tools.read-agent.test.ts
./node_modules/.bin/vitest run
rg --files -g '*.ts' -g '!node_modules' | xargs wc -l | awk '$2 != "total" && $1 > 500 {print}'
```

The current source layout keeps TypeScript files under 500 lines where practical. `extensions/index.ts` is a composition root; behavior lives in focused modules under `extensions/agents`, `extensions/events`, `extensions/internal`, `extensions/team`, `extensions/tools`, `extensions/ui`, and `extensions/runtime`.

## Learn more

- [Usage Guide](docs/guide.md)
- [Tool Reference](docs/reference.md)

## Credits & attribution

pi-extended-teams is based on the original [pi-teams](https://github.com/burggraf/pi-teams) project, with this fork focused on session-connected agents and a smaller public tool surface.

The broader team-agent coordination lineage also includes [claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp) by [cs50victor](https://github.com/cs50victor).

## License

MIT
