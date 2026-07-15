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

Spawn one agent in the current Pi session by configured intent tier only.

**Parameters**

- `name` (optional): Stable display name. If omitted, pi-extended-teams generates a unique name.
- `prompt` (required): Assignment and expected report shape.
- `cwd` (optional): Working directory. Defaults to the lead session cwd.
- `model_slot` (required): One of the eight canonical tiers: `read-collect`, `read-review`, `read-analyze`, `read-critical`, `write-patch`, `write-feature`, `write-system`, or `write-critical`. The schema recommends `read-review` as the normal default. The tier selects read/write behavior, model, and thinking from `/agents-favorite-models`.
- `metadata` (optional): Extra structured metadata for runtime/orchestration use.

Do not pass `role`, `model`, or `thinking` directly. Spawn calls reject them; see `TIPS.md` for examples.

**Example**

```javascript
spawn_agent({
  name: "security-reviewer",
  model_slot: "read-critical",
  prompt: "Review src/auth for authorization bugs. Report findings with file:line evidence."
})
```

Use a `write-*` tier only for isolated edit work. Edit agents should claim files before writing and finish with `report_and_exit`.

```javascript
spawn_agent({
  name: "docs-fix",
  model_slot: "write-patch",
  prompt: "Claim docs/guide.md, fix stale public tool references only, verify, then call report_and_exit."
})
```

### `spawn_swarm_agents`

Spawn a batch of agents in the current Pi session. Use `defaults` for shared intent tier/cwd/metadata and per-agent fields for overrides.

**Parameters**

- `defaults` (optional): Shared `cwd`, `model_slot`, and `metadata` values.
- `agents` (required): Array of agent specs. Each agent accepts the same fields as `spawn_agent`, except `model_slot` may be inherited from `defaults`.

**Example**

```javascript
spawn_swarm_agents({
  defaults: { model_slot: "read-review" },
  agents: [
    { name: "architecture", model_slot: "read-analyze", prompt: "Explain module-boundary and coupling risks from connected evidence." },
    { name: "tests", prompt: "Run focused tests and report failures or gaps." },
    { name: "docs", model_slot: "read-collect", prompt: "Check docs for stale tool references." }
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

## UI

Active agents appear in the below-editor activity card. From an empty editor, press Down to open the live follow view, Down/Up to navigate agents/main, `x` to stop the selected agent, and Escape to return. Completed reports are pushed into the lead session automatically.

### `/agents-favorite-models`

Configure the eight canonical favorite intent tiers used by `model_slot`:

| Tier | Intent | Picker thinking default |
| --- | --- | --- |
| `read-collect` | Bounded fact/evidence gathering without owning the conclusion (Luna calibration). | `high` |
| `read-review` | Normal default for focused review, verification, and bounded synthesis (Luna). | `xhigh` |
| `read-analyze` | Behavioral or root-cause explanation across connected evidence (Sol). | `medium` |
| `read-critical` | Irreducible high-stakes security/architecture/concurrency/migration/data reasoning (Sol). | `xhigh` |
| `write-patch` | Narrow localized change (Luna). | `max` |
| `write-feature` | Bounded feature with a known design (Sol). | `medium` |
| `write-system` | Cross-cutting integration/refactor within explicitly claimed files (Sol). | `high` |
| `write-critical` | High-risk security/concurrency/recovery/migration/data-integrity change (Sol). | `max` |

Luna and Sol are calibration families, not provider model IDs built into pi-extended-teams. All tiers start empty; select the corresponding scoped models available in the current Pi session. Press Enter to save to `~/.pi/agent/pi-extended-teams/settings.json`.

For this minor release, these public/settings compatibility aliases remain accepted. Resolution normalizes aliases deterministically, canonical values win if both forms exist, and subsequent favorite-model saves remove legacy duplicates.

| Compatibility alias | Canonical intent tier |
| --- | --- |
| `reading-fast` | `read-collect` |
| `reading-default` | `read-review` |
| `reading-hard` | `read-critical` |
| `writing-basic` | `write-patch` |
| `writing-hard` | `write-system` |

### `/agents-extensions`

Inspect or choose the external Pi extension entrypoints loaded by spawned agents. `list` prints the effective plan; no argument opens the picker in TUI mode. `default` saves `extensions.allow: null`, so the global policy selects all observable loaded command/tool extensions, not all effective extensions: event-, provider-, renderer-, and shortcut-only extensions are not observable by this policy. `none` saves `extensions.allow: []`, so the global policy selects no external extensions. Observed picker selections save canonical absolute extension identities, never display names; stale or blocked preserved entries may remain legacy names. Legacy bare-name entries remain supported as wildcards across all same-name extensions; a block match always takes precedence over allow. Skills are always enabled, and pi-extended-teams itself is internal rather than a selectable spawned-agent extension.

All `/agents-extensions` saves write only the global file, `~/.pi/agent/pi-extended-teams/settings.json`; the command never edits or removes `.pi/pi-extended-teams.json`. A trusted project-local `extensions.allow` (whether `null`, `[]`, or an array) takes precedence over the global policy for that project. In that case the command saves the global choice but reports a warning naming both settings files, because the project override remains authoritative. An untrusted project override is ignored and does not produce that warning.

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
  },
  "watchdog": {
    "bufferSeconds": 30
  }
}
```

Provider-priority sorting for the `/agents-favorite-models` picker also supports `providerPriority` in `~/.pi/pi-extended-teams.json` or `.pi/pi-extended-teams.json`.

Spawn calls use `model_slot` only. They reject raw `model`, direct `thinking`, and direct `role` fields. In `spawn_swarm_agents`, each agent must receive a configured tier directly or inherit one from `defaults`.

---

## Behavior notes

- The lead controls orchestration. Spawned agents should not create other agents.
- Agents run in-process and are followable from Pi.
- Read agents should not edit files or make mutating changes.
- Use `read-review` as the normal default, `read-collect` for bounded evidence gathering, `read-analyze` for connected explanation, and `read-critical` only for irreducible high-stakes reasoning. See `TIPS.md` for tier-selection examples.
- Edit agents should keep diffs small, claim files before editing, and use `report_and_exit` when finished.
- Do not use sleep loops or polling to wait for reports; pi-extended-teams wakes the lead when agent reports arrive.
- Internal source files still use `team` terminology in places for persisted state and backward compatibility. That terminology is not part of the current public workflow.
