# Dependabot alerts setup plan

Prepared on 2026-11-02 for `dantetekanem/pi-extended-teams`, against main commit `617dedda2f648d3057da8e6e43cd6bf42fbe61ca`. This is a local plan, not an enabled control. No GitHub settings, notification preferences, dependencies or automation were changed.

_Updated 2026-11-07: PR #46 has merged, so the two references below that treated it as open now say so. The rest is the plan as prepared, and its dated observations were not rerun._

## Verified state

Read-only requests at 2026-11-02 10:13 UTC returned:

- `GET /repos/dantetekanem/pi-extended-teams/dependabot/alerts`: HTTP 403, `Dependabot alerts are disabled for this repository.` This is not zero alerts.
- `GET /repos/dantetekanem/pi-extended-teams/vulnerability-alerts`: HTTP 404, `Vulnerability alerts are disabled.`
- Repository metadata: public, default branch `main`, current caller has admin access, and Dependabot security updates are separately disabled.
- PR #46 merged on 2026-11-07 as `e3464d5`, changing both `package.json` and `pnpm-lock.yaml`: https://github.com/dantetekanem/pi-extended-teams/pull/46. The plan was written while it was still open at `fa92231`.

GitHub CLI printed a scope-refresh suggestion after the 403. The server's explicit disabled response and the independent setting check establish the observed state; no credential changes were attempted. A generic 403 or 404 without this evidence could instead mean insufficient access.

## Proposed alerts-only setup

A repository administrator can perform these steps for this repository only:

1. Open https://github.com/dantetekanem/pi-extended-teams/settings/security_analysis and find Settings > Advanced Security > Dependabot alerts.
2. Check the dependency graph under Insights > Dependency graph. Alerts depend on that graph; enabling alerts generates it. Confirm the graph recognizes this repository's manifest and pnpm lockfile rather than assuming every locked package is covered.
3. Enable Dependabot alerts. Leave Dependabot security updates disabled, do not add `.github/dependabot.yml`, and do not enable version updates, agent assignments or auto-triage rules. Those are separate automation choices; this plan is for visibility without automatic remediation PRs.
4. Inspect the initial backlog at https://github.com/dantetekanem/pi-extended-teams/security/dependabot after GitHub finishes processing. Alerts analyze the default branch, not this unmerged documentation branch or PR #46.
5. Choose the repository maintainer as the initial triage owner. Record alert number/URL, GHSA, affected package/version, manifest, dependency relationship and scope, fixed version if available, and the next action. Prioritize high/critical findings, then assess reachability and prerequisites. Do not dismiss alerts solely to reduce the count.
6. The maintainer should check their own Dependabot notification preferences at https://github.com/settings/notifications and the repository's Watch settings for security alerts or all activity. GitHub's default email eligibility combines write/maintain/admin access with watching and enabled notifications. Record the chosen delivery channel without copying private contact details into repository files.

No source change is required to enable alerts. This document intentionally provides a manual path rather than an executable settings script. Alerts do not install packages or prove that a vulnerable dependency is exploitable in this application.

## Verification after enablement

Run these read-only commands with a caller authorized to read the setting and alerts:

```sh
gh api --include repos/dantetekanem/pi-extended-teams/vulnerability-alerts
gh api --paginate 'repos/dantetekanem/pi-extended-teams/dependabot/alerts?state=open&per_page=100' \
  --jq '.[] | {number, html_url, package: .dependency.package.name, manifest: .dependency.manifest_path, scope: .dependency.scope, ghsa: .security_advisory.ghsa_id, severity: .security_advisory.severity}'
```

The setting check must return HTTP 204 with no body. The alerts list must succeed (HTTP 200); an empty list is valid but does not prove complete dependency coverage. Verify the UI and dependency graph as well. Preserve the timestamp, default-branch commit and all paginated alert records in the local evidence, not credentials. If access fails, inspect the response and caller's repository/token permissions; do not interpret an authorization failure as a clean repository.

Accept setup only when the setting check, alert-list access, graph inspection and a named maintainer's notification-preference review are recorded. Notification delivery remains unverified until a genuine eligible notification is observed. GitHub does not send a separate notification for every existing vulnerability when alerts are first enabled, so inspect the backlog directly; do not add a vulnerable dependency just to generate a test notification.

If alerts must be rolled back, use the same repository's Advanced Security page to disable Dependabot alerts and record the resulting monitoring gap. Do not disable the dependency graph or unrelated security controls. GitHub documents the REST `DELETE .../vulnerability-alerts` operation as disabling both alerts and the dependency graph, so it is not the narrow rollback proposed here. No rollback was executed.

## Dependency remediation stays separate

The 2026-11-01 study reported 67 registry advisory entries (26 high, 33 moderate, 8 low). That audit was not rerun for this plan. Those historical counts are neither a current Dependabot inventory nor proof of 67 distinct exploitable flaws or host compromise.

The checked-in `pnpm-lock.yaml:11-13` still selects `@mariozechner/pi-coding-agent` 0.73.1. The current GitHub advisory GHSA-jfgx-wxx8-mp94 lists that package as affected from 0.50.0 through 0.73.1, with no patched release under the old name. It recommends migration to `@earendil-works/pi-coding-agent >=0.78.1`. This corrects the earlier brief's unsupported `>=0.73.2` fix. See https://github.com/advisories/GHSA-jfgx-wxx8-mp94

The advisory requires a local attacker on a shared writable temporary directory and a victim loading a temporary npm/git extension source. It primarily concerns shared Linux hosts; default macOS/Windows temporary directories are usually user-scoped. The lockfile establishes an affected version, not a reproduced attack or the version installed in the user's running host.

PR #46 has since merged, so work against main rather than that branch. A package-name migration needs compatibility checks for this extension's imports and peer contract, not a blind version bump. Keep alert enablement, dependency repair and host upgrades as distinct outcomes. This branch makes none of those runtime changes.

## Sources and remaining gaps

Official references retrieved on 2026-11-02:

- Setup and permissions: https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-dependabot-alerts
- Default-branch scanning, graph, notification eligibility and limitations: https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-alerts
- Notification channels: https://docs.github.com/en/code-security/dependabot/dependabot-alerts/configuring-notifications-for-dependabot-alerts
- Setting API and status codes: https://docs.github.com/en/rest/repos/repos#check-if-vulnerability-alerts-are-enabled-for-a-repository

The live dependency graph, initial alert backlog and private notification preferences were not inspected. No enablement, delivery test, fresh package audit, exploit reproduction, dependency migration or CI run on a remote branch occurred. Repository settings and advisory data can change; refresh the dated observations when executing the plan.
