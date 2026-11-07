# PR #45 reconciliation

Compared on 2026-11-01:

- Main: `617dedda2f648d3057da8e6e43cd6bf42fbe61ca` (2.6.1).
- PR #45: `4a77bc4314b1e328cd473b5910934bcc5ba70075`.
- PR: https://github.com/dantetekanem/pi-extended-teams/pull/45

## Recommendation

Keep the remaining work in #45. It is only partly superseded, not ready to close as obsolete. GitHub reports merge conflicts against main. Resolve those conflicts and revalidate the session-level stop before considering a merge. This comparison changes no runtime behavior and does not approve, close, or merge #45.

## What remains

Paths and line numbers in this table refer to the main commit above. The proposed behavior comes from #45's diff, not from executing its branch in this check.

| Area | Current main | Remaining proposal in #45 |
| --- | --- | --- |
| End-of-turn hook | `extensions/agents/read-agent.ts:1253-1272` supports `finishTurn`, falling back to `shouldStopAfterTurn`. Commit `3ecdee1` already added `finishTurn`. | This portion is superseded; preserve main's hook support. |
| Session stop | The subscriber at `extensions/agents/read-agent.ts:1422-1424` only forwards events to activity handling. | After an accepted report's tool result, clear the queue and call the owning session's `abort()`. Await settlement outside the event callback before report delivery. This addresses session continuation, beyond ending the lower-level Agent turn. |
| Legacy request/tool boundaries | `extensions/tools/spawned-agent-policy.ts:10-23` blocks later tools through the extension `tool_call` hook after acceptance. | Add a `transformContext` request guard and wrappers around session tools. The existing extension guard overlaps the intent, but is not the same legacy-host fallback. Revalidate these wrappers against current native tool loading. |
| Tool result | `extensions/tools/agent-communication-tools.ts:147-166` returns acceptance details without `terminate`. | Return `terminate: result.accepted`; repair rejection must remain runnable. Confirm the supported SDK contract rather than relying on this field alone. |
| Activity accounting | `extensions/ui/agent-navigation.ts:21-26` checks teardown state, not `persistedRecipientClosed`. `extensions/index.ts:669-676` takes active counts before asynchronous config/fence reads; lines 871-877 keep a matching closed recipient in the active entry with a cleanup note. | Exclude persisted-closed recipients from active counts, calculate those counts after the reads, and show cleanup through the stopping entry. |
| SDK regression coverage | `extensions/agents/read-agent.test.ts:4535-4606` uses a real Agent with a mocked session that forwards prompts directly to it. Its response assertion permits extra responses on hosts without stop hooks. | Use real AgentSession instances for normal, idle, queued steering, queued follow-up, before-settle continuation, and rejected-then-accepted repair cases. Assert persisted results, drained queues, no post-acceptance response, and no later sequential tool execution. |

Main already closes message admission and the persisted recipient before recording `submittedFinalReport` (`extensions/agents/read-agent.ts:785-799,1152-1178`). That is important protection, but it does not establish that an already-running SDK session cannot continue. Main also retains the activity expectations that #45 changes; the passing baseline tests therefore do not prove #45 is unnecessary.

## Verification on main

Used the existing dependency tree with `--config.verify-deps-before-run=false`. Test commands ran under an isolated temporary HOME.

```sh
pnpm --config.verify-deps-before-run=false exec vitest run --maxWorkers=2 \
  extensions/agents/read-agent.test.ts extensions/index.test.ts \
  extensions/tools/agent-communication-tools.test.ts extensions/ui/agent-navigation.test.ts
pnpm --config.verify-deps-before-run=false typecheck
pnpm --config.verify-deps-before-run=false test --maxWorkers=2
```

- Four targeted files: 249 tests passed.
- `pnpm --config.verify-deps-before-run=false test:focused`: 625 tests passed across 18 files.
- Typecheck: passed. No lint script is configured.
- Full suite: 1,450 passed, 2 failed, 9 skipped. Both failures expect `stalled` where current main returns `unknown`: `extensions/tools/agent-status-tool.test.ts:248` and `src/orchestration/orchestrator.test.ts:164`.
- Those baseline failures are already addressed separately in https://github.com/dantetekanem/pi-extended-teams/pull/48 . They were not changed or duplicated here.
- #45's historical CI passed on its September head. That is not validation against current main: https://github.com/dantetekanem/pi-extended-teams/actions/runs/36331566337

## Before landing the remaining fix

1. Bring the real AgentSession scenarios onto current main and reproduce the affected cases before changing production code.
2. Retain main's native tool enrollment, startup policy, peer inbox, and usage accounting while adapting the remaining shutdown changes. Do not replace whole files with #45's older versions.
3. Run the six session scenarios on the supported current SDK and the legacy fixture, plus the four files above. Verify report persistence and delivery, repair continuation, queue cancellation, and active/cleanup accounting together.
4. Check extension reload and already-running parallel tools separately. #45's description explicitly leaves both untested; sequential batch coverage does not cover already-started work.

These are follow-up acceptance criteria, not changes delivered by this comparison. No provider calls, live agents, explicit reload, parallel-tool race, or #45 real-session scenario was executed here.

The static diff scan covered all nine changed definitions but hit its node cap, leaving 52 unresolved edges and a 232-edge frontier. `createExecutionRuntime` and `hasActiveReadAgentLifecycle` had no tests found by name; the integration/navigation files were run explicitly. Dynamic SDK and UI edges remain coverage gaps. The conclusion is a source-level reconciliation backed by baseline tests, not a fresh reproduction of every bug claimed in #45.
