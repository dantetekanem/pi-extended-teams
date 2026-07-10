# Restore coordination tools for in-process writer agents

This implementation plan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds. A fresh Sol session must be able to execute the work from this file and the current repository alone.

## Sol session instruction

From `/Users/leonardopereira/Poetry/pi-extended-teams`, ask Sol to read this file completely, verify the recorded repository state before editing, and execute the milestones in order. Sol must stop if the current architecture materially differs from this plan. It must not touch unrelated work, especially `src/utils/atomic-write.ts`.

## Purpose / Big Picture

Writing agents spawned through public `writing-basic` and `writing-hard` model slots currently run in-process but do not receive the file-claim and final-report tools promised by the extension. A writer therefore cannot safely claim its files or finish through `report_and_exit`. After this change, nested writer sessions receive identity-bound `claim_file`, `release_file`, `list_file_claims`, and `report_and_exit` definitions, while read-only agents remain restricted to messaging tools. The lead session must never be aborted or shut down when a nested writer exits.

The user-visible proof is a spawned writer that can claim an isolated fixture, edit it, release it, submit one final report, and terminate only itself. The extension will be released as version `2.0.0`, reviewed by a separate Leo reviewer when required, and committed only after explicit user approval.

## Progress

- [x] Reconfirm the clean baseline, the untracked atomic-write file, and the installed Pi SDK version.
- [x] Add failing regression tests for writer and reader nested-tool surfaces.
- [x] Extract identity-bound file-claim tool definitions and reuse them in both outer and nested sessions.
- [x] Add in-process `report_and_exit` submission and termination semantics.
- [x] Prove cleanup, identity isolation, idempotence, and legacy-process compatibility.
- [x] Correct the directly affected public documentation.
- [x] Bump the extension to `2.0.0` and add the major-release changelog entry.
- [x] Run focused and full verification.
- [x] Complete the approval-gated independent review.
- [x] Obtain explicit user approval, then create the scoped commit.

## Surprises & Discoveries

Record implementation discoveries here with evidence. Do not erase prior entries.

- Observation: the public write role is resolved correctly, but its nested SDK session receives only `send_message` and `read_inbox`.
  Evidence: `extensions/tools/team-tools.ts` sends writing slots through `runReadAgentInProcess`; `extensions/agents/read-agent.ts` supplies only `createAgentCommunicationTools(...)` definitions and an explicit allowlist.
- Observation: the bug is a per-session registration and identity problem, not a claims-backend problem.
  Evidence: claim behavior already has coverage in `src/utils/claims.test.ts`; the missing definitions never reach the nested session.
- Observation: the installed `@mariozechner/pi-coding-agent@0.73.1` lacks the newer tool-result `terminate` field.
  Evidence: installed `ToolDefinition` types do not expose it, although current Pi 0.80.6 documentation does.
- Observation: the recorded baseline still matches the repository: `main` and `origin/main` are both `23bca1f`, and only this plan plus `src/utils/atomic-write.ts` are untracked.
  Evidence: `git status --short --branch`, `git rev-parse HEAD`, and `git rev-parse origin/main` on 2026-07-10.
- Observation: `requireWriteAgentTeam` treats a missing roster member as a legacy writer because it applies `member?.role ?? "write"`.
  Evidence: `extensions/team/roster.ts`; the shared identity-bound factory must explicitly reject a missing member while preserving the missing-role fallback for real legacy members.
- Observation: Pi 0.73.1 emits a tool result only after the tool callback returns, while `ctx.abort()` immediately aborts the active agent operation.
  Evidence: installed `pi-agent-core/dist/agent-loop.js` and `pi-coding-agent/dist/core/extensions/runner.js`; an abort inside `report_and_exit` would introduce an unnecessary result-delivery race.
- Observation: the configured pnpm wrapper runs a dependency-status install before `pnpm exec` or `pnpm run`, which is blocked by pre-existing ignored build scripts.
  Evidence: both planned pnpm commands stop with `ERR_PNPM_IGNORED_BUILDS` for `@google/genai`, `koffi`, and `protobufjs`; no dependency files changed. The already-installed `./node_modules/.bin/vitest` runner remains usable without a package operation.
