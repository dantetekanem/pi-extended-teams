# pi-extended-teams agent guide

The current Pi session is the agent group. Use `spawn_agent` for one bounded helper or `spawn_swarm_agents` for independent lanes. The lead owns scope, integration, verification, and final acceptance.

## Autoresearch conflict guard

If autoresearch mode/session is active, running, or being resumed, do not spawn agents, subagents, or reviewer agents. Autoresearch must stay single-agent while active because delegating research or review during the optimization loop is a conflict of interest. This guard overrides every delegation trigger, including requests to use agents.

Treat autoresearch as running when `/autoresearch` is active, the prompt says autoresearch mode is active, the agent is following `.auto/prompt.md`, an experiment is running or pending, or the user says autoresearch is running. Do not infer running state from a `.auto/` folder alone.

If team help is needed, ask the user to turn off or finish autoresearch first.

## Roles and delegation

Public read and edit agents run in separate in-process Pi sessions. Choosing a write tier grants edit tools; it does not select a terminal pane. The terminal runtime remains available for existing integrations.

Read agents are the default. Edit agents are opt-in and must own isolated files. Before delegating:

1. Map the requested outcomes to genuine independent questions or sub-outcomes.
2. Give each lane its scope, relevant decisions and evidence, forbidden side effects, and expected result.
3. Keep cross-lane decisions and final acceptance with the lead.
4. Reject overlapping lanes. If only one substantive execution lane exists, the lead implements it; an independent read-only check may still help.

A request to use agents triggers this mapping, not a fixed-size swarm or delegation of the whole request to one writer. Honor user restrictions on delegation. See `skills/teams.md` for the context handoff contract.

## Intent tiers

Pass `model_slot`, not a raw role, model, or thinking level. Configured favorites take priority; an unconfigured tier inherits the lead-session model and thinking. Use `/agents-favorite-models` to configure tiers.

| Tier | Outcome |
| --- | --- |
| `read-collect` | Bounded facts and evidence |
| `read-review` | Focused review, verification, and test gaps |
| `read-analyze` | Connected explanation or root cause |
| `read-critical` | Irreducible high-stakes reasoning |
| `write-patch` | Narrow localized edit |
| `write-feature` | Bounded feature with a known design |
| `write-system` | Integration or refactoring within an isolated scope |
| `write-critical` | High-risk security, concurrency, recovery, or data-integrity change |

Nested read helpers require explicit `allow_nested_read_agents: true` on a depth-0 `write-feature` or `write-critical` spawn. Children remain read-only and cannot delegate. Other tiers cannot spawn helpers.

## Public tools

The extension registers these tools; role and ownership checks still apply:

- Spawn: `spawn_agent`, `spawn_swarm_agents`.
- Observe: `get_agent_status`.
- Communicate: `send_message`, `read_inbox`.
- Control: `interrupt_teammate`, `stop_teammate`, `check_teammate`.
- Coordinate files: `claim_file`, `release_file`, `list_file_claims`.
- Finish an edit agent: `report_and_exit`.

Runtime-backed teammates also receive `report_progress`; it is not a lead tool. Task-board tools come from a separate integration, not this extension's public registration.

## Working patterns

For independent checks, use a batch with a bounded question per agent. For a plan-before-edit workflow, request read-only analysis, make the decision as lead, then assign an authorized edit with that decision in its prompt. Do not assume a task-board status or hook notification proves that checks passed.

Edit agents claim paths before changes and release their own claims when finished. Claims coordinate cooperative agents; they are not access control. Report changed paths and the exact checks run, including failures and unverified limits. The lead verifies acceptance before marking work complete.

Only the lead or a trusted integration can assign `checks` and an optional `repair: { maxAttempts: 1 }` policy. Repair allows at most five additional attempts and is disabled by default. If `report_and_exit` returns an unaccepted `repairRequest`, remain active and resubmit after addressing the observed failure within the same scope and permissions. Keep or reacquire claims before repair edits; report blocked or failed when repair is unsafe. Verification, effective repair blockers, reported outcomes, and lead acceptance remain separate. Unresolved execution or persistence keeps cleanup fenced.

Lead batches may opt into `completion_group: { delivery: "all-settled" }` to receive compact indexes after settlement, or `"immediate"` for compact member delivery. Omission keeps immediate full reports. Blockers/failures may wake early; nested-parent routing and suppression still apply. Read referenced full reports as needed, and keep stored verification, reported outcomes and lead acceptance separate. An unconfirmed wake is not automatically retried across reload; use the saved inbox index instead of polling or respawning work. Recovery does not revive recipients, release claims or invent successful outcomes.

## Status, queues, and recovery

`get_agent_status` is read-only. It distinguishes current-run activity from lifecycle health and retains persisted quarantine even when the process is gone. Old-run heartbeats do not establish replacement-run health. Observation does not clean up agents.

Public spawns honor role-specific capacity. When overflow is enabled, accepted work queues; when disabled, capacity exhaustion returns an error. A quarantined entry stays fenced while unrelated eligible work can proceed. Failed admissions remain visible through status, with up to 20 recent failures retained in memory, and the runtime attempts recipient notification. This public queue and its recent failure index are session-local, not restart-durable.

Use `stop_teammate` to cancel accepted queued work or stop a whole active agent when cancellation is requested or it is no longer needed. Use `interrupt_teammate` only for a proven stuck tool command: it preserves the session, task context, and claims. In-process cancellation is cooperative and may remain pending; terminal-backed success confirms Escape delivery, not command settlement.

## Live control and reports

From an empty editor, press Down to open agent navigation. Use Up/Down to select an agent, `l` to expand logs, `m` to message, `i` to interrupt its running tool, `x` to stop the agent, and Escape to return. Page Up/Page Down scroll the transcript; End resumes following output.

Send relevant scope or evidence changes to the active owner with `send_message`. In-process agents receive a steering turn; legacy terminal-backed agents receive inbox delivery.

Reports arrive automatically. Do unrelated work, then end the turn to wait. One `get_agent_status` snapshot is allowed when current status is needed. Never sleep, busy-wait, or repeatedly query status or inboxes. Use `check_teammate` only after status indicates a suspected lifecycle failure; it may clean up an agent classified as dead.

Finished agents self-exit. Once a final report is accepted, message admission closes while teardown finishes. Do not call `stop_teammate` after normal completion or try to revive the closing session. If new work appears, give a fresh bounded agent the relevant evidence.
