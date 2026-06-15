# pi-extended-teams — Implementation Plan

Renamed and re-homed at `https://github.com/dantetekanem/pi-extended-teams`,
with a tmux-only, self-managing, role-aware multi-agent runtime.

This document is the single source of truth for the migration and the new
feature set. Check items off as they land. Each phase has acceptance criteria
so "done" is unambiguous.

> **Status reconciliation (2026-06-15).** Phases 0–3, 5, 6, 7, 9 are
> implemented and covered by `vitest` (130 tests green, `tsc` clean). Phase 4
> (watchdog) ships its core loop and reaping but still lacks the explicit
> `working/idle/stalled/dead` state machine, re-spawn recovery, and dedicated
> tests. Phase 8 ships `list_teammates`, peer messaging, roster injection, and
> `broadcast_message`, but not automatic join/leave broadcasts. Remaining doc
> work lives in Phase 10. Items below are checked to match shipped code; `[~]`
> marks partial.

---

## Guiding principles

- **tmux only.** No other terminal backend is supported. Detection, adapters,
  and docs collapse to tmux.
- **Two agent roles.** `read` agents are read-only and run **in-process** in the
  background (no tmux pane). `write` agents spawn **normally in tmux**.
- **Nothing stale, nothing idle.** Every agent kills itself the moment its work
  is reported back. A watchdog loop catches anything that fails to.
- **Divide to conquer.** The lead decomposes work, fans it out, and never lets
  two writers touch the same file.
- **Config over code.** Buffers, model/thinking per role, and caps live in
  `~/.pi/agent/pi-extended-teams/settings.json`.

---

## Phase 0 — Repo migration & rebrand

Goal: consolidate all work onto `main`, re-home to the new origin, and strip
fork references. **Reversible local steps first; push last.**

- [x] Commit outstanding working-tree change (`extensions/index.ts` status-bar removal)
- [x] Fast-forward `main` to include all local-branch work (`local-spawn-inherit` is ahead by 4 commits; `main` is an ancestor — clean FF)
- [x] Rename package `pi-teams` → `pi-extended-teams` in `package.json`
- [x] Update `repository.url` → `dantetekanem/pi-extended-teams`
- [x] Update `pi.image` raw URL → `dantetekanem/pi-extended-teams`
- [x] Update `author` and old upstream attribution strings
- [x] Remove fork remotes and add new `origin`
- [x] `git branch -M main`, delete redundant `local-spawn-inherit` once merged
- [x] `git push -u origin main`
- [x] Update `README.md` title/badges/clone URL to the new repo
- [x] Refresh `CHANGELOG.md` with a `pi-extended-teams` heading

**Acceptance:** `git remote -v` shows only the new origin; `main` builds and
tests pass; no old upstream attribution strings remain (`grep -rI` clean).

---

## Phase 1 — tmux-only collapse

Goal: make tmux the only backend and delete the dead surface area.

- [x] Remove non-tmux adapters: `zellij-adapter`, `cmux-adapter`, `iterm2-adapter`, `wezterm-adapter`, `windows-adapter` (+ their tests)
- [x] Reduce `terminal-registry.ts` to tmux detection; error clearly if `TMUX` is unset ("pi-extended-teams requires running inside tmux")
- [x] Drop `separate_windows` / `spawn_lead_window` / `supportsWindows()` window paths from `extensions/index.ts`
- [x] Remove the `Iterm2Adapter` spawn-context branches in `spawn_teammate` and `create_predefined_team`
- [x] Delete now-irrelevant docs: `WEZTERM_SUPPORT.md`, `WEZTERM_LAYOUT_FIX.md`, zellij/iterm imagery references
- [x] Update `package.json` keywords (drop multi-terminal claims)

**Acceptance:** code references exactly one adapter; launching outside tmux
fails fast with a helpful message; test suite green.

---

## Phase 2 — Agent roles & model categories (config foundation)

Goal: introduce the `read` vs `write` role and a settings file that drives
per-role model/thinking. Today both roles share the current model; the schema
must already support diverging later.

