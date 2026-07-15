---
name: teams
description: Multiply a coding session with genuine independent read-only lanes (and optional isolated edit lanes) via pi-extended-teams. Use whenever the user asks to investigate, review, test, audit, validate, get parallel coverage, or use agents. Hot words like "agents", "spawn agents", "use agents", and "send agents" trigger outcome-to-lane mapping before spawning. Never use while autoresearch mode/session is active. The lead owns integration and final acceptance and executes work when only one substantive execution lane exists.
---

# pi-extended-teams

Spawn helper agents inside the current Pi session. The lead stays in charge, keeps the main context, and synthesizes agent reports for the user. Agents are followable from Pi and do not require a separate team setup step.

## Autoresearch conflict guard

If autoresearch mode/session is active, running, or being resumed, do **not** use this skill to spawn agents, teams, subagents, or reviewer agents. This overrides hot-word triggers and all default agent delegation because autoresearch must keep experimentation, judgment, and logging in one context to avoid a conflict of interest.

Treat autoresearch as running when `/autoresearch` is active, the prompt says autoresearch mode is active, the agent is following `.auto/prompt.md`, an experiment is running or pending, or the user says autoresearch is running. Do not infer running state from a `.auto/` folder alone.

If agents would otherwise be useful, stop and ask the user to turn off or finish autoresearch first.

## The balance

- **The lead owns the result.** The lead retains integration, cross-lane decisions, scope tradeoffs, verification synthesis, and final acceptance. If only one substantive execution lane exists, the lead executes it.
- **Read agents multiply genuine independent coverage.** Use them for bounded investigation, review, testing, audits, and second opinions only when each lane returns distinct useful evidence.
- **Edit agents are optional and rare.** A writer owns exactly one isolated sub-outcome with non-overlapping files. Use `write-system` for normal complex implementation, integration, or refactoring inside that lane; reserve `write-critical` for rare high-risk security, concurrency, recovery, migration, or data-integrity work. Neither tier allows broad cross-stack ownership. Edit agents must claim files before writing and report every changed path.

## Mandatory outcome-to-lane gate

Before spawning for substantial work:

1. Enumerate every unfinished substantive outcome in the User's request as an inspectable behavior, artifact, decision, or evidence result.
2. Map each candidate lane to exactly one bounded sub-outcome or independent question, its owned surface, and its expected evidence. The whole User request cannot be a lane.
3. Keep integration, cross-lane decisions, and final acceptance with the lead.
4. Reject overlapping or fake parallel lanes. Agents are useful only for genuine independent lanes.
5. Reject any plan in which one teammate owns every unfinished substantive outcome. Re-split only where outcomes are genuinely independent; do not rename the whole request as one lane.
6. If only one substantive execution lane exists, the lead must execute it rather than spawn a replacement writer. Independent read-only review or evidence lanes remain allowed when they add distinct value.

## Default flow

Run the outcome-to-lane gate first, then use `spawn_agent` for one genuine helper lane or `spawn_swarm_agents` for a batch of independent lanes. The current Pi session is the implicit container; do not create or manage a separate team. Spawn by canonical `model_slot` intent tier only; never pass `role`, raw `model`, or `thinking` directly. `/agents-favorite-models` maps the eight tiers—`read-collect`, `read-review`, `read-analyze`, `read-critical`, `write-patch`, `write-feature`, `write-system`, and `write-critical`—to read/write behavior, model, and effort. See `TIPS.md` for tier-selection examples.

```text
spawn_swarm_agents({
  defaults: { model_slot: "read-review" },
  agents: [
    {
      name: "git-check",
      prompt: "Inspect branch/status, recent commits, and diffs. Report what changed and any risks."
    },
    {
      name: "test-gaps",
      prompt: "Find missing or weak test coverage for the current changes. List concrete gaps."
    }
  ]
})
```

Then:

1. Each agent runs in-process and reports back to the lead.
2. The lead synthesizes the reports for the user.
3. Finished agents leave the active status list; completed reports remain available in the session UI.

Spawn one more focused helper when needed:

```text
spawn_agent({
  name: "docs-review",
  model_slot: "read-review",
  prompt: "Review README.md and docs/guide.md for stale agent-tool references. Report exact lines and replacements."
})
```

Spawn an edit agent only for isolated work:

