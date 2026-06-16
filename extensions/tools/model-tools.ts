import { Type } from "@sinclair/typebox";
import { getModelSelectionState } from "../internal/model-selection";

export function registerModelTools(pi: any): void {
  pi.registerTool({
    name: "list_available_models",
    label: "List Available Models",
    description: "List available fully qualified models for team creation and teammate spawning. Use this before creating a new team or spawning teammates. Models must be specified as provider/model.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const state = await getModelSelectionState(ctx, ctx.cwd);
      const lines = [
        "Choose a fully qualified provider/model string from this list when creating teams or spawning teammates.",
        "Unqualified model names like \"gpt-5\" or \"haiku\" are not accepted.",
      ];

      if (state.preferredQualifiedModels.length > 0) {
        lines.push("", "Preferred models (from pi settings, in priority order):");
        for (const model of state.preferredQualifiedModels) lines.push(`- ${model}`);
      }

      if (state.providerPriority.length > 0) {
        lines.push("", "Provider priority (from pi-extended-teams config):");
        for (const provider of state.providerPriority) lines.push(`- ${provider}`);
      }

      if (state.piSettings.defaultModel || state.piSettings.enabledModels?.length) {
        lines.push("", "Pi model settings:");
        if (state.piSettings.defaultProvider) lines.push(`- defaultProvider: ${state.piSettings.defaultProvider}`);
        if (state.piSettings.defaultModel) lines.push(`- defaultModel: ${state.piSettings.defaultModel}`);
        if (state.piSettings.enabledModels?.length) lines.push(`- enabledModels: ${state.piSettings.enabledModels.join(", ")}`);
      }

      lines.push("", "Available models (already sorted with preferred models first):");
      for (const model of state.sortedModels) {
        const tags: string[] = [];
        if (model.preferred) tags.push("preferred");
        if (model.providerPriorityIndex !== Number.MAX_SAFE_INTEGER) tags.push(`provider-priority:${model.providerPriorityIndex + 1}`);
        lines.push(`- ${model.qualified}${tags.length ? ` [${tags.join(", ")}]` : ""}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          preferredModels: state.preferredQualifiedModels,
          providerPriority: state.providerPriority,
          piSettings: state.piSettings,
          models: state.sortedModels,
        },
      };
    },
  });
}
