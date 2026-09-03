# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Add one-shot `get_agent_status` snapshots for leads and eligible nested write parents, including active, queued, and recently completed read and edit agents.

### Changed
- Tell parent agents to end their turn for automatic report delivery and distinguish one status snapshot from repeated polling.

## [2.2.1] - 2026-09-01

### Changed
- Use the darker base-panel theme color for the live agent view instead of the brighter custom-message background.

## [2.2.0] - 2026-08-28

### Added
- Add the lead-only `interrupt_teammate` tool and live-view `i` shortcut for interrupting a stuck tool command without stopping the agent or releasing its claims.
- Include runtime-proven tmux writers in live navigation and deliver Pi's Escape interrupt without killing their panes.

## [2.1.19] - 2026-08-25

### Fixed
- Keep Page Up and Page Down inside the active subagent follow view when Pi runs in Herdr's regular pane mode.

## [2.1.18] - 2026-08-23

### Changed
- Make the agent activity and live follow views use the active Pi theme for their color roles, borders, and backgrounds.

## [2.1.17] - 2026-08-22

### Fixed
- Make the npm package command the primary README installation path while retaining GitHub as an alternative.

## [2.1.16] - 2026-08-22

### Changed
- Refresh the README as a concise control-first overview with current in-process agent and live-navigation screenshots.
- Include the screenshots and gallery metadata in the published package.
- Point intent-tier guidance to the README after removing the standalone tips document.

### Removed
- Remove the obsolete `TIPS.md` guide, its static documentation assertions, and the legacy tmux screenshot.

## [2.1.15] - 2026-08-18

### Fixed
- Notify the lead when the user stops a subagent, including the teardown status when cleanup is incomplete.
- Replace stale legacy management-command guidance with the live agent view.

### Removed
- Delete the unreachable legacy management panel and its tests; live agent navigation remains unchanged.

## [2.1.14] - 2026-08-17

### Fixed
- Keep macOS idle-sleep protection active for tmux-based write agents as well as in-process read agents.

## [2.1.13] - 2026-08-01

### Fixed
- Keep completed agent reports in the lead model context without rendering their full bodies later in the transcript.

## [2.1.12] - 2026-07-30

### Fixed
- Show each running agent's current context-window usage as tokens and percentage instead of cumulative billed and cache traffic.
- Start newly spawned agents at `0 tok (0%)` until provider-reported usage is available, while preserving unknown usage after compaction.

### Changed
- Refresh the README with the current six-agent live activity view.

## [2.1.11] - 2026-07-28

### Fixed
- Keep lead-team adoption resilient to stray filesystem entries and preserve inbox delivery when lifecycle telemetry has no run identity.
- Quote Pi launch paths safely before `sh -c` evaluation and contain rejected timer-driven background work instead of terminating Pi.
- Stop refused read-agent teardown from leaking heartbeat timers or message delivery, and treat tombstones unlinked during a concurrent read as absent rather than corrupt.
- Write claims, shared memory, inboxes, and the read-helper queue through atomic replacement so interrupted writers cannot truncate live shared state.
- Canonicalize hand-edited favorite-model values at the settings load boundary.
- Report idempotent broadcast outcomes for every recipient without aborting successful sibling deliveries when one recipient is unavailable.

