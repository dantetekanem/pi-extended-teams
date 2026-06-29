# pi-extended-teams Usage Guide

This guide shows the current session-connected workflow for pi-extended-teams. The lead stays in the main Pi session and spawns helper agents when parallel coverage helps.

## Contents

- [Getting started](#getting-started)
- [Choosing favorite model slots](#choosing-favorite-model-slots)
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
  defaults: { role: "read", model_slot: "reading-default" },
  agents: [
    { name: "security", model_slot: "reading-hard", prompt: "Review the diff for security risks. Report file:line findings." },
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

## Choosing favorite model slots

Use `/agents-favorite-models` to save five named model/thinking favorites from one screen. The picker lists the scoped models available to the current Pi session, lets you move across slots, models, and thinking levels, then saves the global settings file when you press Enter. After that, spawn agents by declaring the workload slot instead of repeating model names:

```text
spawn_agent({
  name: "auth-security",
  role: "read",
  model_slot: "reading-hard",
  prompt: "Review src/auth for authorization bugs. Report file:line evidence."
})
```

Slot guidance:

| Slot | Best for | Avoid for |
| --- | --- | --- |
| `reading-fast` | Fast read-only collection over small independent datasets: many issue files, route files, logs, docs pages, simple conventions, or shallow yes/no checks. | Ambiguous design calls, security-sensitive conclusions, or tasks where one agent must hold the whole system in context. |
| `reading-default` | Normal read-only work: focused diff review, test-gap analysis, README/reference checks, local convention discovery. | Expensive architecture/security/root-cause analysis. |
| `reading-hard` | Deep read-only reasoning: architecture boundaries, security review, production-risk review, migration/data correctness, unclear root cause. | Simple inventory work that can be split across fast readers. |
| `writing-basic` | Small isolated edits with obvious verification: docs, typos, one-file config, narrow test fixture fixes. | Broad refactors, multi-file logic, risky behavior changes. |
| `writing-hard` | Non-trivial write work: multi-file implementation, refactors, production bug fixes, difficult test repairs. | Parallel writes to overlapping files; keep writer concurrency low. |

For collection-style work, prefer breadth: five `reading-fast` agents each reading one slice often beats one `reading-hard` agent reading every file. Ask each fast reader for concise evidence, then synthesize in the lead session.

---

## Common workflows

### 1. Code review with read agents

```text
spawn_swarm_agents({
  defaults: { role: "read", model_slot: "reading-default" },
  agents: [
    { name: "security-reviewer", model_slot: "reading-hard", prompt: "Review src/auth for authn/authz bugs. Report severity, file:line, and suggested fix." },
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
  model_slot: "writing-basic",
  prompt: "Claim README.md and docs/guide.md, update only stale public tool references, run the focused docs checks, then call report_and_exit. Do not commit or push."
})
```

A good edit-agent prompt includes:

- exact files or directories,
- claim-file requirements,
- what must not change,
- verification commands,
- and the expected final report.

### 3. Favorite-slot swarm

```text
spawn_swarm_agents({
  defaults: { role: "read", cwd: "/path/to/project", model_slot: "reading-fast" },
  agents: [
    { name: "routes", prompt: "Collect route patterns and public endpoints from config/routes*. Report concise evidence." },
    { name: "jobs", prompt: "Collect queue/retry conventions from background jobs. Report concise evidence." },
    { name: "architect", model_slot: "reading-hard", prompt: "Use the collected facts plus direct inspection to review architecture and coupling risks." }
  ]
})
```

Use favorite slots for normal orchestration. Use fully qualified model names only when intentionally overriding the configured favorites.

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

Match slot strength to the job. Use `reading-fast` for splitable collection and `reading-hard` only when depth is needed.

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

If a `model_slot` fails, check `/agents-favorite-models` and confirm the slot has a fully qualified `provider/model` plus a valid thinking level.

When bypassing slots, use fully qualified model names such as `provider/model`.

If no `model_slot` or model is passed, pi-extended-teams uses the current Pi session model or configured defaults.

### Panel is empty

Open `/agents`. If there is no active agent session yet, spawn an agent first or ask the lead to use agents for the current task.

---

## Cleanup

Finished read agents remove themselves from the active list after reporting. Edit agents should call `report_and_exit`, which sends the final report, releases file claims, and shuts the agent down.

The lead does not need to manually shut down a separate team for the normal current-session workflow.