- [x] Define settings loader for `~/.pi/agent/pi-extended-teams/settings.json` (global) with optional project override `<project>/.pi/pi-extended-teams.json` (`src/utils/settings.ts`)
- [x] Settings schema (initial):
  ```jsonc
  {
    "watchdog": { "bufferSeconds": 30 },        // Phase 4
    "writeAgents": { "maxConcurrent": 3, "queueOverflow": true }, // Phase 6 (queue, don't reject)
    "roles": {
      "read":  { "model": null, "thinking": null },   // null = inherit current model
      "write": { "model": null, "thinking": null }
    },
    "categories": {},                           // named role presets, see below
    "extensions": {                             // Phase 9 — which pi extensions spawned agents load
      "allow": ["pi-emote", "ada"],             // loaded into spawned (write) agents
      "block": []                               // explicitly kept out
    }
  }
  ```
- [x] Add `role: "read" | "write"` (and `category`) to the `Member` interface (`src/utils/models.ts`)
- [x] Resolve a member's effective model/thinking: explicit arg → category → role default → team default → current model (`resolveModel`)
- [x] Support **categories**: named presets (e.g. `"researcher"`, `"implementer"`) that bundle role + model + thinking, referenced by name at spawn time
- [x] `spawn_teammate` gains `role` (optional, defaults `write`) and optional `category` *(kept optional for backward compat; Phase 3 enforces read-agent semantics)*
- [x] Tests for settings precedence and category resolution (`src/utils/settings.test.ts`, 13 tests)

**Acceptance:** spawning with `role: "write"` and no model still works (inherits
current); setting `roles.write.thinking` in settings changes only writers.

---

## Phase 3 — In-process read agents + status UI

Goal: read-only agents do **not** spawn a tmux pane. They run as background
in-process agents, surfaced in a status line above the input bar (below
pi-emote), showing elapsed time and token usage.

- [x] Research pi's in-process sub-agent API (how `ExtensionAPI` can run a nested agent loop without a new pty); document findings in this file

  **Spike findings (verified against installed `@mariozechner/pi-coding-agent`):**
  - **Nested agents are feasible.** `createAgentSession({ cwd, model, tools, ... })`
    returns an `AgentSession`; `session.prompt(text)` runs it in-process, and
    `session.subscribe(listener)` streams events. SDK docs explicitly list
    "Build custom tools that spawn sub-agents" as a use case. Tools can be
    overridden per session (restrict a read agent to read/search/no-write).
  - **Status UI exists.** `ctx.ui.setWidget(key, lines, { placement: "aboveEditor" })`
    renders above the input bar (multiple widgets stack by key → key sorting puts
    ours below pi-emote). `ctx.ui.setStatus(key, text)` is the lighter footer
    option. Either satisfies "like pi-emote does."
  - **Token usage exists.** `ContextUsage { tokens, contextWindow, percent }` via
    `ctx.getContextUsage()` for the current session; a nested `AgentSession`
    exposes its own usage/tokens to subscribe to. Elapsed time is wall-clock.
  - **Caveat:** the nested-session lifecycle (resource loading, tool restriction,
    teardown) must be validated in a live pi+tmux session — it can't be exercised
    by the unit-test harness. Implementation lands behind that verification.
