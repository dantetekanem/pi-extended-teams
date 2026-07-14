import {
  isKnownQualifiedModel,
  listPreferredQualifiedModels,
  loadModelResolutionConfig,
  loadPiModelSettings,
  normalizeQualifiedModel,
  sortAvailableModels,
  type AvailableModel,
} from "../../src/utils/model-resolution";
import type { ThinkingCapableModel } from "../../src/utils/thinking-levels";

export interface AvailableRegisteredModel extends AvailableModel, ThinkingCapableModel {}

export async function getAvailableModels(ctx: any): Promise<AvailableRegisteredModel[]> {
  try {
    const available = await ctx.modelRegistry.getAvailable();
    return available.map((model: any) => ({
      provider: model.provider,
      model: model.id,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
    }));
  } catch {
    return [];
  }
}

export async function getModelSelectionState(ctx: any, projectDir: string, preferredModels: string[] = []) {
  const availableModels = await getAvailableModels(ctx);
  const piSettings = loadPiModelSettings({ projectDir });
  const config = loadModelResolutionConfig({ projectDir });
  const preferredQualifiedModels = listPreferredQualifiedModels(availableModels, {
    projectDir,
    preferredModels,
  });
  const sortedModels = sortAvailableModels(availableModels, {
    preferredModels: preferredQualifiedModels,
    providerPriority: config.providerPriority,
  });

  return {
    availableModels,
    piSettings,
    providerPriority: config.providerPriority,
    preferredQualifiedModels,
    sortedModels,
  };
}

export function getCurrentQualifiedModel(ctx: any): string | undefined {
  if (!ctx.model?.provider || !ctx.model?.id) {
    return undefined;
  }
  return `${ctx.model.provider}/${ctx.model.id}`;
}

export function requireQualifiedKnownModel(
  model: string | undefined,
  availableModels: Array<{ provider: string; model: string }>,
  fieldName: string
): string | undefined {
  if (!model) {
    return undefined;
  }

  const normalized = normalizeQualifiedModel(model);
  if (!normalized) {
    throw new Error(
      `${fieldName} must be a fully qualified provider/model string. ` +
      `Use list_available_models to choose a valid model.`
    );
  }

  if (!isKnownQualifiedModel(normalized, availableModels)) {
    throw new Error(
      `${fieldName} \"${normalized}\" is not available. ` +
      `Use list_available_models to choose a valid model.`
    );
  }

  return normalized;
}
