# pi-extended-teams Reference

This reference documents the current public surface for pi-extended-teams. The extension uses the current Pi session as the implicit agent group; public tools do not require a separate team setup step.

## Contents

- [Agent spawning](#agent-spawning)
- [Agent health](#agent-health)
- [Messaging](#messaging)
- [File claims and exit](#file-claims-and-exit)
- [UI commands](#ui-commands)
- [Configuration](#configuration)
- [Behavior notes](#behavior-notes)

---

## Agent spawning

### `spawn_agent`

Spawn one agent in the current Pi session.

**Parameters**

- `name` (optional): Stable display name. If omitted, pi-extended-teams generates a unique name.
- `prompt` (required): Assignment and expected report shape.
- `role` (optional): `read` or `write`. Defaults to `read`.
- `cwd` (optional): Working directory. Defaults to the lead session cwd.
- `model_slot` (optional): One of `reading-fast`, `reading-default`, `reading-hard`, `writing-basic`, or `writing-hard`. Uses the configured favorite model and thinking for that workload.
- `model` (optional): Fully qualified `provider/model` string. Defaults to the current Pi session model or configured defaults. Prefer `model_slot` for normal orchestration once favorites are configured.
- `thinking` (optional): `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- `metadata` (optional): Extra structured metadata for runtime/orchestration use.

**Example**

```javascript
spawn_agent({
  name: "security-reviewer",
  role: "read",
  model_slot: "reading-hard",
  prompt: "Review src/auth for authorization bugs. Report findings with file:line evidence."
})
```

Use `role: "write"` only for isolated edit work. Edit agents should claim files before writing and finish with `report_and_exit`.

```javascript
spawn_agent({
  name: "docs-fix",
  role: "write",
  model_slot: "writing-basic",
  prompt: "Claim docs/guide.md, fix stale public tool references only, verify, then call report_and_exit."
})
```

### `spawn_swarm_agents`

Spawn a batch of agents in the current Pi session. Use `defaults` for shared settings and per-agent fields for overrides.

**Parameters**

- `defaults` (optional): Shared `role`, `cwd`, `model_slot`, `model`, `thinking`, and `metadata` values.
- `agents` (required): Array of agent specs. Each agent accepts the same fields as `spawn_agent`. Per-agent `model_slot` can override a default slot.

**Example**

```javascript
spawn_swarm_agents({
  defaults: { role: "read", model_slot: "reading-default" },
  agents: [
    { name: "architecture", model_slot: "reading-hard", prompt: "Review module boundaries and coupling." },
    { name: "tests", prompt: "Run focused tests and report failures or gaps." },
    { name: "docs", model_slot: "reading-fast", prompt: "Check docs for stale tool references." }
  ]
})
```

Unnamed swarm agents receive unique generated names so separate swarms do not collide with already-running generated agents.

---

## Agent health

### `check_teammate`

Check one agent's status in the current Pi session. Use this for targeted liveness/debugging, not as a polling loop.

**Parameters**

- `agent_name` (required): Agent name to inspect.

**Returns**

- `alive`: Whether the agent appears alive.
- `unreadCount`: Unread messages for that agent.
- `health`: `healthy`, `idle`, `starting`, `stalled`, or `dead`.
- `runtime`: Runtime telemetry such as heartbeat, action, active tool, tokens, and last error.

**Example**

```javascript
check_teammate({ agent_name: "security-reviewer" })
```

---

## Messaging

### `send_message`

Send a direct message in the current Pi session.

**Parameters**

- `recipient` (optional for spawned agents): Target agent name. Spawned agents default to `team-lead`.
- `content` (required): Message body.
- `summary` (optional): Short inbox summary.

**Examples**

```javascript
send_message({
  recipient: "docs-review",
  content: "Also check docs/reference.md for stale examples.",
  summary: "Scope update"
})
```

A spawned agent can report to the lead without specifying a recipient:

```javascript
send_message({ content: "Found one stale README example.", summary: "Docs finding" })
```

### `read_inbox`

Read messages from the current Pi session inbox.

**Parameters**

- `agent_name` (optional): Inbox owner. Defaults to the current agent.
- `unread_only` (optional): Defaults to `true`.
- `mark_as_read` (optional): Defaults to `true`; set `false` to peek.

**Example**

```javascript
read_inbox({ unread_only: true })
```

---

## File claims and exit

### `claim_file`

Claim file paths before an edit agent changes them. Claims are scoped to the current Pi session.

**Parameters**

- `paths` (required): Repository-relative file paths.

**Example**

```javascript
claim_file({ paths: ["README.md", "docs/guide.md"] })
```

### `release_file`

Release file claims held by the current edit agent.

**Parameters**

- `paths` (required): Repository-relative file paths.

**Example**

```javascript
release_file({ paths: ["README.md"] })
```

### `list_file_claims`

List active file claims in the current Pi session.

**Parameters**

None.

**Example**

```javascript
list_file_claims({})
```

### `report_and_exit`

Send a final report to the lead, release this agent's file claims, and shut down.

**Parameters**

- `content` (required): Final report.
- `summary` (optional): Short report summary.

**Example**

```javascript
report_and_exit({
  summary: "Docs update complete",
  content: "Changed README.md and docs/guide.md. Verification: ./node_modules/.bin/tsc --noEmit passed."
})
```

---

## UI commands

### `/agents`

Open the agent panel for the current Pi session. It shows active agents, completed reports, transcripts, model/thinking metadata, elapsed time, token usage, and file claims.

### `/team`

Compatibility alias for `/agents`.

### `/agents-favorite-models`

Configure the five favorite model slots used by `model_slot`:

- `reading-fast`
- `reading-default`
- `reading-hard`
- `writing-basic`
- `writing-hard`

By default, all slots start empty. Run the command without arguments to open a single-screen picker for all five slots; the model column is populated from the scoped models available to the current Pi session. Pick a model and thinking level, then press Enter to save. Updates are saved to `~/.pi/agent/pi-extended-teams/settings.json`.

Use the slots to communicate intent when spawning agents. For example, use `reading-fast` for many small read-only collection agents, `reading-hard` for one deep architecture/security reviewer, `writing-basic` for a narrow docs edit, and `writing-hard` for a difficult implementation agent.

---

## Configuration

pi-extended-teams reads optional runtime settings from:

- Global: `~/.pi/agent/pi-extended-teams/settings.json`
- Project override for non-favorite settings: `.pi/pi-extended-teams.json`

Favorite model slots are global-only so `/agents-favorite-models` and spawn resolution use the same values.

Common runtime settings:

```json
{
  "favoriteModels": {
    "reading-fast": { "model": "provider/model", "thinking": "low" },
    "reading-default": { "model": "provider/model", "thinking": "high" },
    "reading-hard": { "model": "provider/model", "thinking": "xhigh" },
    "writing-basic": { "model": "provider/model", "thinking": "high" },
    "writing-hard": { "model": "provider/model", "thinking": "xhigh" }
  },
  "readAgents": {
    "maxConcurrent": 8,
    "queueOverflow": true
  },
  "writeAgents": {
    "maxConcurrent": 1
  },
  "watchdog": {
    "bufferSeconds": 30
  }
}
```

Provider-priority sorting for model selection also supports `providerPriority` in `~/.pi/pi-extended-teams.json` or `.pi/pi-extended-teams.json`.

Model settings still come from Pi's active model configuration unless you use `model_slot` or pass a fully qualified `provider/model` string in a spawn call. In `spawn_swarm_agents`, per-agent `model`, `thinking`, or `model_slot` fields override conflicting defaults instead of being combined.

---

## Behavior notes

- The lead controls orchestration. Spawned agents should not create other agents.
- Agents run in-process and are followable from Pi.
- Read agents should not edit files or make mutating changes.
- Prefer multiple `reading-fast` agents for splitable collection work; use `reading-hard` for deep synthesis, risky analysis, or ambiguous root cause.
- Edit agents should keep diffs small, claim files before editing, and use `report_and_exit` when finished.
- Do not use sleep loops or polling to wait for reports; pi-extended-teams wakes the lead when agent reports arrive.
- Internal source files still use `team` terminology in places for persisted state and backward compatibility. That terminology is not part of the current public workflow.