- Observation: the first review found that treating any rejection after an accepted `report_and_exit` as successful completion swallowed unrelated provider/session failures.
  Evidence: the initial implementation's broad catch preferred the submitted report; the corrected lifecycle now accepts a submitted report only when `session.prompt` resolves normally and preserves failure reporting for rejected prompts.

## Decision Log

- Decision: inject writer tools as explicit custom definitions bound to the spawned member identity.
  Rationale: nested sessions have their own tool registry; loading the full extension or mutating shared process environment would misidentify the writer as the lead.
  Date/Author: 2026-07-10 / planning session.
- Decision: keep the outer runner as the sole owner of report delivery, claim cleanup, member/runtime removal, and disposal.
  Rationale: one cleanup owner prevents duplicate reports and races between a tool callback and the runner's finalizer.
  Date/Author: 2026-07-10 / planning session.
- Decision: preserve read-agent restrictions and legacy child-process coordination behavior.
  Rationale: this is a writer regression fix, not a redesign of the read surface or legacy runtime.
  Date/Author: 2026-07-10 / planning session.
- Decision: release as `2.0.0`.
  Rationale: the user explicitly requested a major-version extension update, even though this compatibility restoration would ordinarily qualify as a patch.
  Date/Author: 2026-07-10 / user requirement.
- Decision: use the documented safe outer-runner completion fallback instead of aborting from the in-process `report_and_exit` callback on Pi 0.73.1.
  Rationale: the installed runtime has no terminating tool-result contract, and aborting during tool execution risks cancelling before the successful tool result is fully emitted. The callback will record the first report and instruct the nested agent to finish immediately; the outer runner remains the only finalizer.
  Date/Author: 2026-07-10 / implementation session.
- Decision: an accepted report is authoritative only on normal nested prompt completion; an unrelated prompt rejection remains a failed run.
  Rationale: `report_and_exit` records intent but, under the non-aborting fallback, it is not a runtime termination signal. Converting later provider/session errors into success would hide incomplete work.
  Date/Author: 2026-07-10 / first-review correction.

## Context and Orientation

The extension registers public spawning tools in `extensions/tools/team-tools.ts`. Model slots determine whether a member has the logical `read` or `write` role. Since commit `9e07e94`, both roles use the in-process nested-session host in `extensions/agents/read-agent.ts`. That host creates a separate SDK `AgentSession` with `noExtensions: true`, explicit `customTools`, and an explicit `tools` allowlist.

`extensions/tools/agent-communication-tools.ts` currently builds only `send_message` and `read_inbox`. The outer extension separately registers coordination definitions from `extensions/tools/coordination-tools.ts`, but registering a tool on the lead session does not register it on a nested SDK session. Both `customTools` and the nested `tools` allowlist must contain a definition before that nested session can use it.

The old process-owned writer path remains in `extensions/agents/write-agent.ts`. Its `report_and_exit` semantics include process/PID/runtime cleanup, terminal termination, and extension shutdown. Those semantics are wrong for an in-process nested agent because they could shut down the lead. They must remain unchanged for any legacy process-owned caller.

Relevant files and responsibilities:

- `extensions/tools/team-tools.ts`: public spawn validation, model-slot role resolution, and runner selection.
- `extensions/agents/read-agent.ts`: in-process nested session construction, custom tool allowlist, reporting, cleanup, and disposal.
- `extensions/tools/agent-communication-tools.ts`: nested-session communication definitions.
- `extensions/tools/coordination-tools.ts`: outer/legacy coordination registration and process-owned report behavior.
- `extensions/team/roster.ts`: authorization helpers such as `requireWriteAgentTeam`.
- `src/utils/claims.ts`: claims persistence and conflict semantics; do not redesign it.
- `extensions/tools/agent-communication-tools.test.ts`, `extensions/agents/read-agent.test.ts`, `extensions/tools/coordination-tools.test.ts`, `extensions/index.test.ts`: the focused regression surface.
- `README.md`, `docs/reference.md`, and `CHANGELOG.md`: public behavior and release notes.

