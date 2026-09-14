import { canonicalPersistedModelSlot, loadSettings, type ActivityColors } from "../../src/utils/settings";

export const CONTEXT_USAGE_STATUS_SUFFIX = /^(?:\?|[\d.]+[kM]?) tok(?: \((?:\?|[\d.]+)%\))?$/;

const TIER_COLORS: Record<string, keyof ActivityColors> = {
  "read-collect": "tierCollect",
  "write-patch": "tierCollect",
  "read-review": "tierReview",
  "write-feature": "tierReview",
  "read-analyze": "tierAnalyze",
  "write-system": "tierAnalyze",
};

// Views share settings; surrounding chrome remains theme-owned.
export function createActivityColors(enabled: boolean) {
  const palette = loadSettings({ projectDir: process.cwd() }).activityColors;
  const color = (token: keyof ActivityColors, text: string): string => {
    if (!enabled) return text;
    const hex = palette[token];
    const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(";");
    return `\x1b[38;2;${rgb}m${text}\x1b[39m`;
  };
  const tier = (text: string): string => color(TIER_COLORS[canonicalPersistedModelSlot(text)] ?? "tier", text);
  const metadata = (text: string, name: string): string => {
    const identity = `(${name})`;
    return text.split(" · ").map((part, index) => {
      if (index === 0 && part.startsWith(identity)) {
        const model = part.slice(identity.length);
        const thinkingIndex = model.lastIndexOf("/");
        const label = thinkingIndex < 0
          ? color("model", model)
          : color("model", model.slice(0, thinkingIndex))
            + color("text", "/")
            + color("thinking", model.slice(thinkingIndex + 1));
        return color("name", identity) + label;
      }
      if (/^(?:read|write|reading|writing)-[\w-]+$/.test(part)) return tier(part);
      if (CONTEXT_USAGE_STATUS_SUFFIX.test(part)) {
        const percent = part.match(/\((\?|[\d.]+)%\)$/);
        if (percent?.index !== undefined) {
          const value = Number(percent[1]);
          return color("text", part.slice(0, percent.index))
            + color(value >= 90 ? "error" : value >= 75 ? "warning" : "text", percent[0]);
        }
      }
      return color("text", part);
    }).join(color("text", " · "));
  };
  return { color, tier, metadata };
}
