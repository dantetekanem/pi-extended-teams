# Access and execution disclosure

`pi-extended-teams` is a local orchestration extension. It creates teammates that act in the working directory selected for the teammate. A teammate is not a sandbox or a security boundary.

## Child processes

- Read teammates run in the lead Pi process through Pi's `AgentSession` API. They do not receive a tmux pane.
- Write teammates start a separate Pi process in a tmux pane. The extension builds and runs the local Pi launch command with the teammate's working directory, model and thinking configuration, selected extensions, and `PI_TEAM_NAME`, `PI_AGENT_NAME`, and `PI_LIFECYCLE_RUN_ID` environment variables.
- Before launching a write teammate, the extension runs a bounded local `pi models --all` preflight through `sh -c` to determine whether the configured model is available.
- On macOS, while at least one write teammate is active, the extension may run `/usr/bin/caffeinate -i -w <lead-pid>` to prevent idle system sleep. It terminates that helper when no write teammates remain or the extension is disposed.
- In a Herdr session, the extension can invoke the configured `herdr` binary to split, start, and close panes when moving an agent. The binary path defaults to `herdr` and can be set with `HERDR_BIN_PATH`.

## Files and local state

The extension reads settings from `~/.pi/agent/pi-extended-teams/settings.json` and `<project>/.pi/pi-extended-teams.json`. Model-provider compatibility also reads the legacy `~/.pi/pi-extended-teams.json` path. Predefined agents can be read from `~/.pi/agent/agents/` and `<project>/.pi/agents/`; team templates can be read or written at `~/.pi/teams.yaml`, `~/.pi/agent/teams.yaml`, and `<project>/.pi/teams.yaml`.

For a team named `<team>`, coordination state is stored under `~/.pi/teams/<team>/`. This includes `config.json`, inboxes, runtime status, session-context references, lifecycle quarantine and tombstones, file claims, write and read-helper queues, shared memory, report events, lead-session metadata, debug logs, and private child transcripts under `agent-sessions/`. Task records are stored under `~/.pi/tasks/<team>/`, and agent reports may also be written under `~/.pi/agent/reports/`. Cleanup removes lifecycle and queue files when they are no longer needed.

The extension reads project extension sources only when Pi marks the same working directory trusted. Teammates receive the working directory supplied at spawn time. A write teammate can use any filesystem access granted to its child Pi process and enabled tools. A read teammate's tools are restricted by the extension, but it still receives prompt and project context supplied by the lead.

## Extensions and hooks

A child Pi process starts with `--no-extensions`, then receives `pi-extended-teams` plus only lead-session extensions selected by the extension policy. The package does not automatically grant every available extension to a child. Project trust is forwarded only when the child uses the same working directory as the trusted lead session. Enabled extensions can add their own tools, hooks, file access, subprocesses, or network behavior; review them separately.

The package's documented project hook is `.pi/team-hooks/task_completed.sh`, which runs when a teammate marks a task complete. Hooks are project-supplied executable code and run with the permissions of the local Pi process. Do not enable or keep hooks you do not trust.

## Network and model providers

The extension does not make application network requests itself. Pi and any enabled extensions may make network requests. In particular, a child Pi process can send its prompt and tool context to the configured model provider, subject to Pi's provider configuration. The model provider, enabled extensions, and tools determine any additional network access.

Use a model provider and extension set appropriate for the project data. Do not delegate secrets or data that you are not authorized to share with the configured provider or local tools.

## Operator controls

The lead controls teammate creation, messages, task assignment, and stop/interrupt actions. A teammate cannot access lead-only process-control tools. File claims coordinate edits but do not enforce operating-system access control.
