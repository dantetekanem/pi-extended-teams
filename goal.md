# Goal: Persist one plain-text file per completed report

## Outcome

Store report text at `~/.pi/agent/reports/<session-or-team-id>/<agent-name>.md`. If the same agent name reports again in that session, use `-v2`, `-v3`, and so on. Keep the existing team `reports.json` as the compatibility index. A successful legacy/write `report_and_exit` must persist the text before delivery or claim release and return the exact file path.

## Scope

- Extend the existing `TeamReportEvent` append seam; do not create a second reporting protocol.
- Persist only the report text in each `.md` file and retain its path in the existing team index.
- Keep existing read-agent persistence and `check_teammate` behavior otherwise unchanged.
- Do not add obligation/terminal protocols, receipts, lifecycle phases, inbox schema, watchdog behavior, or directory-scanning recovery.
- Scope budget: the report-event helper/model/path, coordination tool, their focused tests, and this harness; at most 7 files and approximately 180 added lines.
- Do not add dependencies, commit, push, reload, or run a broad suite.
- Keep this `goal.md` after completion unless Leo explicitly requests deletion.

## Acceptance criteria

1. Each appended report event produces one `.md` file beneath `~/.pi/agent/reports/<session-or-team-id>` containing only the exact report text.
2. The first report uses `<agent-name>.md`; later reports for the same agent name use `<agent-name>-v2.md`, `-v3.md`, and so on, with each exact path retained in the team index.
3. Legacy/write `report_and_exit` awaits persistence before sending the report or releasing claims and returns the exact per-report path.
4. If persistence fails, the tool rejects without sending the report or releasing claims.
5. Existing read-agent and `check_teammate` flows remain otherwise unchanged.
6. Focused tests, TypeScript type checking, and `git diff --check` pass.
7. The final diff stays within the stated scope budget and a fresh read-only review finds no material issue.