### Credits
- All fixes in this release were contributed by Dan Gayle ([@dangayle](https://github.com/dangayle)) through PRs [#6](https://github.com/dantetekanem/pi-extended-teams/pull/6), [#7](https://github.com/dantetekanem/pi-extended-teams/pull/7), [#8](https://github.com/dantetekanem/pi-extended-teams/pull/8), [#9](https://github.com/dantetekanem/pi-extended-teams/pull/9), [#11](https://github.com/dantetekanem/pi-extended-teams/pull/11), [#12](https://github.com/dantetekanem/pi-extended-teams/pull/12), [#14](https://github.com/dantetekanem/pi-extended-teams/pull/14), and [#15](https://github.com/dantetekanem/pi-extended-teams/pull/15).

## [2.1.10] - 2026-07-28

### Fixed
- Reuse the parent model runtime for nested read-agent sessions so Pi 0.82 custom providers and runtime-scoped credentials remain available.

## [2.1.9] - 2026-07-26

### Changed
- Align verbose tool headers at the left while preserving their piped output and result summaries.
- Preserve multiline thinking output without Markdown bold delimiters and place progress spacing directly before following block tools.

## [2.1.8] - 2026-07-26

### Added
- Keep macOS systems awake while agents are active with one idle-sleep assertion, without preventing display sleep, and release it after the last agent settles or the lead exits.

## [2.1.7] - 2026-07-26

### Fixed
- Persist spawned-agent sessions, recover accepted final content before teardown, fail with actionable session pointers instead of empty successful reports, and let the lead's `check_teammate` retrieve reports after roster cleanup.

## [2.1.5] - 2026-07-19

### Added
- Add opt-in lazy references to filtered, bounded snapshots of the lead's active Pi session branch.

### Changed
- Require context-rich agent missions and report effective lazy snapshot availability across read, write, swarm, and queued spawns.

### Security
- Bind snapshot creation and cleanup to validated identities, non-symlink paths, exact run directories, and allowlisted stale artifacts.

### Removed
- Remove the obsolete direct npm publishing script.

## [2.1.4] - 2026-07-16

### Changed
- Double the live agent progress animation frame rate for smoother message transitions.

## [2.1.3] - 2026-07-14

### Changed
- Remove the visible `progress:` label prefix while preserving live progress updates and neutral rendering.

## [2.1.2] - 2026-07-14

### Changed
- Restore subagent progress reporting while keeping each update as one ordinary neutral `progress:` field without the colored progress band.

### Fixed
- Treat lifecycle-closed progress persistence as a skipped best-effort update instead of failing the agent turn.

## [2.1.1] - 2026-07-14

### Changed
- Show retained progress as an ordinary labeled activity field instead of bespoke follow-view chrome.

### Fixed
- Stop spawned agents from receiving or being instructed to call the removed explicit progress-update tool.

## [2.1.0] - 2026-07-14

### Added
- Add four canonical read intent tiers and four write intent tiers, with backward-compatible normalization for legacy slot names.
- Let spawned agents use selected extensions observable in the lead Pi session while retaining normal trusted skill discovery.
- Persist run-scoped lifecycle tombstones so timed-out agents remain fenced across member removal and extension reloads.

### Changed
- Improve the live agent view with compact semantic tool rows, width-bounded output, and darker progress-band styling.
- Route active-agent messages directly into in-process sessions while preserving atomic inbox fallback for other agents.

### Fixed
- Make teardown, messaging, runtime cleanup, writer rollback, watchdog handling, and same-name replacement run-aware and fail-closed.
- Keep repeated stop and shutdown requests bounded while late cleanup remains safely observed.
- Canonicalize legacy model-slot names across public results, reports, queues, and status interfaces.

## [2.0.6] - 2026-07-14

### Added
- Support Pi models that advertise the `max` thinking level in favorite agent slots.

### Changed
- Derive favorite-model thinking choices from each scoped model's capabilities and clamp the selection when switching models.

## [2.0.5] - 2026-07-12

### Added
- The live agent view now includes a direct-message composer for the selected active agent.

### Changed
- Group tool calls with their results and collapse large outputs with head/tail context plus an expansion toggle.

## [2.0.4] - 2026-07-12

### Fixed
- `send_message` now fails instead of claiming delivery when its target subagent is no longer running.

## [2.0.3] - 2026-07-12

### Changed
- Require spawned agents to report progress before their first work tool and refresh it at concrete phase boundaries or within every three work-tool calls.

## [2.0.2] - 2026-07-12

### Changed
- Require outcome-based lane decomposition before delegation, keep sole execution lanes with the lead, and prevent one teammate from owning the whole request.
- Align team guidance on `model_slot`-only spawning and isolated writer scope.

## [2.0.1] - 2026-07-11

### Changed
- Matched the full-text spawned-agent view background to the requested dark navy color without changing other Pi panels.

### Fixed
- `read_inbox` now honors its documented unread-only default when callers omit `unread_only`, preventing previously read messages from replaying.

## [2.0.0] - 2026-07-11

### Added
- Stable below-editor activity card with live agent-authored progress, elapsed time, token usage, and compact progress transitions.
- Empty-editor Down navigation into a full-window live agent view; Up/Down navigates agents and `x` stops the selected agent.
- Extension-owned lead guidance for cheapest-sufficient read levels, delegated-lane ownership, literal waiting without polling, and report-first synthesis.
- Identity-deduplicated agent-message follow-ups that reach the lead even while another turn is active.

### Changed
- Advanced the extension to the requested `2.0.0` major release while keeping public spawning model-slot-only.
- Nested writer coordination is bound to the spawned member identity instead of shared process environment.
- `reading-fast` is the normal collection/research level, `reading-default` handles normal synthesis, and `reading-hard` is reserved for rare irreducibly deep or risky reasoning.
- Removed the redundant legacy management commands; the activity card, live agent view, pushed reports, and `x` stop action now provide the workflow.

### Fixed
- Restored `claim_file`, `release_file`, `list_file_claims`, and `report_and_exit` for in-process `writing-basic` and `writing-hard` agents.
- Writer final reports and cleanup are now idempotent and owned by the outer runner, so a nested writer exits without shutting down the lead session; read agents remain limited to messaging coordination tools.
- Session shutdown now stops active nested agents and clears their heartbeat, watchdog, inbox, wake, title, render, and file-watcher resources before reload.
- Progress and follow-view labels are sanitized before terminal rendering.

## [1.3.17] - 2026-06-28

### Changed
- Closed remaining runtime/exported bypasses so prompt-build agents, read-helper queues, write queues, predefined-team spawning, and orchestration requests resolve through configured favorite levels instead of direct model/thinking values.
- Low-level read/write agent launchers now validate that members match their configured `model_slot` before running.

## [1.3.16] - 2026-06-28

### Added
- Lead sessions now warn at boot when no favorite agent levels are configured.

### Changed
- Public agent spawning is level-only: `model_slot` is required, selects read/write behavior, model, and thinking, and direct `role`, `model`, or `thinking` spawn fields are rejected.

## [1.3.15] - 2026-06-28

### Fixed
- Bottom agent activity now omits assistant progress snippets; live thinking/progress remains available inside the legacy management overlay only.
- The legacy management overlay now labels each agent's level (`model_slot`), model, and thinking setting explicitly.

## [1.3.14] - 2026-06-28

### Added
- `/agents-favorite-models` single-screen picker for the five global favorite model slots, populated from the scoped models available to the current Pi session.
- `model_slot` support for `spawn_agent` and `spawn_swarm_agents`, including persisted model/thinking/slot metadata in completed reports.
- Live agent activity details now include model, thinking, selected slot, and visible assistant progress snippets when available.

### Changed
- Favorite model slots are global-only (`~/.pi/agent/pi-extended-teams/settings.json`) so the picker and spawn resolution cannot disagree because of project overrides.
- `spawn_swarm_agents` now treats per-agent model, thinking, or model slot fields as overrides for conflicting defaults instead of combining them.
- The bottom agent activity widget remains visible for runtime-backed active agents with fresh heartbeats, including after reload or in-memory state loss.

### Fixed
- The legacy management overlay no longer jumps between active and completed rows that share the same agent name during refresh.
- Lead-inbox progress messages with model/thinking metadata are no longer mistaken for completed reports unless they are explicit final reports.
- The favorite-model picker no longer displays or saves thinking-only empty slots.
- Read-agent progress updates no longer mask tool-working state when a non-assistant message update arrives.

## [1.1.0] - 2026-06-15

Seamless, rebalanced multi-agent flow: the lead stays the implementer, read
agents are the parallel multiplier, and write agents are an opt-in for isolated
work.

### Added
- **One-call team creation**: `team_create` accepts inline `agents` and spawns
  them immediately — no separate `task_create`/`spawn_teammate` ceremony.
- **Auto-delivered reports**: a finished read agent's report lands in the lead's
  main window as a collapsed one-line entry (name · elapsed · tokens, `ctrl+o`
  to expand), is fed into the lead's context, and is synthesized automatically —
  no inbox reading or polling.
- `promote_teammate`: move a running in-process read agent into its own tmux pane.
- The legacy management overlay shows each agent's model and thinking level.

### Changed
- Read agents have the **full toolset** (read, bash, edit, write, grep, find, ls)
  and run any read-only command; the system prompt — not a tool sandbox — directs
  them to investigate and report rather than edit.
- `spawn_teammate` defaults to `role: "read"`; write agents are the rare,
  isolated-work option. The lead writes by default.
- The legacy management view renders as a centered floating overlay — no inline flicker while the
  main agent streams — and bounds its height to the viewport.
- Any team operation now binds the current team, so the management view and report wakeups
  work on existing and reconnected teams.
- Quieter coordination: teammate/lead nudges use hidden trigger messages instead
  of visible chatter.
- Rewrote `skills/teams.md` around the rebalanced, minimal flow.

### Fixed
- The legacy management view no longer corrupts the input bar / scrollback on close.
- Status bar clears finished read agents and read reports promptly.

## [1.0.0] - 2026-06-14

First stable pi-extended-teams release: a tmux-only, role-aware agent team.
(Renamed from `pi-teams`; earlier multi-terminal history is not carried over.)

### Added
- In-process read agents with compact status and a management overview.
- Write-agent concurrency cap with a persistent FIFO queue plus inspection/cancel
  tools.
- Watchdog/reaper loop for stale teammates and queued-writer draining.
- `list_teammates`, shared-memory tools, and `use_skill`.
- Settings-driven per-role model/thinking categories.

### Changed
- **tmux-only**: write agents run in tmux panes; pi-extended-teams fails fast when
  not launched inside tmux.

### Fixed
- tmux `isAlive` checks pane existence via `display-message`, so teammate liveness
  is reported accurately.