- [x] Implement read-agent spawning inside `spawn_teammate(role: "read")`: starts a background read-only agent in-process (tools restricted to read/search/list/no-write)
- [x] Track each running read agent: `{ name, startedAt, tokensUsed, status }`
- [x] Render a status entry per the pi-emote pattern via `ctx.ui.setStatus(key, text)` using key `"01-pi-extended-teams-read"`; show count + per-agent elapsed + tokens in Pi's bottom status bar
- [x] Background ticker updates elapsed/token figures (poll the agent's usage)
- [x] On completion, read agent reports back to lead and is removed from the status line
- [x] Enforce **unlimited** read agents (no cap)

**Acceptance:** spawning a read agent opens no tmux pane; the status line shows
`reading: N agents` with live elapsed + token counts; it clears on finish.

> Open question: confirm pi exposes per-agent token usage to the extension. If
> not, fall back to estimating from message/tool-call counts and note it here.

---

## Phase 4 — Watchdog / heartbeat loop

Goal: an internal background loop that confirms agents are still working. Adds a
configurable buffer (default 30s) on top of heartbeats; if an agent misses its
ping, a background check confirms whether it is truly stale.

- [x] Read `watchdog.bufferSeconds` (default 30) from settings (`runWatchdogOnce`)
- [x] Lead-side loop iterates all members; "expected ping" = last heartbeat + interval + buffer (`startLeadWatchdog` every 30s)
- [x] On a missed ping, run a liveness check (tmux pane alive? runtime file fresh?) before declaring stale
- [ ] Distinguish `working` / `idle` / `stalled` / `dead`; only `dead`+`stalled` trigger recovery
- [~] Recovery: notify lead and reap the member (write agents reaped from tmux; read agents removed from status line). Auto re-spawn not implemented
- [~] Replace the hard-coded `HEARTBEAT_STALE_MS` / `STARTUP_STALL_MS` with values derived from settings (buffer added on top of the constant; constants not yet fully derived)
- [ ] Tests: missed-ping-but-alive ⇒ not stale; missed-ping-and-dead ⇒ stale

**Acceptance:** killing a teammate's pane is detected within
`interval + buffer`; a busy-but-quiet agent is **not** falsely reaped.

---

## Phase 5 — Self-termination on completion

Goal: every agent kills itself after sending its final message back to the lead.
Nothing is left stale or idle.

- [x] Add a `report_and_exit` tool: sends final message to `team-lead`, releases claims, removes the member from team config, clears runtime status, then triggers self-shutdown for write agents
- [x] Update `before_agent_start` teammate system prompt to mandate `report_and_exit` as the final step for write agents
- [x] Lead-side reaper confirms the pane/PID is gone after a completion message; force-kills if it lingers (watchdog `reapTeammate`)
- [x] Release any held file write-claims (Phase 7) on exit
- [x] Tests: after `report_and_exit`, no pane, no PID file, no runtime status, claims released (`extensions/index.test.ts`)

**Acceptance:** a finished agent leaves zero residue; `team_shutdown` becomes a
rare safety net rather than routine cleanup.

---

## Phase 6 — Write-agent concurrency cap (max 3, queued)

Goal: at most 3 write agents running at any time; read agents unlimited.
Overflow is **queued**, not rejected.

- [x] Count active write members before starting a `spawn_teammate(role:"write")` (`countWriteMembers`)
- [x] If at `writeAgents.maxConcurrent` (default 3), enqueue the spawn request (persisted under the team dir) instead of rejecting
- [x] When a write agent exits (`report_and_exit` / watchdog reap), dequeue and auto-spawn the next pending writer (`drainWriteQueue`)
- [x] Lead can inspect the write queue (`list_write_queue`) and cancel pending entries (`cancel_write_queue`)
- [x] Read-agent spawns bypass the cap and the queue entirely
- [x] Tests: 4th writer is queued (not refused); a writer exiting auto-starts the next; queue order preserved (FIFO) (`write-queue.test.ts`, `index.test.ts`)

**Acceptance:** requesting a 4th writer queues it; when a slot frees, the queued
writer spawns automatically without lead intervention.

---

## Phase 7 — File write-coordination (no concurrent same-file writes)

Goal: no two agents write the same file at the same time.

- [x] Shared file-claim registry under the team dir (`claims.json` with `{ agent, path, since }`), guarded by `withLock`
- [x] `claim_file(paths[])` / `release_file(paths[])` tools for write agents; `list_file_claims` lets the lead inspect current claims
- [x] Write-agent system prompt mandates holding a claim before editing; claim grant is exclusive per path
- [x] Claims auto-release on `report_and_exit`, teammate shutdown, and watchdog-confirmed death (`check_teammate` dead cleanup)
- [x] Conflicting claims surface as a blocked owned task via `blockedBy` + `metadata.fileClaimBlock`
- [x] Tests (`src/utils/claims.test.ts`, `src/utils/tasks.test.ts`): two writers contend on one path ⇒ one is granted and one is blocked; owned task blockers are marked and cleared

**Acceptance:** concurrent writers targeting the same file are serialized;
stale claims from dead agents are reclaimed automatically.

---

## Phase 8 — Inter-agent awareness & communication

Goal: agents know who else is running and can talk to each other directly (not
only via the lead).

- [x] `list_teammates` tool: returns live roster with role, status, current task, held claims
- [x] Allow peer-to-peer `send_message` (routes by recipient)
- [x] Inject the live roster into each teammate's context on turn start so they know their peers (`before_agent_start` roster)
- [~] Broadcast roster changes (join/leave) to active members (`broadcast_message` exists; automatic join/leave broadcast not wired)
- [ ] Tests: a spawned agent can enumerate peers and message one directly

**Acceptance:** any agent can list peers and message a specific teammate; roster
stays current as agents come and go.

---

## Phase 9 — Shared memory, extension orchestration & frictionless skills

Goal: agents share memory, can use the user's **own** pi extensions (e.g.
pi-emote) without this extension reimplementing or depending on any specific
one, and load skills by name with one call.