At planning time `main` matched `origin/main` at `23bca1f`, and `src/utils/atomic-write.ts` was an unrelated untracked file. Recheck this before editing. Never stage, modify, delete, or format that file as part of this work.

## Constraints and Non-Goals

Use pnpm only. Do not run npm, npx, yarn, or bun commands. Do not install or update dependencies unless the user separately approves that package operation.

Do not migrate the deprecated Pi package namespace or raise the Pi SDK floor in this task. Do not use the 0.80-only tool-result `terminate` contract while the repository executes against 0.73.1. Do not load the full extension inside a nested agent. Do not derive nested identity from `PI_AGENT_NAME` or other shared process environment. Do not change claims storage semantics. Do not merge the unrelated atomic-write prototype. Do not publish, push, tag, or create a release unless each action receives separate explicit approval.

## Observable Acceptance Criteria

A `writing-basic` or `writing-hard` public spawn must construct a nested session whose `customTools` and active `tools` allowlist contain `claim_file`, `release_file`, `list_file_claims`, `report_and_exit`, `send_message`, and `read_inbox`.

A `reading-fast`, `reading-default`, or `reading-hard` nested session must continue to receive only `send_message` and `read_inbox` from team coordination. Attempting to use writer coordination definitions must remain impossible, not merely rejected after registration.

A writer must be able to claim normalized repository-relative paths atomically, receive holder details on conflict, list active claims, and release only its own claims. Existing claims behavior must remain unchanged.

The first successful `report_and_exit` submission for one run must be authoritative. Its `content` and optional `summary` become the single final report. Duplicate submissions must not deliver duplicate reports or repeat destructive cleanup.

A writer exit must release the writer's claims, remove only its runtime/member state, dispose or abort only its nested session, and leave the lead session alive. It must not call the lead's shutdown callback or terminate a lead terminal.

A writer that finishes with ordinary final assistant text and never calls `report_and_exit` must retain the existing fallback report and cleanup behavior.

The existing process-owned `report_and_exit` path must keep its tested PID/runtime/member/terminal cleanup behavior.

Public documentation must describe model-slot spawning rather than the removed direct `role: "write"` argument. The package and changelog must identify the release as `2.0.0`.

All focused tests, typecheck, focused suite, full suite, and diff checks must pass. The final diff must exclude `src/utils/atomic-write.ts`.

## Plan of Work

### Milestone 1: Establish the failing nested-session contract

First, re-read the named source and tests and confirm the baseline. Add focused tests before implementation.

In `extensions/tools/agent-communication-tools.test.ts`, add separate read-role and write-role cases. The write-role case should expect the complete coordination surface, while the read-role case should continue to expect only messaging definitions.

In `extensions/agents/read-agent.test.ts`, construct a nested write member and inspect the arguments passed to `createAgentSession`. Assert both the definition names in `customTools` and the active names in `tools`. Keep the existing read-member assertion. The pre-fix write test must fail for the expected missing names.

Do not rely only on `extensions/index.test.ts`; it inspects outer registration and previously missed this regression.

Milestone proof: the new writer assertion fails before production changes, while the read assertion remains green.

### Milestone 2: Extract identity-bound claim definitions

Create `extensions/tools/file-claim-tools.ts`. It must build `claim_file`, `release_file`, and `list_file_claims` definitions from explicit dependencies rather than process environment. Inject at least the member name, a team/session resolver or authorization callback, and the existing claims operations.

Preserve current schemas, response text, and `details` shapes from the corresponding definitions in `extensions/tools/coordination-tools.ts`. Move or delegate the outer registrations to this shared factory so nested and outer definitions cannot drift. Keep outer-only/process-owned `report_and_exit` in `coordination-tools.ts`.

