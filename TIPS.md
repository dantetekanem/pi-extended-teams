# Agent Level Tips

Agents must be spawned by **level** only. A level is the favorite model slot configured by `/agents-favorite-models`.

Do not pass raw model names or thinking levels when spawning agents. The selected level already defines:

1. whether the agent is read-only or edit-allowed,
2. the model,
3. the thinking/effort level.

## Allowed levels

| Level | Agent kind | Use for |
| --- | --- | --- |
| `reading-fast` | read-only | The normal first choice: bounded research, collection, inventory, lookup, evidence gathering, docs/log/test-output inspection, and independent slices. |
| `reading-default` | read-only | Normal synthesis and judgment across a bounded context: focused behavioral review, test-gap assessment, and code archaeology. |
| `reading-hard` | read-only | Exceptional, irreducibly deep reasoning: ambiguous architecture/security boundaries, unclear cross-system root cause, or migration/data correctness risk. |
| `writing-basic` | edit-allowed | Small isolated edits with clear verification: docs, typos, one-file config, narrow fixtures. |
| `writing-hard` | edit-allowed | One isolated non-trivial sub-outcome: a bounded refactor, production bug fix, or difficult test repair with explicit file ownership. |

Concrete model names and thinking levels are configured outside prompts with `/agents-favorite-models`. If no levels are configured, define them there before spawning agents. Spawn calls use `model_slot` only.

## Lane eligibility before level selection

Choose a level only after the lead has completed outcome-to-lane decomposition for substantial work:

- A delegated lane must own exactly one bounded sub-outcome or genuinely independent question with distinct evidence. The whole User request cannot be a lane.
- A plan is invalid if one teammate owns every unfinished substantive outcome.
- Integration, cross-lane decisions, and final acceptance stay with the lead.
- If only one substantive execution lane exists, the lead executes it rather than spawning a replacement writer.
- A writer owns one isolated sub-outcome and non-overlapping files. `writing-hard` increases capability inside that boundary; it does not authorize broad cross-stack ownership.
- Do not create agents merely to satisfy an "agents" hot word. The hot word triggers intake and lane mapping; spawn only the genuine independent lanes found.

## Reading-level selection hierarchy

Choose the cheapest level that can produce trustworthy evidence:

1. Start with `reading-fast` for bounded read-only work. Research, collecting facts, scanning files, inventorying patterns, reading docs/logs/test output, and checking narrow claims belong here. This should naturally be the most frequently used reading level.
2. Use `reading-default` when the lane must synthesize several facts, review behavior, or exercise normal engineering judgment beyond straightforward collection.
3. Use `reading-hard` only when the problem is genuinely difficult to decompose and needs deep reasoning across ambiguous or high-risk context. It should be the rarest reading level.

Do not choose `reading-hard` merely because the prompt says investigate, research, review, validate, verify, or because the result matters. Importance sets the verification standard; it does not automatically require the most expensive reasoning level. Prefer several bounded `reading-fast` lanes plus lead synthesis over one hard agent reading everything. Escalate a specific lane only after the evidence reveals ambiguity that fast/default reasoning cannot resolve.

## Correct examples

One bounded read-only collector:

```ts
spawn_agent({
  name: "docs-facts",
  model_slot: "reading-fast",
  prompt: "Collect stale public tool references from README and docs. Report exact file:line evidence. Do not edit."
})
```

A read-only swarm of genuinely independent lanes:

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

A mixed swarm with one rare hard lane:

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
  prompt: "Claim src/parser.ts and test/parser.test.ts only, fix the failing parser edge case, run the focused parser tests, then call report_and_exit."
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

- Default bounded research, collection, lookup, inventory, docs/log inspection, and narrow validation to `reading-fast`.
- Use `reading-default` for normal synthesis, focused behavioral review, and bounded engineering judgment.
- Reserve `reading-hard` for rare, irreducibly deep, risky, or ambiguous reasoning that cannot be split into fast/default lanes.
- If the task edits files and is narrow/obvious, use `writing-basic`.
- If one isolated edit sub-outcome is non-trivial or risky, use `writing-hard`; the slot does not broaden its ownership.
- If several genuine independent slices exist, prefer several `reading-fast` agents over one `reading-hard` agent.
- If files may overlap, do not spawn multiple writing agents.
- Never assign all unfinished substantive outcomes to one teammate; when only one substantive execution lane exists, keep it with the lead.
