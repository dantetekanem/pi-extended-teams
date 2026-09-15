# Agent reference

Setup, controls, and orchestration contracts for [pi-extended-teams](../README.md).

## Intent tiers

Every public spawn requires `model_slot`. Configured favorites take priority; unset tiers inherit the current lead model and thinking level. Direct `role`, `model`, and `thinking` spawn fields are not supported.

| Tier | Use it for |
| --- | --- |
| `read-collect` | Bounded facts, logs, inventories, or test output. |
| `read-review` | Normal review, verification, and test-gap work. |
| `read-analyze` | Root-cause analysis across connected evidence. |
| `read-critical` | Rare high-stakes security, architecture, concurrency, migration, or data reasoning. |
| `write-patch` | A narrow documentation, config, fixture, or bug fix. |
| `write-feature` | A bounded feature with a known design. |
| `write-system` | A cross-cutting integration or refactor inside claimed files. |
| `write-critical` | Rare high-risk security, concurrency, recovery, migration, or data-integrity work. |

`read-review` is the normal read default. Legacy tier names remain accepted for this minor release, but use canonical names in new prompts. Tiers identify the work; they do not guarantee a correct answer.

## Spawning and coordination

Public read and edit agents run in separate in-process Pi sessions. A write tier selects edit work; it does not open a terminal pane. The terminal runtime remains available for existing integrations.

```text
spawn_swarm_agents({
  defaults: { model_slot: "read-review" },
  agents: [
    { name: "correctness", prompt: "Review the diff for concrete correctness risks. Do not edit." },
    { name: "tests", prompt: "Find missing regression coverage with file and line evidence. Do not edit." }
  ]
})
```

Read agents are the default for independent questions. Keep cohesive implementation with the lead. Delegate edits only when files and outcomes can stay separate. Use file claims, and never assign overlapping writers.

### Nested read helpers

```text
spawn_agent({
  name: "recovery-fix",
  model_slot: "write-critical",
  allow_nested_read_agents: true,
  prompt: "In src/recovery.ts and test/recovery.test.ts, prevent cancelled jobs from resuming. Claim both files. Use read helpers to check cancellation paths, then report the fix and focused test results."
})
```

Only a depth-0 `write-feature` or `write-critical` agent with explicit opt-in receives nested spawn tools. Helpers use canonical `read-*` tiers, report to that parent, share its team and cwd, and cannot delegate further. `write-patch`, `write-system`, and read agents cannot spawn helpers. Global capacity still applies.

### Messages and context

Agents can address another running agent with `send_message({ recipient, content })`. Omitting the recipient addresses `team-lead`; missing or stopped recipients fail. Messaging does not grant orchestration authority. The lead owns scope, integration, and acceptance.

Each agent starts with an isolated conversation. Include the goal, file boundaries, decisions, evidence already collected, and the result you need. `session_context: "lazy"` exposes a bounded, filtered snapshot of the lead's active branch for on-demand reading. It does not eagerly copy the conversation or replace a useful assignment. See [the teams skill](../skills/teams.md) for handoff examples.

## Live controls

| Key | Action |
| --- | --- |
| Down, with the editor empty | Open agent navigation. |
| Up / Down | Previous / next agent; Up from the first returns to the lead. |
| Left / Right | Cycle through agents. |
| Page Up / Page Down or mouse wheel | Scroll the transcript, including under Herdr. |
| Home / End | Jump to the beginning / return to following new output. |
| `l` | Expand or collapse large tool logs. |
| `m` | Write a message to the selected agent. |
| `i` | Interrupt its running tool command without stopping the agent. |
| `x` | Stop the whole selected agent. |
| `h`, inside Herdr | Move an eligible agent into a focused sibling Pi pane. |
| Escape | Return to the lead; when composing a message, cancel the composer. |

Scrolling back to the bottom resumes following output. Navigation follows activity-row order, and agents still finishing cleanup remain accessible. The message composer clears while sending and restores your draft on failure if it remains open.

Panels and borders use Pi's theme. The shared `activityColors` palette controls agent names, tier shades, model/thinking colors, progress, and warnings. Context warnings appear at 75% and 90%.

### Herdr handoff

Press `h` in an ordinary direct agent's preview to resume its saved conversation in a focused sibling Pi pane in the same workspace. Team communication continues there. This is a handoff, not a second copy.

Nested helpers, delegation-enabled agents, and workflow agents are excluded. An active assigned check blocks transfer until it settles. Public spawning itself requires neither Herdr nor a terminal pane.

### Interrupt, stop, and wait

`interrupt_teammate({ agent_name: "agent" })` matches `i`: it preserves the session, task context, and claims. In-process cancellation is cooperative and may remain pending. For tmux-backed agents, success confirms Escape delivery, not command settlement. `stop_teammate` cancels the whole agent, including queued work.