The factory must authorize a write member through the existing roster/team rules. It must not accept an arbitrary caller-supplied identity from tool arguments.

Milestone proof: focused unit tests show grant, conflict, listing, own-release, forbidden other-release, and normalized-path parity. Existing `src/utils/claims.test.ts` remains unchanged and green.

### Milestone 3: Build the role-aware nested tool surface

Extend `createAgentCommunicationTools` in `extensions/tools/agent-communication-tools.ts` to accept explicit role and identity-bound dependencies. It should always return `send_message` and `read_inbox`. Only for `role === "write"`, append the three file-claim definitions and an in-process `report_and_exit` definition.

The nested `report_and_exit` tool must validate and record `{content, summary}` through an injected callback. It must not deliver the report directly, remove the roster member, kill a terminal, call the lead extension's shutdown method, or perform final cleanup itself.

Update `runReadAgentInProcess` in `extensions/agents/read-agent.ts` to pass `role`, `member.name`, and the current team identity explicitly. Add every returned definition name to both `customTools` and `tools`.

Milestone proof: read and write tool-surface tests pass and prove the roles cannot leak tools into each other.

### Milestone 4: Implement one-owner report and exit lifecycle

Within one invocation of `runReadAgentInProcess`, hold an optional submitted final report. The first accepted submission wins; a later duplicate receives an idempotent response but cannot replace or redeliver the report.

After the accepted tool result can be returned safely, request termination of only the nested session. Characterize `ExtensionContext.abort()` in the installed 0.73.1 runtime. Use a delayed abort only if the tests prove the tool result forms before cancellation. Treat only the abort associated with an accepted report as normal completion. Do not swallow unrelated aborts or errors.

If that characterization is unreliable, use the safe fallback: record the report, return success, instruct the nested agent to finish immediately, and let the outer runner end it. Do not adopt an unverified abort race merely to imitate newer Pi's `terminate` result.

The outer runner must remain the sole finalizer. It chooses the submitted report over trailing assistant text, delivers/persists it exactly once, releases claims, removes member/runtime state, disposes the nested session, and refreshes status. With no submitted report, use the existing final-text fallback.

Add tests proving:

- submitted content and summary win over trailing assistant text;
- duplicate submission does not duplicate delivery or cleanup;
- all writer claims are released;
- nested disposal/expected abort occurs;
- the lead shutdown callback and terminal kill are not called;
- unexpected nested errors still report as failures;
- the fallback path remains intact;
- the legacy process-owned cleanup test remains green.

Milestone proof: all lifecycle assertions pass without sleeps or timing-dependent tests.

### Milestone 5: Correct documentation and produce the major release

Update only directly affected documentation. In `README.md`, replace stale examples that pass direct `role: "write"` with the supported `model_slot: "writing-basic"` or `writing-hard` shape. Ensure `docs/reference.md` and README agree on the documented writer coordination surface.

Add a `2.0.0` changelog section describing restored in-process writer coordination, explicit nested identity isolation, and the breaking major release designation. Reconcile the current mismatch in which `package.json` is `1.3.18` while the changelog ends at `1.3.17` by documenting the new major directly; do not invent missing tags or releases.

Set `package.json` to `2.0.0`. Do not run the repository's `publish-to-npm.sh`, because it uses npm and publication is not authorized.

Milestone proof: package metadata and documentation consistently state `2.0.0`, and no unrelated docs or dependency files changed.

### Milestone 6: Verify, review, and commit only after approval

Run the narrow tests first, then the broader checks. Repair failures before moving forward; do not mark this plan complete with failing checks.

After the implementation is reviewable and all checks pass, ask the user whether to use `leo-the-reviewer`, with the required 30-second timeout. If the user says yes or does not answer, spawn a distinct read-only reviewer and wait for its final verdict. Do nothing else while that required review is running. Address material findings and re-review significant corrections.

Surface the verdict and exact verification evidence. Ask for explicit user approval to commit. Only after that approval, stage the scoped files and create one coherent `2.0.0` commit. Exclude `src/utils/atomic-write.ts` and any other pre-existing unrelated state.

