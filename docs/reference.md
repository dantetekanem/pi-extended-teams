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
- `model` (optional): Fully qualified `provider/model` string. Defaults to the current Pi session model or configured defaults.
- `thinking` (optional): `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- `metadata` (optional): Extra structured metadata for runtime/orchestration use.

**Example**

```javascript
spawn_agent({
  name: "security-reviewer",
  role: "read",
  prompt: "Review src/auth for authorization bugs. Report findings with file:line evidence.",
  thinking: "high"
})
```

Use `role: "write"` only for isolated edit work. Edit agents should claim files before writing and finish with `report_and_exit`.

```javascript
spawn_agent({
  name: "docs-fix",
  role: "write",
  prompt: "Claim docs/guide.md, fix stale public tool references only, verify, then call report_and_exit."
})
```

### `spawn_swarm_agents`

Spawn a batch of agents in the current Pi session. Use `defaults` for shared settings and per-agent fields for overrides.

**Parameters**

- `defaults` (optional): Shared `role`, `cwd`, `model`, `thinking`, and `metadata` values.
- `agents` (required): Array of agent specs. Each agent accepts the same fields as `spawn_agent`.

**Example**

```javascript
spawn_swarm_agents({
  defaults: { role: "read", thinking: "high" },
  agents: [
    { name: "architecture", prompt: "Review module boundaries and coupling." },
    { name: "tests", prompt: "Run focused tests and report failures or gaps." },
    { name: "docs", prompt: "Check docs for stale tool references." }
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

---

## Configuration

pi-extended-teams reads optional settings from:

- Project: `.pi/pi-extended-teams.json`
- Global: `~/.pi/pi-extended-teams.json`

Common settings:

```json
{
  "providerPriority": ["openai-codex", "claude-agent-sdk"],
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

Model settings still come from Pi's active model configuration unless you pass a fully qualified `provider/model` string in a spawn call.

---

## Behavior notes

- The lead controls orchestration. Spawned agents should not create other agents.
- Agents run in-process and are followable from Pi.
- Read agents should not edit files or make mutating changes.
- Edit agents should keep diffs small, claim files before editing, and use `report_and_exit` when finished.
- Do not use sleep loops or polling to wait for reports; pi-extended-teams wakes the lead when agent reports arrive.
- Internal source files still use `team` terminology in places for persisted state and backward compatibility. That terminology is not part of the current public workflow.
