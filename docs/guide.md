# pi-extended-teams Usage Guide

This guide shows the current session-connected workflow for pi-extended-teams. The lead stays in the main Pi session and spawns helper agents when parallel coverage helps.

## Contents

- [Getting started](#getting-started)
- [Common workflows](#common-workflows)
- [Best practices](#best-practices)
- [Troubleshooting](#troubleshooting)
- [Cleanup](#cleanup)

---

## Getting started

You do not need to create a separate team. The current Pi session is the implicit agent group.

Ask naturally:

```text
Use agents to review the current diff and summarize the risks.
```

Or spawn explicitly:

```text
spawn_swarm_agents({
  defaults: { role: "read", thinking: "high" },
  agents: [
    { name: "security", prompt: "Review the diff for security risks. Report file:line findings." },
    { name: "tests", prompt: "Find missing or weak test coverage. Report concrete gaps." }
  ]
})
```

Open the panel:

```text
/agents
```

`/team` still opens the same panel for compatibility.

---

## Common workflows

### 1. Code review with read agents

```text
spawn_swarm_agents({
  defaults: { role: "read", thinking: "high" },
  agents: [
    { name: "security-reviewer", prompt: "Review src/auth for authn/authz bugs. Report severity, file:line, and suggested fix." },
    { name: "performance-reviewer", prompt: "Review the diff for avoidable performance regressions. Include evidence." },
    { name: "test-reviewer", prompt: "Inspect tests around this change. Report missing regression coverage." }
  ]
})
```

The lead keeps working or waits for automatic report delivery. Do not sleep or poll for completion.

### 2. Focused edit agent

Use an edit agent only when the change is narrow and isolated.

```text
spawn_agent({
  name: "docs-fix",
  role: "write",
  prompt: "Claim README.md and docs/guide.md, update only stale public tool references, run the focused docs checks, then call report_and_exit. Do not commit or push."
})
```

A good edit-agent prompt includes:

- exact files or directories,
- claim-file requirements,
- what must not change,
- verification commands,
- and the expected final report.

### 3. Mixed model/thinking swarm

```text
spawn_swarm_agents({
  defaults: { role: "read", cwd: "/path/to/project" },
  agents: [
    { name: "architect", model: "openai-codex/gpt-5.5", thinking: "xhigh", prompt: "Review architecture and coupling risks." },
    { name: "smoke", thinking: "low", prompt: "Run lightweight smoke checks and report failures." },
    { name: "docs", thinking: "medium", prompt: "Check README and docs for stale user instructions." }
  ]
})
```

Use fully qualified model names when overriding the current Pi model.

### 4. Direct coordination

Send a targeted update:

```text
send_message({
  recipient: "docs",
  summary: "Scope update",
  content: "Also inspect docs/reference.md. Do not edit."
})
```

Read your own inbox when the extension wakes you or you expect a reply:

```text
read_inbox({ unread_only: true })
```

### 5. Liveness check

Use `check_teammate` only when a specific agent appears stalled:

```text
check_teammate({ agent_name: "security-reviewer" })
```

---

## Best practices

### Use read agents first

Read agents are the safest multiplier. Use them for:

- diff review,
- test-gap analysis,
- architecture review,
- security audit,
- release-readiness checks,
- unfamiliar-code investigation.

### Keep edit agents rare

Use `role: "write"` only when:

- files do not overlap with the lead or another edit agent,
- the task is easy to bound,
- verification is clear,
- and the agent can finish with `report_and_exit`.

Edit agents should claim files before writing:

```text
claim_file({ paths: ["docs/guide.md"] })
```

Release claims when no longer needed:

```text
release_file({ paths: ["docs/guide.md"] })
```

### Write clear missions

Good mission:

```text
Review extensions/tools/team-tools.ts for regressions in spawn_swarm_agents. Report blockers first, with file:line evidence. Do not edit files.
```

Bad mission:

```text
Check agents.
```

### Do not create an agent society

Spawned agents should not spawn more agents. If they need help, they should use `send_message` to ask the lead.

### Do not poll

Do not use `sleep`, `while true`, or repeated status checks to wait for completion. The extension delivers reports and wakes the lead.

---

## Troubleshooting

### Agent did not report back

1. Check the specific agent:
   ```text
   check_teammate({ agent_name: "security-reviewer" })
   ```
2. If it has unread messages, read the relevant inbox:
   ```text
   read_inbox({ agent_name: "security-reviewer", unread_only: true, mark_as_read: false })
   ```
3. If the agent is dead or stalled, decide whether to respawn a new agent with a narrower prompt.

### File claim conflict

If `claim_file` reports a conflict, do not edit the file. Ask the lead to resolve ownership or wait for the other edit agent to release the claim.

```text
list_file_claims({})
```

### Model errors

Use fully qualified model names such as:

- `openai-codex/gpt-5.5`
- `claude-agent-sdk/claude-sonnet-4-6`
- `kimi-coding/kimi-for-coding`

If no model is passed, pi-extended-teams uses the current Pi session model or configured defaults.

### Panel is empty

Open `/agents`. If there is no active agent session yet, spawn an agent first or ask the lead to use agents for the current task.

---

## Cleanup

Finished read agents remove themselves from the active list after reporting. Edit agents should call `report_and_exit`, which sends the final report, releases file claims, and shuts the agent down.

The lead does not need to manually shut down a separate team for the normal current-session workflow.
