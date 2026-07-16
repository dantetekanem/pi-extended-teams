---
name: teams
description: Multiply a coding session with genuine independent read-only lanes (and optional isolated edit lanes) via pi-extended-teams. Use whenever the user asks to investigate, review, test, audit, validate, get parallel coverage, or use agents. Hot words like "agents", "spawn agents", "use agents", and "send agents" trigger outcome-to-lane mapping before spawning. Never use while autoresearch mode/session is active. The lead owns integration and final acceptance and executes work when only one substantive execution lane exists.
---

# pi-extended-teams

Spawn helper agents inside the current Pi session. The lead stays in charge, keeps the main context, and synthesizes agent reports for the user. Agent sessions are isolated: they do not inherit the lead or parent conversation, so the mission prompt is the reliable context handoff. Agents are followable from Pi and do not require a separate team setup step.

## Autoresearch conflict guard

If autoresearch mode/session is active, running, or being resumed, do **not** use this skill to spawn agents, teams, subagents, or reviewer agents. This overrides hot-word triggers and all default agent delegation because autoresearch must keep experimentation, judgment, and logging in one context to avoid a conflict of interest.

Treat autoresearch as running when `/autoresearch` is active, the prompt says autoresearch mode is active, the agent is following `.auto/prompt.md`, an experiment is running or pending, or the user says autoresearch is running. Do not infer running state from a `.auto/` folder alone.

If agents would otherwise be useful, stop and ask the user to turn off or finish autoresearch first.

## The balance