```text
spawn_agent({
  name: "docs-fix",
  model_slot: "write-patch",
  prompt: "Fix only stale tool names in docs/guide.md. Claim the file first, keep the diff small, then call report_and_exit."
})
```

## Hot-word trigger: "agents"

When the user says "agents", "use agents", "spawn agents", "send agents", "agents to investigate/review/test", or any phrase meaning "delegate to helpers", immediately run intake and map the requested outcomes to candidate lanes. Do not wait for the user to explain the extension mechanics, but do not invent a 2–3-agent swarm. Spawn only the genuine independent lanes the map supports. The whole request cannot be assigned as one lane, and a plan where one teammate owns every unfinished substantive outcome is invalid. If the map contains only one substantive execution lane, the lead executes it instead of spawning a replacement writer; use an agent only for a separate read-only question or review that adds distinct value. Exception: if the autoresearch conflict guard is active, spawn nothing and explain that agent delegation is disabled until autoresearch is off.

## Lead rules

- Never spawn agents, teams, subagents, or reviewer agents while autoresearch mode/session is active, running, or being resumed.
- Complete outcome-to-lane mapping before delegation; agents are useful only for genuine independent lanes.
- Keep integration, cross-lane decisions, and final acceptance in the lead.
- Keep implementation in the lead when there is only one substantive execution lane. Otherwise, a writer may own only one isolated sub-outcome.
- Never sleep, busy-wait, or poll. The extension wakes the lead when reports arrive.
- Trust quiet agents. Do not ping, message, or check an agent just because it has been quiet for less than several minutes; active status remains visible in the activity card and Down-key live view.
- When requirements or evidence change while an agent is still active, use `send_message` to update that owner instead of replacing or stopping it. Active in-process read agents receive the message as a steering turn and can continue intelligently; active tmux writers wake through their inbox.
- Once a final report is accepted, new message admission is closed and the agent is self-exiting; teardown may still be finishing. Do not call `stop_teammate` after normal completion. If genuinely new work appears after the report, spawn a fresh bounded `read-collect` lane rather than trying to revive that closing session.
- Do not wake the lead just to ping idle agents.
- Use `check_teammate` only when a specific agent appears stalled or unhealthy after several minutes, not immediately after sending a message.
- Use `stop_teammate` only when the user explicitly asks to cancel/stop an active agent or an active agent is no longer needed.
- Ask before applying fixes during an investigation.
- Never commit, push, deploy, install packages, or start services unless the user authorizes that side effect.

## Watching and inspecting

- Use the below-editor activity card for active status. From an empty editor, press Down for the live view, Down/Up to navigate, `x` to stop the selected agent, and Escape to return.
- Completed reports arrive in the lead session as open report entries.
- Use `check_teammate({ agent_name: "name" })` only for targeted liveness diagnostics.

## Public tools

Default lead tools:

- `spawn_agent` — start one read or edit-allowed agent in the current Pi session using required `model_slot` level.
- `spawn_swarm_agents` — start a batch of agents with optional shared `model_slot` defaults.
- `stop_teammate` — explicitly stop one active agent when cancellation is requested.
- `check_teammate` — inspect one agent's health when needed.
- `send_message` — send a direct message in the current session.
- `read_inbox` — read the current session inbox.

Edit-agent coordination tools:

- `claim_file` — reserve paths before editing.
- `release_file` — release held claims.
- `list_file_claims` — inspect active claims.
- `report_and_exit` — send the final report, release claims, and shut down.

## Writing good agent missions

Give every agent:

- one bounded independent sub-outcome or question (never the whole User request),
- relevant files or directories,
- the right `model_slot` tier (`read-*` for read-only, `write-*` for edit-allowed),
- the report shape you want,
- and verification expectations.

Good read mission:

```text
Review the auth changes in src/auth/* for security issues. Report concrete findings with file:line, severity, and suggested fix. Do not edit files.
```

Good edit mission:

```text
Claim docs/guide.md, update only stale public tool names, run the focused docs reference check, then call report_and_exit with changed paths and verification.
```

## When you are spawned as an agent

- Start by reading your initial instructions.
- Use `send_message` for direct communication and `read_inbox` when the extension wakes you or you expect a reply.
- Never sleep, busy-wait, or poll.
- You cannot spawn other agents. If another agent is needed, ask the lead with `send_message`.
- Read agents: investigate, report, and stop.
- Edit agents: claim files before editing, release claims when done, and call `report_and_exit` with your final report.