- [x] Shared memory store under the team dir (`shared/memory/*.md`), with `write_shared_memory` / `read_shared_memory` / `delete_shared_memory` tools (lock-guarded; `shared-memory.test.ts`)
- [x] **Extension orchestration (not reimplementation):** `buildPiCommand` keeps `--no-extensions` as the isolation baseline and adds one `--extension <source>` per entry in `resolveAllowedExtensions(settings)` (allow minus block) for spawned write agents — extensions come from the user's own settings, allow-list empty by default. Wired into `spawn_teammate` and `create_predefined_team`; tested in `settings.test.ts`
- [~] Spawned agents are told (system prompt / skill doc) which extensions are available and how to use them (extensions are loaded; system prompt does not yet enumerate them)
- [x] `use_skill(name)` tool: resolves a skill by name from the skills path and loads it into the calling agent's context — just "use this skill name"
- [x] Document the shared-memory conventions and the extension allow/block model in the skill doc (`skills/teams.md`)
- [~] Tests: write→read round-trip on shared memory (`shared-memory.test.ts`); allow-list controls which extensions a spawned agent loads (`settings.test.ts`); `use_skill` loading not yet tested

**Acceptance:** one agent writes a memo, another reads it; a spawned write agent
loads the user's allow-listed extensions per settings, while blocked extensions
stay out; `use_skill("teams")` injects the skill without ceremony.

> Decision (from user): this package is extension-agnostic — it does not
> implement or hard-depend on any specific extension. It must know how to *use*
> other extensions and let the user **allow/block which extensions spawned write
> agents load**, configured in settings.json (allow-list empty by default).

---

## Phase 10 — Skill doc: divide to conquer

Goal: the extension's skill doc clearly teaches decomposition and the new model.

- [ ] Rewrite `skills/teams.md` (rename concept to pi-extended-teams) around **divide to conquer**: lead decomposes → assigns read agents to investigate, write agents to implement
- [ ] Document role choice (read vs write), the 3-writer cap, file claims, self-termination, shared memory, and `use_skill`
- [ ] Add a worked example: a feature split into parallel read + serialized write tasks
- [ ] Document settings.json keys and model categories
- [ ] Update `AGENTS.md` and `README.md` to match

**Acceptance:** a fresh lead, given only the skill doc, can run a correct
divide-to-conquer session.

---

## Phase 11 — Hardening & release

- [ ] Full `vitest` pass across all phases
- [ ] Manual end-to-end in tmux: lead + 3 writers (cap) + N readers, file-claim contention, watchdog reap, clean self-exit
- [ ] Bump version, finalize `CHANGELOG.md`
- [ ] Verify `npm pack` contents (`extensions`, `skills`, `src`) and `pi` manifest
- [ ] Tag and push release

**Acceptance:** clean tmux session demonstrates every feature; package installs
and runs from the new repo.

---

## Risks & open questions

1. **In-process read agents (Phase 3):** depends on pi exposing a nested agent
   loop + token usage to extensions. **Decision: spike first** — confirm before
   committing; if usage isn't exposed, fall back to estimated tokens; if
   in-process isn't feasible, run readers as background tmux panes.
2. **Extension orchestration (Phase 9):** resolved — Ada is the user's own
   extension; we orchestrate via an allow/block list, not reimplement.
3. **Watchdog vs. legitimately-long tool calls (Phase 4):** buffer must be
   generous enough not to reap agents mid-long-operation.
4. **Writer overflow (Phase 6):** resolved — **queue** overflow and auto-spawn
   when a slot frees (FIFO).

## Suggested order

Phase 0 → 1 → 2 are prerequisites. Then 4 (watchdog) and 5 (self-exit) pair
naturally; 6 + 7 (cap + claims) pair; 3 (read agents/UI) is the biggest spike
and can run in parallel after 2. Finish with 8, 9, 10, 11.