Reports return automatically. The lead should end its turn to wait rather than poll. `get_agent_status` provides one read-only snapshot of owned active, queued, stalled, or recently completed agents; eligible nested parents can inspect their helpers too. It preserves lifecycle quarantine and does not clean up. Use `check_teammate` for a suspected lifecycle failure or recovery of a persisted report.

### Reload and costs

Running and starting agents survive same-process `/reload`, reconnecting controls, reports, and cost accounting. They keep their original implementation until an idle reload. Failed reconnection has a 60-second recovery window before cancellation starts. Quitting or changing sessions still cleans up agents; process-restart recovery is not supported.

Compatible footer extensions can display combined recorded cost for the main session and finalized in-process agents without changing Pi's native usage totals. Unfinished or missing usage keeps the total incomplete. Terminal handoffs are excluded.

## Configuration

Global settings live at `~/.pi/agent/pi-extended-teams/settings.json`. Project overrides live at `.pi/pi-extended-teams.json`. Favorite tiers are global so the picker and spawning use the same choices.

- `/pi-extended-teams-onboard` gives the current agent a read-only inventory of available models, favorite tiers, shared extensions, and package source. It recommends a setup, shows exact proposed changes, and explains updates. Nothing changes until approved. New installations show a startup notice; rerun onboarding when models or extensions change.
- `/agents-favorite-models` configures tier models and thinking levels. Type to filter full provider/model names from any picker column. Changes save immediately; thinking choices follow the model's capabilities.
- `/agents-extensions` chooses which observable loaded extensions spawned agents receive.

Public spawns respect each role's concurrency limit. Enabled overflow queues accepted work; disabled overflow returns a capacity error. Quarantined requests stay fenced without blocking unrelated eligible work. Failed admissions attempt recipient notification and remain visible in status, up to 20 recent failures. The public queue and failure index are session-local, not restart-durable.

Spawned sessions are private by default under `~/.pi/teams/<team>/agent-sessions/`, outside Pi's normal `/resume` picker.

## Task outcomes and full reports

A completed agent, a successful task, passed verification, and lead acceptance are separate facts.

```text
report_and_exit({
  content: "The implementation needs a product decision. Full findings follow…",
  summary: "API decision needed",
  outcome: "blocked",
  questions: ["Should the endpoint require authentication?"]
})
```

Optional outcomes are `succeeded`, `blocked`, `failed`, and `cancelled`. Reports also accept `changedPaths`, `artifacts` (`path`, optional `label`), and `findings` (`id`, `text`, `evidence`). Finding IDs must be unique. These are agent claims and references, not independent verification.

New reports store a versioned `result` with runtime-assigned task/run/report IDs in `reports.json`, alongside the unchanged full Markdown report. Repeating a run's report preserves the first stored report. Plain reports remain supported; omitted outcomes stay unspecified.

Without checks, verification is `not-requested`; lead acceptance starts `pending`. Report tools cannot assign identities, verification, or acceptance. Lead/trusted integrations can record acceptance through `recordReportAcceptance(teamName, reportId, "accepted" | "rejected", reason?)` in `src/utils/report-events.ts`. `get_agent_status` separates task outcome from lifecycle; `check_teammate` can recover the persisted result after roster removal.

## Assigned checks

```text
spawn_agent({
  name: "result-review",
  model_slot: "read-review",
  prompt: "Review task outcomes without editing files.",
  checks: [{
    name: "result-contract",
    command: "pnpm --config.verify-deps-before-run=false exec vitest run src/results/report-result.test.ts",
    timeoutSeconds: 60
  }]
})
```

Checks require unique names, commands, and finite positive per-command timeouts in seconds. They run through Pi's native local BashOperations in the agent cwd before final-report closure. Swarm defaults are inherited; `checks: []` disables inheritance. Nested helpers, report fields, and metadata cannot authorize checks. Trusted integrations bind request `checks` as `assignedChecks`.

Records capture exit, full output, and source before/after execution. Fingerprints cover Git HEAD/index metadata, tracked bytes, and nonignored untracked files. Optional `inputs` are literal repository-contained paths relative to cwd; omission covers the repository. Unsupported inputs or runtimes fail visibly without another runner fallback.

Private logs live under `~/.pi/teams/<team>/checks/`; reports reference check IDs. Status, orchestration reads, and `listTeamReportEvents` expose stale verification without rewriting history. `check_teammate` retrieves records and log paths after roster removal; ordinary notifications omit full logs.

Duplicate submissions do not rerun commands. Unresolved execution claims prevent clean finalization and are not replayed. Interruption/shutdown cancels checks and waits for raw settlement; nonsettling work remains quarantined with claims retained. Failed checks neither change lifecycle/task outcome nor grant acceptance. Fingerprints are observations, not snapshots or workspace isolation: ignored/external inputs, services, and edits restored between observations are outside coverage.

