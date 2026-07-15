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
  defaults: { model_slot: "read-review" },
  agents: [
    { name: "git-check", prompt: "Inspect diffs and report risks." },
    { name: "test-gaps", prompt: "Find missing coverage and concrete test gaps." }
  ]
})
```

Watch active agents in the below-editor activity card. With the editor empty, press Down to open live navigation, Down/Up to move between agents/main, `l` to expand or collapse large tool logs, `m` to message the selected agent, `x` to stop it, and Escape to return. Completed reports are pushed into the lead session automatically.

Spawn an edit-allowed agent only when the work is isolated and safe to run in parallel:

```text
spawn_agent({
  name: "docs-fix",
  model_slot: "write-patch",
  prompt: "Claim docs/guide.md, fix only stale public tool names, verify, then call report_and_exit."
})
```

## Core features

- **Implicit current-session workflow**: no public team setup step is required.
- **Read agents as the default multiplier**: in-process, parallel, full read/test/search tool access, directed to report without editing.
- **Optional edit agents**: in-process and followable from Pi; use them only for isolated, non-overlapping edits.
- **Live activity card**: active agent progress, intent tier, elapsed time, and token usage stay visible below the editor.
- **Auto-delivered reports**: new agent messages queue a lead follow-up even during an active turn, without manual polling.
- **Down-key live navigation**: inspect active transcripts, models, thinking levels, elapsed time, tokens, and grouped tool activity; expand large logs with `l`, message the selected agent with `m`, or stop it with `x`.
- **Built-in orchestration guidance**: the extension teaches intent-tier selection, delegated-lane ownership, report-first synthesis, and literal waiting without polling.
- **Advisory file claims**: edit agents coordinate file ownership with `claim_file`, `release_file`, and `list_file_claims`.
- **Direct messaging**: agents and the lead can coordinate with `send_message` and `read_inbox`.
- **Targeted health checks**: use `check_teammate` only when a specific agent appears stalled.

## Public tool surface

Lead/session tools:

- `spawn_agent`
- `spawn_swarm_agents`
- `check_teammate`
- `stop_teammate`
- `send_message`
- `read_inbox`

Spawned-agent communication:

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

## Favorite model slots

Configure intent tiers with `/agents-favorite-models`. It opens a single-screen picker for all eight canonical tiers, populated from the scoped models the current Pi session can actually access. Each tier supplies the agent kind, model, and thinking level, so spawning agents uses `model_slot` only. Do not pass raw model names, `thinking`, or `role` in spawn calls.

`read-review` is the normal default. Choose a different tier only when the intended outcome clearly matches it:

| Tier | Intent | Calibration |
| --- | --- | --- |
| `read-collect` | Gather bounded facts, inventory, logs, docs, or test output without owning the conclusion. | Luna / `high` |
| `read-review` | Focused review, verification, test-gap assessment, and bounded synthesis. | Luna / `xhigh` |
| `read-analyze` | Explain behavior or root cause across connected evidence. | Sol / `medium` |
| `read-critical` | Irreducible high-stakes security, architecture, concurrency, migration, or data-correctness reasoning. | Sol / `xhigh` |
| `write-patch` | Narrow localized docs, config, fixture, or bug fix. | Luna / `max` |
| `write-feature` | Bounded feature implementation with a known design. | Sol / `medium` |
| `write-system` | Cross-cutting integration or refactor within explicitly claimed files. | Sol / `high` |
| `write-critical` | High-risk security, concurrency, recovery, migration, or data-integrity change. | Sol / `max` |

Luna/Sol are calibration families, not hardcoded provider model IDs; choose the corresponding scoped model in your Pi installation.

For this minor release, these compatibility aliases remain accepted; use the canonical tier in new prompts and settings. New settings saves use canonical keys.

| Compatibility alias | Canonical intent tier |
| --- | --- |
| `reading-fast` | `read-collect` |
| `reading-default` | `read-review` |
| `reading-hard` | `read-critical` |
| `writing-basic` | `write-patch` |
| `writing-hard` | `write-system` |

## Common examples

### Spawn one read agent

```text
spawn_agent({
  name: "docs-facts",
  model_slot: "read-collect",
  prompt: "Collect stale public tool references from README and docs. Report exact file:line evidence."
})
```

Use `read-critical` only for a rare lane whose conclusion itself requires irreducible high-stakes reasoning—not for routine collection or review.

### Spawn a swarm

```text
spawn_swarm_agents({
  defaults: { cwd: "/path/to/project", model_slot: "read-collect" },
  agents: [
    { name: "routes", prompt: "Inspect config/routes files and report public endpoint patterns." },
    { name: "jobs", prompt: "Inspect background jobs and report retry/queue conventions." },
    { name: "docs", prompt: "Check README accuracy against the current public tools." }
  ]
})
```

### Spawn an edit agent

```text
spawn_agent({
  name: "typo-fix",
  model_slot: "write-patch",
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

Agent model and thinking choices come from configured favorite intent tiers only.

Runtime settings live globally at `~/.pi/agent/pi-extended-teams/settings.json`; project-local overrides live at `.pi/pi-extended-teams.json`. Favorite model slots are global-only so `/agents-favorite-models` and spawn resolution use the same values; project files still override other runtime settings. `/agents-favorite-models` writes the global runtime settings file after you save the single-screen picker.

Example:

```json
{
  "favoriteModels": {
    "read-collect": { "model": "provider/luna-model", "thinking": "high" },
    "read-review": { "model": "provider/luna-model", "thinking": "xhigh" },
    "read-analyze": { "model": "provider/sol-model", "thinking": "medium" },
    "read-critical": { "model": "provider/sol-model", "thinking": "xhigh" },
    "write-patch": { "model": "provider/luna-model", "thinking": "max" },
    "write-feature": { "model": "provider/sol-model", "thinking": "medium" },
    "write-system": { "model": "provider/sol-model", "thinking": "high" },
    "write-critical": { "model": "provider/sol-model", "thinking": "max" }
  },
  "readAgents": {
    "maxConcurrent": 8,
    "queueOverflow": true
  },
  "writeAgents": {
    "maxConcurrent": 1
  }
}
```

Provider-priority sorting for the `/agents-favorite-models` picker also supports `providerPriority` in `~/.pi/pi-extended-teams.json` or `.pi/pi-extended-teams.json`.

If no favorite tiers are configured, pi-extended-teams warns at session start and spawn calls fail until you define the tiers you want to use.

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
