# pi-extended-teams — Implementation Plan

Fork of `pi-teams` (Mark Burggraf / watzon), re-homed at
`https://github.com/dantetekanem/pi-extended-teams` and extended with a
tmux-only, self-managing, role-aware multi-agent runtime.

This document is the single source of truth for the migration and the new
feature set. Check items off as they land. Each phase has acceptance criteria
so "done" is unambiguous.

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

- [ ] Commit outstanding working-tree change (`extensions/index.ts` status-bar removal)
- [ ] Fast-forward `main` to include all local-branch work (`local-spawn-inherit` is ahead by 4 commits; `main` is an ancestor — clean FF)
- [ ] Rename package `pi-teams` → `pi-extended-teams` in `package.json`
- [ ] Update `repository.url` → `dantetekanem/pi-extended-teams`
- [ ] Update `pi.image` raw URL → `dantetekanem/pi-extended-teams`
- [ ] Update `author` and any burggraf/watzon strings (only `package.json` currently matches)
- [ ] Remove fork remotes (`origin` → burggraf, `watzon`), add new `origin`
- [ ] `git branch -M main`, delete redundant `local-spawn-inherit` once merged
- [ ] `git push -u origin main`
- [ ] Update `README.md` title/badges/clone URL to the new repo
- [ ] Refresh `CHANGELOG.md` with a `pi-extended-teams` heading

**Acceptance:** `git remote -v` shows only the new origin; `main` builds and
tests pass; no `burggraf`/`watzon` strings remain (`grep -rI` clean).

---

## Phase 1 — tmux-only collapse

Goal: make tmux the only backend and delete the dead surface area.

- [ ] Remove non-tmux adapters: `zellij-adapter`, `cmux-adapter`, `iterm2-adapter`, `wezterm-adapter`, `windows-adapter` (+ their tests)
- [ ] Reduce `terminal-registry.ts` to tmux detection; error clearly if `TMUX` is unset ("pi-extended-teams requires running inside tmux")
- [ ] Drop `separate_windows` / `spawn_lead_window` / `supportsWindows()` window paths from `extensions/index.ts`
- [ ] Remove the `Iterm2Adapter` spawn-context branches in `spawn_teammate` and `create_predefined_team`
- [ ] Delete now-irrelevant docs: `WEZTERM_SUPPORT.md`, `WEZTERM_LAYOUT_FIX.md`, zellij/iterm imagery references
- [ ] Update `package.json` keywords (drop multi-terminal claims)

**Acceptance:** code references exactly one adapter; launching outside tmux
fails fast with a helpful message; test suite green.

---

## Phase 2 — Agent roles & model categories (config foundation)

Goal: introduce the `read` vs `write` role and a settings file that drives
per-role model/thinking. Today both roles share the current model; the schema
must already support diverging later.

- [ ] Define settings loader for `~/.pi/agent/pi-extended-teams/settings.json` (global) with optional project override `<project>/.pi/pi-extended-teams.json`
- [ ] Settings schema (initial):
  ```jsonc
  {
    "watchdog": { "bufferSeconds": 30 },        // Phase 4
    "writeAgents": { "maxConcurrent": 3 },      // Phase 6
    "roles": {
      "read":  { "model": null, "thinking": null },   // null = inherit current model
      "write": { "model": null, "thinking": null }
    },
    "categories": {}                            // named role presets, see below
  }
  ```
- [ ] Add `role: "read" | "write"` to the `Member` interface (`src/utils/models.ts`)
- [ ] Resolve a member's effective model/thinking: explicit arg → category → role default → team default → current model
- [ ] Support **categories**: named presets (e.g. `"researcher"`, `"implementer"`) that bundle role + model + thinking, referenced by name at spawn time
- [ ] `spawn_teammate` gains `role` (required) and optional `category`
- [ ] Tests for settings precedence and category resolution

**Acceptance:** spawning with `role: "write"` and no model still works (inherits
current); setting `roles.write.thinking` in settings changes only writers.

---

## Phase 3 — In-process read agents + status UI

Goal: read-only agents do **not** spawn a tmux pane. They run as background
in-process agents, surfaced in a status line above the input bar (below
pi-emote), showing elapsed time and token usage.

