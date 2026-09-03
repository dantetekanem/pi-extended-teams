# Security policy

## Supported versions

Security fixes are made on the latest published version of `pi-extended-teams`.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/dantetekanem/pi-extended-teams/security/advisories/new) for this repository. Include a description, affected versions, reproduction steps, and impact.

If private reporting is unavailable, contact the maintainer through the repository owner's GitHub profile. Do not include credentials, private prompts, or other sensitive data in a public issue.

Reports are acknowledged after maintainer review. Disclosure timing and any fix will be coordinated with the reporter.

## Trust boundary

This package coordinates local Pi sessions. A spawned teammate receives the prompt, project working directory, configured model selection, and the capabilities of its child Pi process. Review the access disclosure before using it with a project or credentials you do not intend a teammate to access.

See [docs/access.md](docs/access.md) for the process, file, extension, hook, and network boundaries.
