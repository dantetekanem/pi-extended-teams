# pi-extended-teams

**A control-first subagent system for Pi.**

pi-extended-teams lets the lead split work into bounded lanes, watch agents live, steer or stop them, and receive their reports. The lead still makes the final call.

Read agents are the default. Edit agents are opt-in and should own isolated files.

[![Three agents working in parallel inside Pi](https://raw.githubusercontent.com/dantetekanem/pi-extended-teams/main/assets/pi-extended-teams-in-action.png)](https://raw.githubusercontent.com/dantetekanem/pi-extended-teams/main/assets/pi-extended-teams-in-action.png)

## Try without installing

```bash
pi -e npm:pi-extended-teams
```

This runs the published package for the current Pi invocation without adding it to your project configuration.

## Install and run

Install from npm:

```bash
pi install npm:pi-extended-teams
```

Or install directly from GitHub:

```bash
pi install git:github.com/dantetekanem/pi-extended-teams
```

For the first run, start with:

```text
/pi-extended-teams-onboard
```

On a new installation with no pi-extended-teams settings, a startup notice points to this command. It gives the current agent a read-only snapshot of the models, favorite tiers, shared extensions, and package source available in that Pi session. The agent recommends a setup, shows the exact changes it wants to make, and explains how to update the installed package. Nothing changes until you approve it. Run the command again whenever your models or extensions change.

Then ask for help naturally:

```text
Review the current changes with separate agents for correctness, test gaps, and security. Give me the evidence so I can make the final call.
```

The current Pi session becomes the agent group automatically. Setup remains optional: an unset tier inherits the current lead-session model and thinking level. Use `/agents-favorite-models` to configure tiers directly and `/agents-extensions` to choose which observable loaded extensions spawned agents receive.

## How it works

- Public read and edit agents run in separate in-process Pi sessions. A write tier grants edit tools; it does not open a terminal pane. The terminal runtime remains available for existing integrations.
- The activity card shows progress, intent tier, elapsed time, tokens, and tool activity.
- You can open an agent's transcript, send it a message, interrupt a stuck tool command, or stop it.
- Completed reports return to the lead automatically and remain recoverable when needed.
- `get_agent_status` gives the lead or an eligible nested parent one read-only snapshot of owned active, queued, stalled, or recently completed read and edit agents. It uses current-run evidence, preserves lifecycle quarantine, and does not perform cleanup.
- Every spawn names an intent tier instead of choosing ad hoc model settings. Configured favorites take priority; unset tiers inherit the current lead model and thinking.
- Edit agents can claim isolated files. Claims coordinate cooperative agents; they are not access control.
- Lazy session context and nested read helpers are available when a bounded task needs them.

This works well for multi-angle code review, root-cause investigation, parallel verification, repository mapping, and one narrow edit that can stay separate from the lead's work.

## Live control

With the editor empty, press Down to open agent navigation. Use Down/Up to move, `l` to expand large tool logs, `m` to message an agent, `i` to interrupt its currently running tool command, `x` to stop the whole agent, and Escape to return.

Inside Herdr, press `h` in an ordinary direct agent's preview to move it into a focused sibling Pi pane in the same workspace. Its conversation and team communication continue there. Nested helpers and delegation-enabled or workflow agents are excluded.

Scroll the transcript with Page Up/Page Down or the mouse wheel, including under Herdr. Press End or scroll back to the bottom to follow new output.

The lead can invoke the same command-only behavior with `interrupt_teammate({ agent_name: "agent" })`. It keeps the agent's session, task context, and file claims intact so you can send follow-up work. In-process cancellation is cooperative and may report that it is still pending; for tmux-backed agents, success means Pi's Escape key was delivered, not that command settlement was independently confirmed.

[![Inspecting and messaging a running agent](https://raw.githubusercontent.com/dantetekanem/pi-extended-teams/main/assets/pi-extended-teams-agent-navigation.png)](https://raw.githubusercontent.com/dantetekanem/pi-extended-teams/main/assets/pi-extended-teams-agent-navigation.png)

Completed reports wake the lead automatically. End the current turn to wait. One `get_agent_status` snapshot is allowed when current status is needed; do not poll with sleeps, loops, or repeated checks. Use `check_teammate` only when `get_agent_status` shows a suspected lifecycle failure or a persisted report needs recovery.

The lead owns decomposition, integration, and acceptance. Pi packages and spawned agents run with your system permissions, so review project-local instructions and configuration through Pi's normal trust flow.

## Task outcomes and full reports

A final report or clean exit does not mean the task succeeded. Agents can include an explicit outcome with their full report:

```text
report_and_exit({
  content: "The implementation needs a product decision. Full findings follow…",
  summary: "API decision needed",
  outcome: "blocked",
  questions: ["Should the endpoint require authentication?"]
})
```

Optional outcomes are `succeeded`, `blocked`, `failed`, and `cancelled`. Reports can also include `changedPaths`, `artifacts` (`path`, optional `label`), and `findings` (`id`, `text`, `evidence`). Finding IDs must be unique within the report. These are agent-reported claims and references, not independent verification.

New reports store a versioned `result` with runtime-assigned task, run, and report IDs in `reports.json`; the full Markdown report remains unchanged. Repeating the same run's report preserves the first stored report. Plain reports remain supported, and omitted outcomes stay unspecified.

Without assigned checks, verification is `not-requested`. Lead acceptance starts as `pending`. Agent-reported claims cannot change either state. Trusted integrations can record an explicit decision through `recordReportAcceptance(teamName, reportId, "accepted" | "rejected", reason?)` in `src/utils/report-events.ts`. Final-report tools cannot assign identities, verification, or acceptance.

`get_agent_status` shows task outcome separately from lifecycle status. The lead can recover the full persisted result through `check_teammate` after the agent leaves the roster.

## Assigned checks

The lead can attach explicit checks to `spawn_agent`, individual swarm agents, or swarm defaults:

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

Each check needs a unique name, a command, and a finite positive per-command timeout in seconds. Commands run through Pi's native local BashOperations in the agent's cwd, before its final report closes the recipient. Swarm agents inherit defaults; `checks: []` disables that inheritance. Nested helpers cannot assign checks, and report fields or metadata cannot authorize commands. Trusted spawn integrations receive `checks` on the orchestration request and must bind them as the admitted member's `assignedChecks`.

Verification records the actual exit, full output, and source before and after execution. Fingerprints include Git HEAD/index metadata, tracked working-file bytes, and nonignored untracked files. Optional `inputs` are literal paths relative to the agent's cwd, contained within its repository; omitting them covers the repository. Unsupported source inputs or Pi runtimes fail visibly rather than falling back to another command runner.

Check records and private full logs live under `~/.pi/teams/<team>/checks/`. Report IDs reference their check IDs. `listTeamReportEvents` and orchestration/status reads recheck current source and expose stale verification without rewriting historical evidence. After roster removal, `check_teammate` retrieves the report, observed check records, and full-log paths. Ordinary lead notifications include verification state, not full logs.

Duplicate submissions do not rerun commands. An unresolved execution claim is not replayed and prevents clean finalization. In-process interruption and shutdown cancel assigned checks and wait for raw settlement; nonsettling operations remain quarantined without releasing claims. Failed checks do not imply a failed lifecycle, overwrite the reported task outcome, or grant lead acceptance. Automatic repair is disabled unless explicitly authorized.

These fingerprints are observations, not snapshots or workspace isolation. They do not capture ignored/external inputs, external services, or edits restored between observations. Checks and agents share the host's permissions; this is not a sandbox against other same-user processes.

## Optional bounded repair

Add `repair: { maxAttempts: 1 }` to a spawn with assigned `checks` to allow one additional repair attempt after initial verification. The limit is zero to five; zero disables repair. Swarm defaults are inherited, and an agent can override them with `{ maxAttempts: 0 }`. Only the lead or a trusted integration can authorize repair. Metadata, report parameters, and nested helpers cannot enable it. Trusted integrations bind the request's `repair` as the member's `repairPolicy`.

A failed check returns its observed exit and full-log reference to the responsible agent. A `report_and_exit` repair receipt has `accepted: false` and a `repairRequest`; the agent remains active, repairs only its assigned scope, and resubmits. Repair does not grant edit permissions: read agents must report a blocker when edits are needed, and edit agents must keep or reacquire claims before changing files. Plaintext reporting uses a separate repair turn after current work settles. An accepted final-report receipt is still separate from lead acceptance.

The harness reruns failed checks and checks whose scoped inputs changed. It reuses passed evidence only when the current scoped source matches. Runtime submission IDs prevent duplicate reports from consuming another attempt. Reservations and decisions are persisted before check execution or repair feedback; cancellation prevents further automatic attempts. A pending native claim or controller reservation keeps cleanup fenced even after in-process state is lost. A stop may therefore report blocked cleanup rather than claim the agent stopped.

Repair history lives under `~/.pi/teams/<team>/repairs/`. The report's `repair` includes its controller ID, ledger path, state, and available attempt counts/request IDs. Missing or corrupt records remain pending with an error; unknown counts are omitted. `listTeamReportEvents`, status, and report recovery read authoritative repair/check evidence without rewriting history. `readStoredTeamReportEvent` retrieves an exact historical record without observing source.

Exhausted, declined, cancelled, or otherwise blocked repair produces an effective blocker while preserving the agent's reported `outcome`. `effectiveTaskOutcome(result)` exposes that distinction to trusted consumers. Passing checks never invent a success claim or grant lead acceptance. Existing reports and spawns without a repair policy retain their behavior.

## Optional grouped reports

The lead can request compact reports for a batch:

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

Omitting `completion_group` keeps immediate full-report delivery. `delivery: "immediate"` sends compact member indexes; `"all-settled"` waits for the batch, including queued members. Rejected admissions, cancellations and interruptions have explicit states. Blockers, runtime failures and failed/stale verification can request an early wake. An urgent last result does not require a redundant final wake.

Reported members' indexes include task/run/slot identity, reported and effective outcomes, verification, acceptance, findings/questions, and a full-report ID/path. Unadmitted assignments retain their slot/state/reason without invented run IDs or results. Read the referenced Markdown when more evidence is needed; it survives private transcript deletion. Index verification is a stored snapshot, so recheck current source-bound evidence before accepting work. Group settlement never grants task success or lead acceptance. Nested reports still target their exact parent, and workflow/pi-prompt suppression excludes lead-facing evidence and wakes.

Journals live under `~/.pi/teams/<team>/completion-groups/`. A sibling `<inbox>.json.durable` marker keeps an opted-in inbox's later writes synchronized even after its last grouped index is removed; never-grouped inboxes retain ordinary atomic writes. The harness binds membership before admission and actual run IDs before launch; agent metadata cannot authorize grouping. Reload preserves explicit terminal states, records lost unadmitted work as interrupted, and leaves uncertain running ownership unresolved. It does not restart work, revive recipients or release claims.

A durable inbox index and a wake request have separate receipts. Pi's custom-message call does not return an admission acknowledgment. A reserved request remains `pending` until exact session history is `observed`; that observation is not provider success or a power-loss guarantee. Ambiguous requests are not automatically repeated after errors or reload. Use `read_inbox` for a saved index when a warning reports an unconfirmed wake. Grouped correlation requires Pi's custom-message/history APIs; ordinary delivery keeps its existing fallback.

### Measured delivery replay

One September 8, 2026 comparison used Pi 0.85.1 and configured `read-review` model `openai-codex/gpt-5.6-terra`, high thinking. Two fresh SDK sessions synthesized the same ten supplied source-backed reports, first immediate/full, then all-settled/compact. SSE transport, retries and compaction settings were identical; retries and compaction were disabled.

| Observation | Immediate/full | All-settled/compact |
| --- | ---: | ---: |
| Wake requests | 10 | 1 |
| Model requests / assistant responses | 11 | 3 |
| Provider input tokens, excluding cache | 17,796 | 5,149 |
| Cache-read tokens | 17,408 | 5,120 |
| Cache-write tokens | 0 | 0 |
| Output tokens | 293 | 237 |
| Full-report retrievals | 0 | 1 |
| Elapsed time | 26.239s | 10.748s |

Both syntheses preserved all ten required finding/control pairs, pending acceptance and the exact detail retrieved from full report F9. Each session emitted one `agent_settled` event; wake requests are not equivalent to completed agent runs. These are actual provider usage figures from one controlled replay, not estimates, randomized statistics, new specialist investigations or a general review-speed guarantee. The [measurement record](docs/grouped-report-measurement.json) retains the assignment, complete corpus, tested source identity, method and observations without session histories or credentials.

## Intent tiers

Every spawn names a `model_slot`. Configured favorites take priority; otherwise the tier uses the current lead-session model and thinking level:

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

`read-review` is the normal read default. Legacy tier names remain accepted for this minor release, but new prompts should use the canonical names above.

## Explicit spawning

Pi can choose when delegation helps, or you can call the tools directly:

```text
spawn_swarm_agents({
  defaults: { model_slot: "read-review" },
  agents: [
    { name: "correctness", prompt: "Review the diff for concrete correctness risks. Do not edit." },
    { name: "tests", prompt: "Find missing regression coverage with file and line evidence. Do not edit." }
  ]
})
```

For an edit, choose a write tier and name the files it may claim. Never run overlapping writers against the same paths.

### Programmatic event launch

Another loaded extension can ask the lead session to launch one public agent through the orchestration event. Register the response listener and correlate it by `requestId` before emitting the request:

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

The correlated response is `{ requestId, type, ok: true, details, content }` on success or `{ requestId, type, ok: false, error }` on failure. `prompt` is always a direct string; it may tell the child where a packaged prompt file lives, but there is no `prompt_file` API. The configured extension allowlist still determines which tools are available inside the child session. Teammate sessions cannot satisfy these requests.

## Configuration

Global settings live at `~/.pi/agent/pi-extended-teams/settings.json`. Project overrides live at `.pi/pi-extended-teams.json`. Favorite intent tiers are global so `/agents-favorite-models` and spawning use the same choices. Configuring favorites is optional; an unset tier falls back to the current lead-session model and thinking level. `/pi-extended-teams-onboard` inspects both settings layers, recommends a complete model and extension policy, and gives source-specific package update instructions without changing either file on its first pass.

Public read and edit spawns respect their role's concurrency limit and overflow setting. Enabled overflow queues accepted work; disabled overflow returns a capacity error. Quarantined requests stay fenced without blocking unrelated eligible work. `stop_teammate` can cancel a queued request before launch. Failed admissions trigger an attempted recipient notification and remain visible in status (up to 20 recent failures). The public queue and recent failure index are session-local, not restart-durable.

Spawned sessions are private by default under `~/.pi/teams/<team>/agent-sessions/` and stay out of Pi's normal `/resume` picker.

## Security and data access

Read [SECURITY.md](SECURITY.md) for private vulnerability reporting and [docs/access.md](docs/access.md) for the subprocess, filesystem, extension, hook, and network boundaries.

## Development

```bash
pnpm typecheck
pnpm test:focused
```

## Credits

pi-extended-teams is based on [pi-teams](https://github.com/burggraf/pi-teams). This fork focuses on session-connected agents, live control, and a smaller public tool surface.

The broader coordination lineage includes [claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp).

## License

MIT
