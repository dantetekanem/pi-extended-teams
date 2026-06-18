---
name: teams
description: Multiply a coding session with parallel read-only agents (and optional isolated write agents) via pi-extended-teams. Use whenever the user asks to investigate, review, test, audit, validate, or get parallel coverage on code — or when a build/fix has isolated independent chunks worth farming out. Trigger on hot words like "agents", "spawn agents", "use agents", "send agents", or any request to parallelize investigation/review/testing. The lead stays the implementer; agents are the multiplier.
---

# pi-extended-teams

Spawn helper agents to **multiply** the main session. The main agent stays in charge and keeps doing the real work; agents run alongside it and report back automatically.

The flow is meant to be seamless: **one call** creates the team and spawns its agents, they run on their own, and each report arrives back in the main window as a collapsed one-line entry (`✓ name · 2m18s · 579k tok`, `ctrl+o` to expand) that the lead synthesizes automatically. You do not create tasks, write shared memory, poll, or read an inbox to make this work.

## The balance (read this first)

- **The main agent (lead) is the implementer.** It plans and does the actual writing/editing itself, in the main window. Do not delegate the whole job to a swarm just because you can.
- **Read agents are the multiplier — the default.** In-process, unlimited, parallel. They have the **full toolset** (read, search, run shell commands like git/grep/tests) but are *directed* to stay read-only — investigate and report, not edit. Spawn them freely to investigate, review, test, or get second opinions in parallel. This is the primary, cheap, safe path.
- **Write agents are optional and rare.** A write agent runs in its own background tmux screen and can edit files. Use one **only** when there is genuinely isolated, independent work that can run in parallel without colliding with the lead's own edits (file claims keep two writers off the same file). If the work is sequential or central, the lead just does it.

## The one-call flow

```text
team_create(team_name="review", agents=[
  { name: "git-check",  prompt: "Inspect branch/status, recent commits, and diffs. Report what changed and any risks." },
  { name: "test-gaps",  prompt: "Find missing or weak test coverage for the current changes. List concrete gaps." }
])
```

That creates the team and starts both read agents (role defaults to `read`). Then:

1. Each agent works and reports back. The report appears in the main window collapsed (`ctrl+o` expands it) and is delivered into the lead's context.
2. The lead synthesizes the reports for the user automatically — no `read_inbox`, no polling.
3. Read agents are removed from the status bar when they finish; the lead is free to keep working or idle in between.

Spawn more any time with `spawn_teammate`. Add a write agent only for isolated edit work. Writers start in detached background tmux screens by default:

```text
spawn_teammate(team_name="review", name="fix-typos", role="write",
  prompt="Fix the typos listed in docs/guide.md only. Claim that file, keep the diff tiny.")
```

## Hot-word trigger: "agents"

When the user says "agents", "use agents", "spawn agents", "send agents", "agents to investigate/review/test", or any phrase meaning "delegate investigation to parallel helpers", create a team and spawn read agents — do not wait for a more specific instruction. The user should never have to explain how to use agents. Default: team_create with 2-3 focused read agents, each with a bounded mission and report shape.

## Defaults the lead should follow

- Infer the workflow from ordinary requests. The user should not have to say "use read agents" or "open /team". For investigate / review / test / validate / "show me agents working", spawn read agents by default and keep the team read-only.
- Do the implementation yourself unless a chunk is genuinely isolated and parallelizable — then, and only then, spawn a write agent for it.
- NEVER sleep, busy-wait, or poll to wait for reports. Do not use bash `sleep`, `while true`, or any wait loop. The extension delivers reports and wakes you. Do not use `check_teammate` as a status habit — it is only for a suspected stall.
- When the user asks to investigate/diagnose, stay read-only and report; ask before applying any fix.
- Never commit, push, deploy, install packages, or start services unless the user authorizes it.
- Shut the team down when the work is done (`team_shutdown`); finished write agents self-exit, read agents clear themselves.

## Watching and inspecting

- `/team` switches between the main session and each agent (↑/↓): read agents show their live in-process transcript; write agents point to their background tmux screen. Press Enter/a on a selected writer to attach live. Each agent shows its **model and thinking level**, elapsed time, and tokens.
- Alt/Option+Tab cycles main + live writer tmux screens without changing the lead layout.
- Reports already arrive in the main window collapsed; `ctrl+o` expands any of them.
- `list_teammates` gives the roster as tool data when you want it.
- `promote_teammate(team_name, name)` moves a running in-process read agent into its own background tmux screen when you want to watch or interact with it there.

## Optional tools (only when they add value)

These exist for larger, longer, or multi-writer work. They are **not** part of the default flow — reach for them only when the task genuinely needs coordination:

- **Tasks** — `task_create` / `task_list` / `task_read` / `task_update`: a visible board for multi-step work with several owners.
- **Shared memory** — `write_shared_memory` / `read_shared_memory` / `delete_shared_memory`: durable team facts (decisions, findings, changed paths) when work spans many turns or agents.
- **File claims** — `claim_file` / `release_file` / `list_file_claims`: exclusive per-path coordination so two writers never edit the same file. Write agents must claim before editing.
- **Write queue** — write agents are capped (default 3) and overflow is queued; inspect with `list_write_queue`, cancel with `cancel_write_queue`.
- **Messaging** — `send_message`, `broadcast_message`, `read_inbox` for direct routing or write-agent reports.
- **Skills** — `use_skill(name)` loads a specialist skill into an agent's context.

## Writing good agent missions

Give each agent a bounded mission, the relevant scope or files, and the report shape you want — not a tutorial on how the extension works. A good read mission: *"Review the auth changes in src/auth/* for security issues; list concrete findings with file:line and severity."* Tell write agents to claim the files they will touch, keep diffs small, not commit/push, and report every path changed.

## When you are spawned as a teammate

- You start by reading your initial instructions and begin work; if idle, the extension wakes you when new messages arrive.
- NEVER sleep, busy-wait, or poll. Do not use bash `sleep`, `while true`, or any wait/poll loop. The extension delivers messages and wakes you.
- When your work is done, exit cleanly. Do NOT wait for the lead to kill you.
- Write agents: call `report_and_exit` when finished — it sends your final report, releases all file claims, and shuts you down. Read agents: produce your final report and stop.
- Report progress to `team-lead` with `send_message`; record durable facts in shared memory if the team uses it.
- Write agents: `claim_file` every path before editing, `release_file` when done, keep diffs small.