- **The lead owns the result.** The lead retains integration, cross-lane decisions, scope tradeoffs, verification synthesis, and final acceptance. If only one substantive execution lane exists, the lead executes it.
- **Read agents multiply genuine independent coverage.** Use them for bounded investigation, review, testing, audits, and second opinions only when each lane returns distinct useful evidence.
- **Edit agents are optional and rare.** A writer owns exactly one isolated sub-outcome with non-overlapping files. Use `write-system` for normal complex implementation, integration, or refactoring inside that lane; reserve `write-critical` for rare high-risk security, concurrency, recovery, migration, or data-integrity work. Neither tier allows broad cross-stack ownership. Edit agents must claim files before writing and report every changed path.
- **Nested read helpers require explicit opt-in.** Only a depth-0 `write-feature` or `write-critical` spawn with `allow_nested_read_agents: true` receives restricted read-only spawn tools. It may use any canonical `read-*` tier and any helper count subject to global capacity; children report to that writer and cannot delegate. Read agents, depth-1 children, `write-patch`, and `write-system` remain denied.

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
      prompt: `Mode: READ-ONLY
Question: Does this branch contain changes outside accepted commits 1a2b3c4 and 5d6e7f8?
Expected delta: Exact unexpected commits or paths, or an evidence-backed clean verdict.
Known: [verified] source: command "git status --short" -> no output; [decision] source: user request -> only 1a2b3c4 and 5d6e7f8 belong to this change.
Inspected: working-tree status only, using the command above.
Do not rediscover: working-tree cleanliness; reuse the supplied command result.
Dependencies consumed: baseline commit IDs 1a2b3c4 and 5d6e7f8 plus the supplied status result.
Inspect branch/log/diff boundaries and report commands, unexpected changes, uncertainty, and the next bounded question. Do not edit.`
    },
    {
      name: "test-gaps",
      prompt: `Mode: READ-ONLY
Question: Which replay or concurrency behavior in src/auth/token-service.ts remains untested?
Expected delta: Concrete missing cases tied to file:line, or evidence coverage is sufficient.
Known: [verified] source: command "pnpm exec vitest run test/auth/token-service.test.ts" -> 18/18 passed; [decision] source: user acceptance criterion -> rotation must invalidate the predecessor token.
Inspected: source: lead inspection of src/auth/token-service.ts:42-71 and test/auth/token-service.test.ts:10-88 -> rotate() plus happy-path and single-request replay coverage.
Do not rediscover: changed paths or rerun the passing command; reuse the supplied paths and result.
Dependencies consumed: exact paths/lines and focused-test command/result above.
Inspect only the concurrent rotation path and focused tests. Report gaps, coverage boundary, and next test question. Do not edit.`
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
  prompt: `Mode: READ-ONLY
Question: Does docs/guide.md still use retired agent-tool names?
Expected delta: Exact stale lines and replacements, or a bounded clean verdict.
Known: [verified] source: README.md#public-tools and extensions/tools/team-tools.ts public schemas -> current spawn tools are spawn_agent and spawn_swarm_agents.
Inspected: README.md#public-tools against those two schema names.
Do not rediscover: README.md; reuse the supplied section and exact tool list.
Dependencies consumed: README.md#public-tools and the two current schema names above.
Inspect docs/guide.md only for retired alternatives and report searched terms, lines, uncertainty, and next action. Do not edit.`
})
```

Spawn an edit agent only for isolated work:

```text
spawn_agent({
  name: "docs-fix",
  model_slot: "write-patch",
  prompt: `Mode: EDIT-ALLOWED
Question: Can docs/guide.md be corrected to use only spawn_agent and spawn_swarm_agents?
Expected delta: A minimal docs-only patch replacing the retired names team_create and task_assign.
Known: [verified] source: docs-review report R-17 -> retired names occur at docs/guide.md:42 and :58; [decision] source: docs/reference.md#agent-tools -> replacements are spawn_agent and spawn_swarm_agents.
Inspected: docs-review report R-17 searched docs/guide.md for all four names.
Do not rediscover: tool-name inventory; use report R-17 and reopen only if the file conflicts.
Dependencies consumed: docs-review report R-17 and docs/reference.md#agent-tools.
Claim docs/guide.md only, make the two replacements, run the focused docs reference check, then report changed paths, command/result, conflicts, and next action via report_and_exit.`
})
```

For a bounded feature or critical writer that genuinely needs independent read evidence, the lead may explicitly opt in restricted nested helpers:

```text
spawn_agent({
  name: "parser-feature",
  model_slot: "write-feature",
  allow_nested_read_agents: true,
  prompt: `Mode: EDIT-ALLOWED
Question: Can parseConfig reject duplicate keys while preserving existing valid inputs?
Expected delta: A bounded parser implementation plus focused regression tests.
Known: [verified] source: issue #214 reproduction with duplicate lines "a=1" then "a=2" -> last value currently wins; [decision] source: issue #214 acceptance criteria -> reject the second key with its line number.
Inspected: source: lead inspection of src/parser/config.ts:20-64 and test/parser/config.test.ts -> parsing is isolated there and current tests cover valid unique keys.
Do not rediscover: reproduction, acceptance behavior, or parser ownership; reuse the supplied issue evidence and paths.
Dependencies consumed: issue #214 reproduction/acceptance criteria and the inspected paths above.
Claim only src/parser/config.ts and test/parser/config.test.ts, implement and run the focused parser test. If you spawn an independent read-only evidence lane, give the child the same Context handoff contract; it does not inherit this conversation. Report changed paths, command/result, remaining uncertainty, and next action via report_and_exit.`
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
- When new, changed, or previously omitted evidence affects an active owner, use `send_message` with an **Evidence delta** as defined below instead of replacing or stopping it. Active in-process read agents receive the message as a steering turn and can continue intelligently; active tmux writers wake through their inbox.
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
- `spawn_swarm_agents` — start a batch of agents with optional shared `model_slot` and `allow_nested_read_agents` defaults.
- `stop_teammate` — explicitly stop one active agent when cancellation is requested.
- `check_teammate` — inspect one agent's health when needed.
- `send_message` — send a direct message in the current session.
- `read_inbox` — read the current session inbox.

Edit-agent coordination tools:

- `claim_file` — reserve paths before editing.
- `release_file` — release held claims.
- `list_file_claims` — inspect active claims.
- `report_and_exit` — send the final report, release claims, and shut down.

## Context handoff contract

Agents start in isolated sessions and know only what their mission tells them. Before spawning, decide how the lane should use existing evidence:

- **Augment/reuse (default):** pass accepted evidence and ask for the next information delta.
- **Corroborate:** pass the claim and its evidence, then ask for confirmation or refutation.
- **Blind re-derive (exception):** withhold only conclusions or persuasive evidence that could anchor an independent check. State why the confidence gain justifies duplicate work, what is blinded, and require comparison after the agent records its result. Never blind user constraints, safety boundaries, acceptance criteria, changed surfaces, or the exact question.

Give the lane a compact handoff card containing only context that changes its work; cite long reports rather than pasting transcripts:

- **Question:** one exact unresolved lane question.
- **Expected delta:** the new evidence, decision, verdict, explanation, or bounded artifact the lead needs.
- **Known:** relevant facts, binding decisions, prior attempts, and results, each with a source. Label claims `[verified]`, `[reported]`, `[hypothesis]`, `[open]`, or `[conflict]`; label binding choices `[decision]`.
- **Inspected:** files, symbols, commands, tests, and boundaries already covered.
- **Do not rediscover:** accepted facts or coverage to reuse. Reopen them only when new conflicting evidence appears.
- **Dependencies consumed:** accepted reports, decisions, interfaces, or checks on which the lane relies.

Duplicate work only when independent verification changes confidence enough to justify its time and token cost. Do not use blind duplication for inventories, ordinary file discovery, or routine test-gap review.

When relevant evidence arrives after spawning, send each affected owner an **Evidence delta**: its source and label, what changed or was previously omitted, which premise/dependency/do-not-rediscover boundary it affects, and the requested next action. Do not forward a transcript or send a vague “consider this” message.

Require every final report to answer its expected delta, cite evidence, list inspected or searched boundaries, label new facts and uncertainty, identify conflicts and dependencies consumed, preserve negative results, and state what the next lane must not repeat plus its next bounded question. Writers also report changed paths and checks.

## Writing good agent missions

Give every agent:

- one bounded independent sub-outcome or question (never the whole User request),
- the compact context handoff card above,
- relevant files, symbols, or search boundaries,
- the right `model_slot` tier (`read-*` for read-only, `write-*` for edit-allowed),
- the reusable report shape you want,
- and verification expectations.

Good read mission:

```text
Mode: READ-ONLY
Question: Can concurrent refresh requests replay a predecessor token?
Expected delta: A confirmed finding or evidence-backed “not reproducible” verdict.
Known: [reported] source: CI job #1842 concurrent-refresh case -> token reuse assertion failed once; [decision] source: auth acceptance criterion AC-3 -> rotation must invalidate the predecessor.
Prior result: [verified] source: command "pnpm exec vitest run test/auth/token-service.test.ts -t replay" -> 1/1 passed, but it issued no concurrent requests.
Inspected: source: auth-contract report reports/auth-contract.md#rotation -> src/auth/token-service.ts:rotate() and happy-path tests.
Do not rediscover: token format or single-request invalidation; reuse AC-3, the command result, and the cited report section.
Dependencies consumed: reports/auth-contract.md#rotation, CI job #1842, AC-3, and the exact replay command/result above.
Uncertainty: [open] whether invalidation and replacement are atomic.
Inspect only the persistence/transaction path and focused concurrency tests. Report the verdict, file:line or command evidence, searched boundary, remaining uncertainty, and the next bounded fix/test question. Do not edit.
```

Good edit missions use the same card. The complete `docs-fix` and `parser-feature` prompts above are the copyable edit patterns; do not shorten them to a bare file-and-command instruction.

## When you are spawned as an agent

- Start by reading your initial instructions.
- Use `send_message` for direct communication and `read_inbox` when the extension wakes you or you expect a reply.
- Never sleep, busy-wait, or poll.
- Unless you are an explicitly opted-in depth-0 `write-feature` / `write-critical` writer, you cannot spawn other agents; ask the lead with `send_message`.
- If opted in, use only the restricted spawn tools for depth-1 read helpers within your lane. Any canonical `read-*` tier and helper count is allowed subject to global capacity; children report to you and cannot delegate. Give each child the same Context handoff contract because it does not inherit your conversation or implementation context.
- Read agents: investigate, report, and stop.
- Edit agents: claim files before editing, release claims when done, and call `report_and_exit` with your final report.
