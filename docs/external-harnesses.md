# Optional external harnesses

External harness profiles are an opt-in way to spawn an agent in a Herdr sibling pane. Bind a profile to a tier in global settings; spawn calls select only the tier. Unbound tiers keep using native Pi. The favorite-model picker shows harness bindings but does not create profiles. There is no non-Herdr fallback.

## Check your CLI before configuring it

Check the current installation without installing or logging in:

```sh
command -v claude
command -v opencode
command -v amp
command -v codex
```

Only add a profile for a CLI available on your `PATH`, then inspect that installed CLI's current `--help` for the arguments you intend to use. Do not assume that options accepted by one harness work in another. The resolver checks that the named executable is available and executable without running it. Herdr recognizes all four launch kinds, but recognition does not mean the CLI is installed or its options are verified. In the development environment for this feature, only Claude Code was installed; no live external model session was run.

## Add a global profile

Edit `~/.pi/agent/pi-extended-teams/settings.json` only after you have permission to change that configuration. Preserve the existing keys. Add `externalHarnesses` at the top level, for example:

```json
{
  "externalHarnesses": {
    "claude-research": {
      "kind": "claude",
      "args": ["--model", "sonnet", "--effort", "high"],
      "instructions": "Investigate and report. Do not change files."
    }
  }
}
```

The supported kinds are `claude`, `opencode`, `amp`, and `codex`. The profile name is the value of the tier's global `harness` setting. `kind` is required; `args` defaults to `[]` and `instructions` to `""`. Arguments are passed as individual argv entries, not shell text. `instructions` is an assignment instruction, not a permissions mechanism. A read-only assignment relies on the agent's cooperation and the external harness's permissions. Pi does not restrict the external harness's tools or filesystem access.

Your CLI's existing configuration remains in control when an option is omitted. There is no silent translation from Pi model or thinking tiers to external model or effort settings. For Claude Code 2.1.311, local help documented `--model`, `--effort` (`low`, `medium`, `high`, `xhigh`, `max`), `--permission-mode`, and `--settings`; check your installed version before using them. If you need custom settings JSON or permissions, consult its current help and pass only the native flags you choose. The extension does not add permission-bypass flags automatically. No argument contract for OpenCode, Amp, or Codex was verified in that development environment.

## Bind a profile to a tier

Set `harness` on that tier in the same global settings file, using an existing profile name:

```json
"favoriteModels": {
  "write-critical": { "harness": "claude-research" }
}
```

Merge this entry with your other tiers. Its profile controls the model and effort. The optional quota/capacity fallback uses the immediately lower tier, not native values on this harness-bound tier. Spawning this tier now selects the profile automatically, including in swarms. Tool calls cannot override the binding: `harness` arguments are rejected. Project-local settings cannot override it. A missing profile, unavailable CLI, or non-Herdr session fails rather than switching to Pi.

The picker shows the harness and its arguments, with the full selection below the columns. Its thinking column is harness-managed. Edit the profile JSON to change CLI options. Selecting a scoped Pi model, using `set`, or clearing the tier removes its harness binding. Editing another tier preserves it.

## Fall back to native Pi on quota or capacity failure

For Claude Code 2.1.78 or later, set `nativeFallback: true` on the global profile. Fallback uses the immediately lower tier of the same role: for example, `write-critical` falls back to `write-system`. Configure that lower tier's native model and thinking:

```json
{
  "favoriteModels": {
    "write-critical": { "harness": "claude-research" },
    "write-system": {
      "model": "provider/model",
      "thinking": "high"
    }
  },
  "externalHarnesses": {
    "claude-research": { "kind": "claude", "nativeFallback": true }
  }
}
```

Replace `provider/model` with an available Pi model with configured credentials. Merge these fields into your existing settings; do not replace unrelated profiles or CLI arguments. Nothing is enabled by default. The lower tier and its native pair are captured at admission. Changing that pair during a run fails the native runner's configuration check rather than silently selecting another model. Fallback never skips a tier or crosses between read and write roles. A missing, incomplete or externally bound lower tier rejects the opt-in; `read-collect` and `write-patch` have no lower tier.

This uses Claude's [StopFailure hook](https://code.claude.com/docs/en/hooks#stopfailure), not terminal text or idle status. Only main-session `rate_limit` and `overloaded` errors trigger a single handoff. Pi stops the external process and confirms exit before starting its native runner, keeping the same assignment, role, run identity and claims. Before the native attempt, Pi sends a transcript notice naming the agent, failure reason, original and lower tiers, and selected model/thinking. It may appear later if the lead is streaming or the host is detached. This is a transition notice, not a completion report. The native prompt warns about partial work and asks it to inspect existing changes before continuing; it does not receive the external conversation history.

The opt-in needs command hooks enabled and reserves the profile's `--settings` flag for a private per-run hook file; profiles using `--settings` or `--bare` are rejected. No persistent Claude settings are changed. OpenCode, Amp and Codex do not yet have structured failure adapters here and reject this opt-in. Authentication, billing, unknown failures, missing executables and unavailable Herdr do not trigger fallback. Cancellation or unconfirmed external cleanup prevents the handoff. If the native attempt fails, its normal failure handling applies; there is no fallback loop.

## Spawn and follow the agent

After configuring the binding above, select its tier:

```text
spawn_agent({
  name: "external-review",
  model_slot: "write-critical",
  prompt: "Review src/parser.ts for correctness. Do not edit. Cite concrete evidence."
})
```

`model_slot` still selects the work and read/write role; the external CLI owns its model and effort. Swarm defaults, individual swarm agents, and nested read helpers also select only `model_slot`. An opted-in native writer's read helper uses its read tier's configured binding and reports to the exact writer run that spawned it.

The agent appears in the existing activity view. Press `h` to focus its Herdr pane. Pi does not mirror its transcript, tool activity, token usage, or cost. Messages and Escape interrupts are forwarded through Herdr; acceptance by Herdr does not prove the harness consumed them or interrupted its current command. The harness may require its own approval or login; the extension never answers those prompts automatically.

The assignment tells the harness where to write private temporary report and completion files. Pi validates and saves the report before notifying the owner, then closes its owned pane. Temporary files remain available for diagnosis, and reports reference the external report file. A vanished writer's report goes to the lead, not a replacement writer. Same-process Pi reload retains the controller; recovery after quitting or process replacement is not supported. Idle/done is not a substitute for a report. Confirmed process-group exit without a completion file is reported as failure. Failed external cleanup can be retried with Stop, and the existing watchdog retries it automatically; live or unknown process ownership and report-persistence failures remain fenced. Missing or reused panes are left untouched when the original process group is confirmed gone.

## Limits

A missing or malformed global profile, or an unavailable executable, rejects the spawn before creating a pane. Project-local settings do not define these profiles. External completion requires a valid run report; an idle or finished Herdr pane alone is not a successful agent report. Assigned native checks, automatic repair, checkpoints, grouping, and external nested delegation are not supported in the initial external path and are rejected rather than ignored.
