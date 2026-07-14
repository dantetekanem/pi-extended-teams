export const THINKING_LEVEL_NAMES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevelName = (typeof THINKING_LEVEL_NAMES)[number];

export interface ThinkingCapableModel {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevelName, string | null>>;
}

/**
 * Mirror Pi's model-capability rules for thinking levels.
 *
 * Standard levels through `high` are available by default for reasoning models.
 * `xhigh` and `max` are opt-in and require a non-null mapping on the model.
 * Any level explicitly mapped to `null` is unsupported.
 */
export function getSupportedThinkingLevels(model: ThinkingCapableModel): ThinkingLevelName[] {
  if (!model.reasoning) return ["off"];

  return THINKING_LEVEL_NAMES.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** Match Pi's nearest-supported fallback: requested, then higher, then lower. */
export function clampThinkingLevel(
  model: ThinkingCapableModel,
  requested: ThinkingLevelName,
): ThinkingLevelName {
  const supported = getSupportedThinkingLevels(model);
  if (supported.includes(requested)) return requested;

  const requestedIndex = THINKING_LEVEL_NAMES.indexOf(requested);
  for (let index = requestedIndex + 1; index < THINKING_LEVEL_NAMES.length; index += 1) {
    const candidate = THINKING_LEVEL_NAMES[index];
    if (supported.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVEL_NAMES[index];
    if (supported.includes(candidate)) return candidate;
  }

  return supported[0] ?? "off";
}
