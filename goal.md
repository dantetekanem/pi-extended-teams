# Goal: Never lose a completed spawned-agent report

## Goal

Ensure a completed spawned read agent always delivers meaningful report content to the lead. If the primary in-memory assistant text is unexpectedly empty, recover the report from durable run/session evidence; if no report text exists anywhere, return a concrete diagnostic and deterministic recovery pointer instead of an opaque empty result.

## Specs

- Fix the read-agent completion/reporting path that currently emits `Read agent completed, but produced no assistant text.`
- Prefer the canonical final report/assistant text produced by the child.
- Deliver the report to the lead model as a hidden follow-up message; do not render the full report body in the lead transcript.
- Handle valid Pi message content shapes and completion ordering without discarding text.
- Preserve enough durable child-run/session metadata to restore or inspect output after the child settles.
- Make fallback behavior actionable and specific; never represent an empty extraction as a successful usable report.
- Add focused regression coverage for the observed empty-output path and recovery behavior.
- Preserve existing agent lifecycle, recipient closure, cleanup, and report-event behavior.
- Do not add dependencies, commit, push, publish, or change unrelated orchestration behavior.
- `goal.md` is the persistent project harness and must remain after completion unless Leo explicitly requests deletion.

## Acceptance criteria

1. A normally completed read agent reports its non-empty final assistant text to the lead.
2. When the immediate completion result contains no extractable assistant text but the child session/run artifact contains it, the lead receives the recovered text.
3. When no assistant/report text exists in any recoverable source, the lead receives an explicit diagnostic containing a stable child session/run pointer and retrieval guidance; the result is not silently treated as a usable report.
4. Focused automated tests cover normal extraction, durable recovery, and irrecoverable-empty diagnostics.
5. After roster removal, the lead can retrieve the latest persisted report through `check_teammate` without exposing it to teammate callers.
6. Direct report delivery still wakes and supplies the lead model with the full report, but the custom message has `display: false` so the report body is not rendered in the transcript.
7. Existing focused read-agent/lifecycle/report tests and TypeScript type checking pass.
8. A fresh read-only non-author review finds no material correctness, lifecycle, cleanup, authorization, or regression issue in the final diff.

## Definition of done

The implementation, focused regression coverage, integration checks, and independent review are complete; every criterion above has concrete passing evidence; no active file claims or unresolved material findings remain.

## Verification plan

- Lead: trace the runtime path from child session completion through extraction, persistence, report emission, cleanup, and lead delivery.
- Lead: run the narrowest new regression tests plus the existing read-agent-focused test file(s) and `pnpm typecheck`.
- Lead: run a real spawned read-agent smoke exercise if the harness can deterministically exercise the installed extension without starting an unauthorized service; otherwise document the exact boundary and rely on an integration-level fixture.
- Fresh read-only agent: review the final diff and test evidence against all acceptance criteria.