## Optional bounded repair

Add `repair: { maxAttempts: 1 }` with checks for one additional repair attempt. The limit is zero to five; zero disables repair, including inherited swarm policy. Only the lead or a trusted integration authorizes it; integrations bind `repair` as `repairPolicy`. Metadata, report parameters, and nested helpers cannot enable it.

A failed check returns its exit and full-log reference. An unaccepted `report_and_exit` receipt carries `repairRequest`: the agent stays active, repairs within scope, and resubmits. Read agents must report a blocker if edits are needed; writers keep or reacquire claims. Plaintext reporting uses a separate repair turn after work settles. Receipt acceptance is not lead acceptance.

The harness reruns failed checks and checks with changed inputs, reusing passes only for matching scoped source. Submission IDs prevent duplicate attempt consumption. Persisted reservations/decisions precede execution or feedback; cancellation prevents further attempts. Pending native/controller claims fence cleanup even after in-process state loss, so stop may report blocked cleanup.

History lives under `~/.pi/teams/<team>/repairs/`. Report `repair` includes controller ID, ledger path, state, available counts/request IDs. Missing/corrupt records remain pending with an error; unknown counts are omitted. Status/report recovery observes authoritative evidence; `readStoredTeamReportEvent` reads history without observing source.

Exhausted, declined, cancelled, or blocked repair preserves the reported outcome but adds an effective blocker, exposed through `effectiveTaskOutcome(result)`. Passing checks never invent success or acceptance. Spawns without repair retain ordinary behavior.

## Optional grouped reports

```text
spawn_swarm_agents({
  completion_group: { delivery: "all-settled" },
  defaults: { model_slot: "read-review" },
  agents: [
    { name: "correctness", prompt: "Review correctness without editing." },
    { name: "tests", prompt: "Review test coverage without editing." }
  ]
})
```

Omission keeps immediate full reports. `"immediate"` sends compact member indexes; `"all-settled"` waits for the batch, including queued members. Rejections, cancellations, and interruptions retain explicit states. Blockers, runtime failures, or failed/stale checks can wake early; an urgent last result needs no redundant final wake.

Indexes include task/run/slot identity, reported/effective outcomes, verification, acceptance, findings/questions, and full-report references. Unadmitted assignments retain state/reason without invented identities. Full Markdown survives private transcript deletion. Recheck source-bound evidence before acceptance; settlement grants neither success nor acceptance. Nested reports target their exact parent; workflow/pi-prompt suppression excludes lead-facing evidence and wakes.

Journals live under `~/.pi/teams/<team>/completion-groups/`. A sibling `<inbox>.json.durable` marker keeps opted-in inbox writes synchronized; never-grouped inboxes use ordinary atomic writes. Membership binds before admission, run IDs before launch; metadata cannot authorize grouping. Reload retains terminal states, marks lost unadmitted work interrupted, and leaves uncertain ownership unresolved without restarting work, reviving recipients, or releasing claims.

Inbox persistence and wake requests have separate receipts. Pi's custom-message call has no admission acknowledgment: a reserved request stays `pending` until exact history is `observed`, not provider success or a power-loss guarantee. Ambiguous wakes are not retried automatically. Use `read_inbox` when warned of an unconfirmed wake. Grouped correlation needs Pi's custom-message/history APIs; ordinary delivery retains its fallback.

### Measured delivery replay

One September 8, 2026 controlled replay on Pi 0.85.1, `openai-codex/gpt-5.6-terra`, high thinking, compared two fresh SDK sessions synthesizing ten supplied reports. SSE transport/settings matched; retries and compaction were disabled.

| Observation | Immediate/full | All-settled/compact |
| --- | ---: | ---: |
| Wake requests | 10 | 1 |
| Model requests / assistant responses | 11 | 3 |
| Provider input tokens, excluding cache | 17,796 | 5,149 |
| Cache-read / cache-write tokens | 17,408 / 0 | 5,120 / 0 |
| Output tokens | 293 | 237 |
| Full-report retrievals | 0 | 1 |
| Elapsed time | 26.239s | 10.748s |

Both preserved all ten finding/control pairs, pending acceptance, and the exact F9 detail. Each emitted one `agent_settled`; wake count is not completed-run count. These are provider observations from one fixed full-then-compact replay, not randomized statistics, new investigations, or a general speed guarantee. The [measurement record](grouped-report-measurement.json) contains the corpus, assignments, source identity, method, and limits without histories or credentials.

## Optional specialist continuation

```text
spawn_agent({
  name: "auth-review",
  model_slot: "read-review",
  prompt: "Review auth and config. Report stable finding IDs, evidence and inspected source references.",
  checkpoint: { inputs: ["auth", "config"], retentionDays: 30 }
})
```

