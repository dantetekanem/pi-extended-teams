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
  defaults: { model_slot: "read-review" },
  agents: [
    { name: "security", model_slot: "read-critical", prompt: "Review the diff for security risks. Report file:line findings." },
    { name: "tests", prompt: "Find missing or weak test coverage. Report concrete gaps." }
  ]
})
```

Use the below-editor activity card to watch active agents. With the editor empty, press Down for full-window live navigation, Down/Up to move through agents and back to main, `x` to stop the selected agent, and Escape to return. Final reports are pushed into the lead session automatically.

---

## Choosing favorite model slots

Use `/agents-favorite-models` to save eight canonical intent-tier model/thinking favorites from one screen. The picker lists the scoped models available to the current Pi session, lets you move across slots, models, and thinking levels, then saves the global settings file when you press Enter. After that, spawn agents by declaring the intent tier only. The tier selects read/write behavior, model, and thinking. Do not pass `role`, raw model names, or `thinking` in spawn calls; see `TIPS.md` for examples.

```text
spawn_agent({
  name: "auth-security",
  model_slot: "read-critical",
  prompt: "Review src/auth for authorization bugs. Report file:line evidence."
})
```

Tier guidance:

| Tier | Best for | Calibration |
| --- | --- | --- |
| `read-collect` | Bounded fact/evidence gathering without owning the conclusion. | Luna / `high` |
| `read-review` | Normal default for focused review, verification, test gaps, and bounded synthesis. | Luna / `xhigh` |
| `read-analyze` | Behavioral or root-cause explanation across connected evidence. | Sol / `medium` |
| `read-critical` | Irreducible high-stakes security, architecture, concurrency, migration, or data-correctness reasoning. | Sol / `xhigh` |
| `write-patch` | Narrow localized docs, config, fixture, or bug fix. | Luna / `max` |
| `write-feature` | Bounded feature with a known design. | Sol / `medium` |
| `write-system` | Cross-cutting integration/refactor within explicitly claimed files. | Sol / `high` |
| `write-critical` | High-risk security, concurrency, recovery, migration, or data-integrity change. | Sol / `max` |

Luna/Sol are calibration families rather than built-in provider IDs. For this minor release the old `reading-fast/default/hard` and `writing-basic/hard` names remain accepted aliases, but canonical settings saves use the eight names above.

---

## Common workflows

### 1. Code review with read agents

```text
spawn_swarm_agents({
  defaults: { model_slot: "read-review" },
  agents: [
    { name: "security-reviewer", model_slot: "read-critical", prompt: "Review src/auth for authn/authz bugs. Report severity, file:line, and suggested fix." },
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
  model_slot: "write-patch",
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
  defaults: { cwd: "/path/to/project", model_slot: "read-collect" },
  agents: [
    { name: "routes", prompt: "Collect route patterns and public endpoints from config/routes*. Report concise evidence." },
    { name: "jobs", prompt: "Collect queue/retry conventions from background jobs. Report concise evidence." },
    { name: "architect", model_slot: "read-analyze", prompt: "Use direct inspection to explain how the collected routing and job evidence affects module coupling." }
  ]
})
```

Use favorite slots for all orchestration. Spawn calls reject raw model names, direct thinking levels, and direct role selection.

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

Match the tier to the intended outcome: `read-review` is the normal default, `read-collect` gathers facts, `read-analyze` explains connected evidence, and `read-critical` is reserved for irreducible high-stakes reasoning.

### Keep edit agents rare

Use a `write-*` tier only when:

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

### Keep nested read delegation restricted

Nested delegation is off by default. Set `allow_nested_read_agents: true` only on a depth-0 `write-feature` or `write-critical` spawn that needs independent read-only evidence. That writer receives restricted `spawn_agent` / `spawn_swarm_agents`, may choose any canonical `read-*` tier and any helper count subject to global capacity, and receives each helper's report. Children cannot delegate. Read agents, depth-1 children, `write-patch`, and `write-system` remain denied and ask the lead with `send_message`.

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

If no `model_slot` is passed, pi-extended-teams rejects the spawn. Define tiers with `/agents-favorite-models` first, then choose the tier that matches the intended outcome.

### Activity card is absent

The activity card appears only while agents are active. Spawn an agent first or ask the lead to use agents for the current task, then press Down from an empty editor to navigate.

---

## Cleanup

Finished read agents remove themselves from the active list after reporting. Edit agents should call `report_and_exit`, which sends the final report, releases file claims, and shuts the agent down.

The lead does not need to manually shut down a separate team for the normal current-session workflow.
