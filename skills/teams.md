---
name: teams
description: Multiply a coding session with parallel read-only agents (and optional isolated edit agents) via pi-extended-teams. Use whenever the user asks to investigate, review, test, audit, validate, or get parallel coverage on code — or when a build/fix has isolated independent chunks worth farming out. Trigger on hot words like "agents", "spawn agents", "use agents", "send agents", or any request to parallelize investigation/review/testing. Never use while autoresearch mode/session is active; autoresearch must stay single-agent. The lead stays the implementer; agents are the multiplier.
---

# pi-extended-teams

Spawn helper agents inside the current Pi session. The lead stays in charge, keeps the main context, and synthesizes agent reports for the user. Agents are followable from Pi and do not require a separate team setup step.

## Autoresearch conflict guard

If autoresearch mode/session is active, running, or being resumed, do **not** use this skill to spawn agents, teams, subagents, or reviewer agents. This overrides hot-word triggers and all default agent delegation because autoresearch must keep experimentation, judgment, and logging in one context to avoid a conflict of interest.

Treat autoresearch as running when `/autoresearch` is active, the prompt says autoresearch mode is active, the agent is following `.auto/prompt.md`, an experiment is running or pending, or the user says autoresearch is running. Do not infer running state from a `.auto/` folder alone.

If agents would otherwise be useful, stop and ask the user to turn off or finish autoresearch first.

## The balance

- **The lead is the implementer.** Plan, coordinate, and do central edits in the main session.
- **Read agents are the default multiplier.** Use them freely for investigation, review, testing, audits, and second opinions. They run in-process and report back automatically.
- **Edit agents are optional and rare.** Use `role: "write"` only for isolated, non-overlapping edits. Edit agents must claim files before writing and report every changed path.

## Default flow

Use `spawn_agent` for one helper or `spawn_swarm_agents` for a batch. The current Pi session is the implicit container; do not create or manage a separate team.

```text
spawn_swarm_agents({
  defaults: { role: "read", thinking: "high" },
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
  role: "read",
  prompt: "Review README.md and docs/guide.md for stale agent-tool references. Report exact lines and replacements."
})
```

Spawn an edit agent only for isolated work:

```text
spawn_agent({
  name: "docs-fix",
  role: "write",
  prompt: "Fix only stale tool names in docs/guide.md. Claim the file first, keep the diff small, then call report_and_exit."
})
```

## Hot-word trigger: "agents"

When the user says "agents", "use agents", "spawn agents", "send agents", "agents to investigate/review/test", or any phrase meaning "delegate investigation to parallel helpers", spawn 2–3 focused read agents immediately. Do not wait for the user to explain the extension mechanics. Exception: if the autoresearch conflict guard is active, spawn nothing and explain that agent delegation is disabled until autoresearch is off.

## Lead rules

- Never spawn agents, teams, subagents, or reviewer agents while autoresearch mode/session is active, running, or being resumed.
- Prefer read agents for parallel coverage.
- Keep implementation in the lead unless a write task is genuinely isolated.
- Never sleep, busy-wait, or poll. The extension wakes the lead when reports arrive.
- Use `check_teammate` only when a specific agent appears stalled or unhealthy.
- Ask before applying fixes during an investigation.
- Never commit, push, deploy, install packages, or start services unless the user authorizes that side effect.

## Watching and inspecting

- Use `/agents` to inspect active agents, completed reports, transcripts, model/thinking levels, elapsed time, and token usage.
- `/team` remains a compatibility alias for `/agents`.
- Completed reports also arrive in the lead session as collapsed report entries.
- Use `check_teammate({ agent_name: "name" })` only for targeted liveness diagnostics.

## Public tools

Default lead tools:

- `spawn_agent` — start one read or edit-allowed agent in the current Pi session.
- `spawn_swarm_agents` — start a batch of agents with optional shared defaults.
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

- a bounded mission,
- relevant files or directories,
- whether it may edit,
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