Checkpoints preserve assignment, scoped source observations, author/run/tier, findings, questions, `inspectedEvidence`, lead-supplied `decisions`, and independent report references. They retain the original report plus bounded recent history, limited to 64 KiB under `~/.pi/agent/checkpoints/`, outside private transcripts and `/resume`. Ordinary spawning is unchanged when omitted. Swarm defaults/agents accept `checkpoint`; `continue_from` belongs on individual agents. Metadata and nested helpers cannot enable either.

```text
spawn_agent({
  name: "auth-followup",
  model_slot: "read-review",
  continue_from: "checkpoint:<saved hash>",
  prompt: "Recheck F1 and F2 after the tenant fix. Revalidate token-policy dependencies, including unchanged callers."
})
```

Use the exact saved ID. The name becomes a prefix for a fresh recipient/run/SDK session. Current cwd, prompt, tier, instructions, permissions, checks, and repair govern. Continuation does not reopen a mailbox/transcript, resume a process, transfer claims, or inherit permissions/budgets. Old evidence is historical; writers acquire claims normally.

Scope/retention inherit unless overridden by a current `checkpoint`; old decisions are not reauthorized. Inputs are literal repository-contained paths relative to cwd. Actual launch, including queued launch, reloads the checkpoint and compares retained dependency scopes. Changed/uncertain evidence requires revalidation beyond the diff. Unchanged fingerprints prove neither findings nor dependency graphs; ignored/external inputs and restored edits remain outside coverage.

Full reports synchronize independently before publication/cleanup. Missing provenance or uncertain publication blocks destructive cleanup. In-process admission supports continuation; legacy terminal startup/queues reject it, though existing producers can preserve checkpoint-bound reports. Trusted requests use `continueFrom`; custom starters own admission/execution.

Retention defaults to 30 days (1 to 365). Lead-only `/agents-checkpoints list` and `/agents-checkpoints delete <checkpoint ID>` manage records. Startup retires expired records and reports corruption without discarding healthy siblings. Missing/incompatible/corrupt/deleted/expired selections fail visibly. Deletion permanently prevents continuation/replay, not independent history or already-delivered context.

### Measured follow-up

One September 8, 2026 pair on Pi 0.85.1 and `openai-codex/gpt-5.6-terra`, high thinking, compared fresh then checkpoint follow-ups with identical source/task/tools. The original scripted investigation's SDK session and private transcript were removed first. Both correctly classified fixed tenant isolation, broken expiration, and unsigned-token acceptance reopened through a changed dependency.

| Observation | Fresh | Checkpoint |
| --- | ---: | ---: |
| Model / HTTP requests | 3 / 3 | 3 / 3 |
| Provider input tokens, excluding cache | 1,841 | 3,789 |
| Cache-read / cache-write tokens | 0 / 0 | 1,536 / 0 |
| Output tokens | 267 | 233 |
| File reads / unchanged-file rereads | 3 / 1 | 3 / 1 |
| First useful persisted result | 8.682s | 8.344s |
| Elapsed through final response | 10.296s | 10.156s |

No read or input-token savings appeared: input including cache was 1,841 versus 5,325. One fixed-order pair cannot establish speed improvement. Each emitted one `agent_settled`; acceptance stayed pending. Real SDK/checkpoint APIs were exercised, not production admission-to-teardown or process restart. The pair predates replay, missing-report cleanup, and native cancellation fixes. The [public record](continuation-measurement.json) contains corpus, assignments, historical source, results, and limits; scripted usage remains null.

## Programmatic event launch

Another loaded extension can request an agent from the lead session. Register a response listener correlated by `requestId` before emitting:

```ts
pi.events.emit("pi-extended-teams:orchestration-request", {
  requestId,
  type: "spawn_agent",
  ctx, // pass the current Pi command context when needed
  params: {
    name: "implementation",
    prompt: "Implement the claimed change and report the evidence.",
    cwd,
    model_slot: "write-critical",
    allow_nested_read_agents: true,
    metadata: { operationId },
  },
});
```

The correlated response is `{ requestId, type, ok: true, details, content }` or `{ requestId, type, ok: false, error }`. `prompt` is a direct string; it may reference a packaged prompt file, but there is no `prompt_file` API. Normal tier/capacity/lifecycle rules and the extension allowlist apply. This is a lead-session event-bus integration, not external RPC; teammate sessions cannot satisfy requests.

## Security and data access

Read-only roles are behavioral instructions, not sandboxes. Current in-process sessions include base edit/write tools; selected extensions can add capabilities too. Agents run with your system permissions. File claims coordinate cooperative writers, not filesystem access control. Review project instructions and configuration through Pi's normal trust flow.

Read [SECURITY.md](../SECURITY.md) for private vulnerability reporting and [access.md](access.md) for access disclosures covering subprocesses, files, extensions, hooks, and networking.