Push, tag, GitHub release, and registry publication are separate actions and remain forbidden without separate approval.

## Concrete Verification

Run from `/Users/leonardopereira/Poetry/pi-extended-teams`:

    git status --short --branch
    pnpm exec vitest run extensions/tools/agent-communication-tools.test.ts extensions/tools/coordination-tools.test.ts extensions/agents/read-agent.test.ts extensions/tools/team-tools.read-agent.test.ts extensions/index.test.ts
    pnpm run typecheck
    pnpm run test:focused
    pnpm test
    git diff --check -- extensions/tools extensions/agents/read-agent.ts extensions/index.test.ts README.md docs/reference.md CHANGELOG.md package.json
    git status --short

Before approval, inspect the diff and prove the unrelated file is absent:

    git diff --name-only
    git diff -- src/utils/atomic-write.ts

The second command must show no tracked diff, and the file must not be staged in the eventual commit.

Where practical, add one actual public-spawn integration regression that observes the nested session tool options rather than relying only on factory-unit tests. Do not start a long-running service merely for verification.

## Idempotence and Recovery

Factories must be side-effect free. Cleanup and report submission must be safe when invoked more than once. Claim release should tolerate already-released claims according to existing semantics. Nested disposal must not cascade to the lead.

If the abort characterization fails, revert only that termination experiment and use outer-runner completion. If a milestone introduces broad regressions, revert that milestone's scoped changes before proceeding rather than layering compensating behavior.

Before commit, recovery is `git restore` of only the scoped tracked paths; never use `git clean` because the unrelated atomic-write file is untracked. After an approved commit, rollback uses a normal revert commit. Published npm versions are immutable; if a later publication is separately approved and broken, deprecate it and issue a new corrective version rather than overwriting it.

## Interfaces and Dependencies

The final implementation should expose a focused factory conceptually equivalent to:

    createFileClaimTools({
      agentName,
      resolveTeam,
      authorizeWriteMember,
      claims
    }): ToolDefinition[]

The nested communication factory should accept explicit role and report submission:

    createAgentCommunicationTools({
      teamName,
      agentName,
      role,
      onReportAndExit
    }): ToolDefinition[]

Exact type names may follow repository conventions, but explicit identity, role-based inclusion, and one-owner cleanup are mandatory. Add no external dependency.

## Outcomes & Retrospective

Implementation, verification, independent review, explicit commit approval, and the scoped commit are complete.

- Behavior: nested `writing-basic` and `writing-hard` sessions receive messaging, identity-bound file claims, and first-report-wins `report_and_exit`; read sessions still receive messaging coordination only. The outer runner alone delivers reports and cleans up the nested session/member/claims.
- Version: `2.0.0` in `package.json` and `CHANGELOG.md`.
- Verification: after the first-review correction, the focused regression surface passed (7 files, 45 tests); the expanded focused suite passed (17 files, 151 tests); TypeScript typecheck passed; the full suite passed (40 files, 293 tests); scoped `git diff --check` passed; `src/utils/atomic-write.ts` has no tracked diff and remains excluded.
- Verification command note: the configured pnpm wrapper aborts before script execution with pre-existing `ERR_PNPM_IGNORED_BUILDS`; the repository-documented installed binaries `./node_modules/.bin/vitest` and `./node_modules/.bin/tsc` were used without modifying dependencies.
- Reviewer verdict: APPROVE on re-review. The first review's important lifecycle finding was corrected; the re-review found no remaining blocker and independently passed the focused 45-test surface, typecheck, full 293-test suite, whitespace checks, and scope audit.
- Commit identifier: the commit containing this plan, with subject `Restore in-process writer coordination tools`; its final hash is reported in the completing session because a Git commit cannot embed its own final hash without changing that hash.
- Deferred: Pi SDK namespace/floor migration and the newer `terminate` tool-result contract remain intentionally out of scope.
