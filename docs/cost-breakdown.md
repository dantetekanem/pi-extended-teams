# Recorded session cost breakdown

Host extensions can request per-run costs without reading internal receipts. This is an opt-in, synchronous, read-only event on `pi.events`; it adds no UI, polling, budgets or lifecycle controls.

```ts
import type { SessionCostBreakdown } from "pi-extended-teams/extensions/team/session-cost.js";

const request: { sessionId: string; result?: SessionCostBreakdown } = {
  sessionId: ctx.sessionManager.getSessionId(),
};
pi.events.emit("pi-extended-teams:cost-breakdown-request", request);
const breakdown = request.result;
```

Use a fresh request each time. The extension assigns `result` only for its active root session. Before startup, after detach/deactivation, or for a different session ID, it leaves the request untouched. A matching same-process reload attaches the listener to the new host and context; the old host no longer responds.

## Response

`SessionCostBreakdown` and `AgentCostBreakdown` are exported from `extensions/team/session-cost.ts`.

| Field | Meaning |
| --- | --- |
| `usd` | Combined known recorded USD, including only eligible child costs. |
| `complete` | Whether all accounting evidence needed for that total is available and valid. |
| `own` | `{ usd, complete }` for this session's native usage, separately from child receipts. |
| `runs` | One row per replayed root/team/lifecycle-run identity, in first-seen order. |

Each run has `rootSessionId`, `teamName`, `lifecycleRunId`, `phase`, `costUsd` and `accounting`. `phase` is `pending`, `final` or `excluded`. `costUsd` is the finite, nonnegative recorded final amount, or `null` when unknown or not final. A recorded zero is distinct from unknown.

Optional `childSessionId`, `agentName` and `modelSlot` are included only when available as strings. Agent name and slot come from version-1 telemetry; pending and legacy receipts may lack them. A slot is configured routing metadata, not an observed model identity. Legacy final receipts with valid costs still contribute even without telemetry.

| `accounting` | Contribution to `usd` |
| --- | --- |
| `included` | Add this row's `costUsd`, including a recorded zero. |
| `duplicate` | Add nothing: this child session was already counted, or is the active root itself. |
| `excluded` | Add nothing: the receipt excludes this run, such as a terminal handoff. |
| `incomplete` | Add nothing: the run is pending, has unknown cost, failed persistence or would overflow the total. |

To reconcile the response, start with `own.usd` and add `costUsd` only for rows whose `accounting` is `included`, in response order. Do not sum every non-null `costUsd`: duplicate and unpersisted final rows can retain amounts without contributing them.

## Replay and completeness

The query shares the aggregate accounting pass. It uses the session manager's full entry list, not only the active conversation branch. A fork can therefore include inherited receipts with the original `rootSessionId`; asking for an unrelated session does not load its history.

Replay keys receipts by root, team and lifecycle run. The first terminal receipt wins. Repeated child session IDs contribute once, even across teams or runs. Each nested helper contributes its own final receipt; the query never sums telemetry entries, descendant receipts inside telemetry or retained transcript tails.

Pending runs, unknown final costs, legacy summaries without native usage, malformed receipts and failed persistence keep `complete` false. Invalid receipts are omitted rather than assigned invented identities or zero costs. A complete set of visible rows does not imply a complete total: malformed receipts or incomplete own-session usage may still exist. If reading the entries fails, the response contains zero known USD, empty runs and `complete: false` on both the total and `own`.

Queries read current entries and do not persist receipts, retry failed writes or emit change notifications. Existing lifecycle events perform persistence and refreshes. `pi-extended-teams:cost-request` keeps its `{ usd, complete }` response and cached-refresh behavior; its cache can lag a fresh breakdown until the next refresh. Consumers can use the existing `pi-extended-teams:cost-changed` notification to request a new breakdown.

## Data limits

Responses contain only the listed scalar fields and newly allocated objects and arrays. They exclude telemetry entries, messages, transcript content, tool arguments, prompts and raw receipt objects. Changing a response does not alter receipts or later responses.

These are Pi-recorded costs, not verified provider invoices. The query does not estimate missing usage, inspect live child sessions or retrieve cross-session history. Grouping repeated runs by agent name is a consumer choice; lifecycle identity remains the accounting key.
