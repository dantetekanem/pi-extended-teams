# Agent Level Tips

Agents must be spawned by **level** only. A level is the favorite model slot configured by `/agents-favorite-models`.

Do not pass raw model names or thinking levels when spawning agents. The selected level already defines:

1. whether the agent is read-only or edit-allowed,
2. the model,
3. the thinking/effort level.

## Allowed levels

| Level | Agent kind | Use for |
| --- | --- | --- |
| `reading-fast` | read-only | Small, splitable collection work where breadth matters more than deep reasoning. |
| `reading-default` | read-only | Normal investigation, focused review, test-gap checks, and docs/code archaeology. |
| `reading-hard` | read-only | Deep reasoning, architecture review, security review, root-cause analysis, migration/data risk. |
| `writing-basic` | edit-allowed | Small isolated edits with clear verification: docs, typos, one-file config, narrow fixtures. |
| `writing-hard` | edit-allowed | Non-trivial implementation, refactors, production bug fixes, difficult test repairs. |

Concrete model names and thinking levels are configured outside prompts with `/agents-favorite-models`. If no levels are configured, define them there before spawning agents.

## Correct examples

One deep read-only reviewer:

```ts
spawn_agent({
  name: "security-reviewer",
  model_slot: "reading-hard",
  prompt: "Review the auth changes for authorization bugs. Report file:line evidence. Do not edit."
})
```

A broad read-only swarm:

```ts
spawn_swarm_agents({
  defaults: { model_slot: "reading-fast", cwd: "/path/to/project" },
  agents: [
    { name: "routes", prompt: "Inspect routes and report public endpoint patterns." },
    { name: "jobs", prompt: "Inspect jobs and report retry/queue conventions." },
    { name: "docs", prompt: "Check docs for stale tool references." }
  ]
})
```

A swarm with one harder lane:

```ts
spawn_swarm_agents({
  defaults: { model_slot: "reading-default" },
  agents: [
    { name: "tests", prompt: "Find missing regression coverage." },
    { name: "architecture", model_slot: "reading-hard", prompt: "Review module boundaries and coupling risks." }
  ]
})
```

One isolated edit agent:

```ts
spawn_agent({
  name: "docs-fix",
  model_slot: "writing-basic",
  prompt: "Claim README.md, fix stale references only, verify, then call report_and_exit. Do not commit."
})
```

A harder implementation agent:

```ts
spawn_agent({
  name: "bug-fix",
  model_slot: "writing-hard",
  prompt: "Claim only the files you need, fix the failing parser edge case, run focused tests, then call report_and_exit."
})
```

## Wrong examples

Never pass a direct model:

```ts
// Wrong
spawn_agent({
  name: "reviewer",
  model: "openai-codex/gpt-5.5",
  prompt: "Review the diff."
})
```

Never pass direct thinking/effort:

```ts
// Wrong
spawn_agent({
  name: "reviewer",
  model_slot: "reading-hard",
  thinking: "high",
  prompt: "Review the diff."
})
```

Never use `role` to choose read vs write. The level does that:

```ts
// Wrong
spawn_agent({
  name: "writer",
  role: "write",
  model_slot: "reading-hard",
  prompt: "Edit the file."
})
```

Use a writing level instead:

```ts
// Correct
spawn_agent({
  name: "writer",
  model_slot: "writing-hard",
  prompt: "Edit the file."
})
```

## Selection rules

- If the task is read-only and simple, use `reading-fast`.
- If the task is read-only and normal, use `reading-default`.
- If the task is read-only and risky/ambiguous/deep, use `reading-hard`.
- If the task edits files and is narrow/obvious, use `writing-basic`.
- If the task edits files and is broad/risky/non-trivial, use `writing-hard`.
- If several independent slices exist, prefer several `reading-fast` agents over one `reading-hard` agent.
- If files may overlap, do not spawn multiple writing agents.
