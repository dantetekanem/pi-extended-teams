# Agent Intent Tier Tips

Agents must be spawned by configured **intent tier** only. A tier is a favorite model slot configured by `/agents-favorite-models`.

Do not pass raw model names or thinking levels when spawning agents. The selected tier already defines:

1. whether the agent is read-only or edit-allowed,
2. the model,
3. the thinking/effort level.

## Canonical tiers

| Tier | Agent kind | Intended outcome | Calibration |
| --- | --- | --- | --- |
| `read-collect` | read-only | Gather bounded facts or evidence without owning the conclusion. | Luna / `high` |
| `read-review` | read-only | Normal default: focused review, verification, test gaps, and bounded synthesis. | Luna / `xhigh` |
| `read-analyze` | read-only | Explain behavior or root cause across connected evidence. | Sol / `medium` |
| `read-critical` | read-only | Irreducible high-stakes security, architecture, concurrency, migration, or data-correctness reasoning. | Sol / `xhigh` |
| `write-patch` | edit-allowed | Narrow localized docs, config, fixture, or bug fix. | Luna / `max` |
| `write-feature` | edit-allowed | Bounded feature implementation with a known design. | Sol / `medium` |
| `write-system` | edit-allowed | Cross-cutting integration or refactor within explicitly claimed files. | Sol / `high` |
| `write-critical` | edit-allowed | High-risk security, concurrency, recovery, migration, or data-integrity change. | Sol / `max` |

Luna/Sol are calibration families, not provider model IDs built into the extension. Select the corresponding scoped models in `/agents-favorite-models`. Concrete models and thinking levels stay outside spawn prompts; spawn calls use `model_slot` only.

For this minor release, these compatibility aliases remain accepted. Prefer canonical names; settings saves remove legacy duplicates.

| Compatibility alias | Canonical intent tier |
| --- | --- |
| `reading-fast` | `read-collect` |
| `reading-default` | `read-review` |
| `reading-hard` | `read-critical` |
| `writing-basic` | `write-patch` |
| `writing-hard` | `write-system` |

## Lane eligibility before tier selection

Choose a tier only after the lead has completed outcome-to-lane decomposition for substantial work:

- A delegated lane must own exactly one bounded sub-outcome or genuinely independent question with distinct evidence. The whole User request cannot be a lane.
- A plan is invalid if one teammate owns every unfinished substantive outcome.
- Integration, cross-lane decisions, and final acceptance stay with the lead.
- If only one substantive execution lane exists, the lead executes it rather than spawning a replacement writer.
- A writer owns one isolated sub-outcome and non-overlapping files. A stronger write tier increases capability inside that boundary; it does not authorize unclaimed or overlapping ownership.
- Do not create agents merely to satisfy an "agents" hot word. The hot word triggers intake and lane mapping; spawn only the genuine independent lanes found.

## Read-tier selection hierarchy

Choose by the lane's intended outcome:

1. Use `read-review` as the normal default for focused review, verification, test-gap assessment, and bounded synthesis.
2. Use `read-collect` when the lane only gathers bounded facts, inventories patterns, or inspects docs/logs/test output without owning the conclusion.
3. Use `read-analyze` when the deliverable must explain behavior or root cause across connected evidence rather than merely review it.
4. Use `read-critical` only for irreducible high-stakes security, architecture, concurrency, migration, or data-correctness reasoning.

Do not choose `read-critical` merely because a prompt says investigate, research, review, validate, or verify. Importance sets the verification standard; it does not determine intent. Split independent collection lanes with `read-collect`, then use `read-review` or `read-analyze` only where a separate conclusion is actually needed.

## Correct examples

One bounded read-only collector:

```ts
spawn_agent({
  name: "docs-facts",
  model_slot: "read-collect",
  prompt: "Collect stale public tool references from README and docs. Report exact file:line evidence. Do not edit."
})
```

A read-only swarm of genuinely independent lanes:

```ts
spawn_swarm_agents({
  defaults: { model_slot: "read-collect", cwd: "/path/to/project" },
  agents: [
    { name: "routes", prompt: "Inspect routes and report public endpoint patterns." },
    { name: "jobs", prompt: "Inspect jobs and report retry/queue conventions." },
    { name: "docs", prompt: "Check docs for stale tool references." }
  ]
})
```

A mixed swarm with one analysis lane:

```ts
spawn_swarm_agents({
  defaults: { model_slot: "read-review" },
  agents: [
    { name: "tests", prompt: "Find missing regression coverage." },
    { name: "root-cause", model_slot: "read-analyze", prompt: "Explain the failure path across the connected modules with evidence." }
  ]
})
```

One isolated edit agent:

```ts
spawn_agent({
  name: "docs-fix",
  model_slot: "write-patch",
  prompt: "Claim README.md, fix stale references only, verify, then call report_and_exit. Do not commit."
})
```

A bounded feature agent:

```ts
spawn_agent({
  name: "parser-feature",
  model_slot: "write-feature",
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
  model_slot: "read-critical",
  thinking: "high",
  prompt: "Review the diff."
})
```

Never use `role` to choose read vs write. The intent tier does that:

```ts
// Wrong
spawn_agent({
  name: "writer",
  role: "write",
  model_slot: "read-critical",
  prompt: "Edit the file."
})
```

Use a write tier instead:

```ts
// Correct
spawn_agent({
  name: "writer",
  model_slot: "write-feature",
  prompt: "Edit the file."
})
```

## Selection rules

- Use `read-review` as the normal read default.
- Use `read-collect` for bounded evidence gathering without a delegated conclusion.
- Use `read-analyze` for connected behavioral or root-cause explanation.
- Reserve `read-critical` for irreducible high-stakes reasoning.
- Use `write-patch` for a narrow localized edit.
- Use `write-feature` for a bounded feature with a known design.
- Use `write-system` for a cross-cutting integration/refactor with explicit file ownership.
- Reserve `write-critical` for high-risk security, concurrency, recovery, migration, or data-integrity changes.
- If several genuine independent slices exist, prefer several bounded agents with distinct evidence.
- If files may overlap, do not spawn multiple write agents.
- Never assign all unfinished substantive outcomes to one teammate; when only one substantive execution lane exists, keep it with the lead.