- [ ] Research pi's in-process sub-agent API (how `ExtensionAPI` can run a nested agent loop without a new pty); document findings in this file
- [ ] Implement `spawn_read_agent`: starts a background read-only agent in-process (tools restricted to read/search/no-write)
- [ ] Track each running read agent: `{ name, startedAt, tokensUsed, status }`
- [ ] Render a status entry per the pi-emote pattern via `ctx.ui.setStatus(key, text)` using a key that sorts **below** pi-emote (e.g. `"01-pi-teams-read"`); show count + per-agent elapsed + tokens
- [ ] Background ticker updates elapsed/token figures (poll the agent's usage)
- [ ] On completion, read agent reports back to lead and is removed from the status line
- [ ] Enforce **unlimited** read agents (no cap)

**Acceptance:** spawning a read agent opens no tmux pane; the status line shows
`reading: N agents` with live elapsed + token counts; it clears on finish.

> Open question: confirm pi exposes per-agent token usage to the extension. If
> not, fall back to estimating from message/tool-call counts and note it here.

---

## Phase 4 — Watchdog / heartbeat loop

Goal: an internal background loop that confirms agents are still working. Adds a
configurable buffer (default 30s) on top of heartbeats; if an agent misses its
ping, a background check confirms whether it is truly stale.

- [ ] Read `watchdog.bufferSeconds` (default 30) from settings
- [ ] Lead-side loop iterates all members; "expected ping" = last heartbeat + interval + buffer
- [ ] On a missed ping, run a **background** liveness check (tmux pane alive? PID alive? runtime file fresh?) before declaring stale
- [ ] Distinguish `working` / `idle` / `stalled` / `dead`; only `dead`+`stalled` trigger recovery
- [ ] Recovery: notify lead, optionally re-spawn or reap the member (write agents reaped from tmux; read agents removed from status line)
- [ ] Replace the hard-coded `HEARTBEAT_STALE_MS` / `STARTUP_STALL_MS` with values derived from settings
- [ ] Tests: missed-ping-but-alive ⇒ not stale; missed-ping-and-dead ⇒ stale

**Acceptance:** killing a teammate's pane is detected within
`interval + buffer`; a busy-but-quiet agent is **not** falsely reaped.

---

## Phase 5 — Self-termination on completion

Goal: every agent kills itself after sending its final message back to the lead.
Nothing is left stale or idle.

- [ ] Add a `report_and_exit` tool: sends final message to `team-lead`, then triggers self-shutdown (write agent: kill own tmux pane + clean PID/runtime; read agent: deregister from status line)
- [ ] Update `before_agent_start` teammate system prompt to mandate `report_and_exit` as the final step
- [ ] Lead-side reaper confirms the pane/PID is gone after a completion message; force-kills if it lingers
- [ ] Release any held file write-claims (Phase 7) on exit
- [ ] Tests: after `report_and_exit`, no pane, no PID file, no runtime status, claims released

**Acceptance:** a finished agent leaves zero residue; `team_shutdown` becomes a
rare safety net rather than routine cleanup.

---

## Phase 6 — Write-agent concurrency cap (max 3)

Goal: at most 3 write agents at any time; read agents unlimited.

- [ ] Count active write members before `spawn_teammate(role:"write")`
- [ ] If at `writeAgents.maxConcurrent` (default 3), reject with a clear message or queue (decide + document; default: reject and tell lead to wait)
- [ ] Optional: a lightweight write-slot queue so the lead can pre-stage work
- [ ] Read-agent spawns bypass the cap entirely
- [ ] Tests: 4th concurrent writer is refused; a writer exiting frees a slot

**Acceptance:** spawning a 4th writer fails fast; after one writer exits, a new
one spawns.

---

## Phase 7 — File write-coordination (no concurrent same-file writes)

Goal: no two agents write the same file at the same time.

- [ ] Shared file-claim registry under the team dir (e.g. `claims/<hash(path)>.json` with `{ agent, path, since }`), guarded by `withLock`
- [ ] `claim_file(paths[])` / `release_file(paths[])` tools for write agents
- [ ] A write agent must hold a claim before editing; claim is exclusive per path
- [ ] Claims auto-release on `report_and_exit` and on watchdog-confirmed death
- [ ] Lead can inspect current claims; conflicting claims surface as a blocked task
- [ ] Tests (extend `lock.race.test.ts` / `tasks.race.test.ts`): two writers contend on one path ⇒ one waits/declines

**Acceptance:** concurrent writers targeting the same file are serialized;
stale claims from dead agents are reclaimed automatically.

---

## Phase 8 — Inter-agent awareness & communication

Goal: agents know who else is running and can talk to each other directly (not
only via the lead).

- [ ] `list_teammates` tool: returns live roster with role, status, current task, held claims
- [ ] Allow peer-to-peer `send_message` (already routes by recipient; ensure read agents have inbox parity in-process)
- [ ] Inject the live roster into each teammate's context on turn start so they know their peers
- [ ] Broadcast roster changes (join/leave) to active members
- [ ] Tests: a spawned agent can enumerate peers and message one directly

**Acceptance:** any agent can list peers and message a specific teammate; roster
stays current as agents come and go.

---

## Phase 9 — Shared memory, Ada artifacts & frictionless skills

Goal: agents share memory and artifacts, and load skills by name with one call.

- [ ] Shared memory store under the team dir (`shared/memory/*.md`), with `memory_write` / `memory_read` / `memory_list` tools (lock-guarded)
- [ ] Ada artifacts: define the artifact location/contract and `artifact_put` / `artifact_get` / `artifact_list` tools  *(confirm the exact "ada artifacts" spec with the user)*
- [ ] `use_skill(name)` tool: resolves a skill by name from the skills path and loads it into the calling agent's context — just "use this skill name"
- [ ] Document the shared-memory + artifact conventions in the skill doc
- [ ] Tests: write→read round-trip on shared memory; `use_skill` loads a known skill

**Acceptance:** one agent writes a memo, another reads it; `use_skill("teams")`
injects the skill without extra ceremony.

> Open question: confirm what "Ada artifacts" refers to (an existing Ada system
> vs. a generic artifact bucket). Spec'd generically above pending confirmation.

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
   loop + token usage to extensions. Needs a research spike before committing.
2. **"Ada artifacts" (Phase 9):** exact meaning to confirm with the user.
3. **Watchdog vs. legitimately-long tool calls (Phase 4):** buffer must be
   generous enough not to reap agents mid-long-operation.
4. **Cap vs. queue for writers (Phase 6):** default is reject-and-wait; revisit
   if it proves too rigid.

## Suggested order

Phase 0 → 1 → 2 are prerequisites. Then 4 (watchdog) and 5 (self-exit) pair
naturally; 6 + 7 (cap + claims) pair; 3 (read agents/UI) is the biggest spike
and can run in parallel after 2. Finish with 8, 9, 10, 11.
