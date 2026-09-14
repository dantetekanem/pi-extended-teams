import { canonicalPersistedModelSlot } from "../../src/utils/settings";

export const CONTEXT_USAGE_STATUS_SUFFIX = /^(?:\?|[\d.]+[kM]?) tok(?: \((?:\?|[\d.]+)%\))?$/;

const ACTIVITY_COLORS = {
  name: "51;153;255",
  model: "255;215;0",
  thinking: "255;242;168",
  tier: "255;146;200",
  text: "248;248;242",
  message: "150;156;171",
  warning: "255;215;0",
  error: "255;85;85",
} as const;

const TIER_PINKS: Record<string, string> = {
  "read-collect": "255;214;235",
  "write-patch": "255;214;235",
  "read-review": "255;189;222",
  "write-feature": "255;189;222",
  "read-analyze": "255;167;211",
  "write-system": "255;167;211",
  "read-critical": ACTIVITY_COLORS.tier,
  "write-critical": ACTIVITY_COLORS.tier,
};

// The shared activity palette is fixed; each view's surrounding chrome stays theme-owned.
export function createActivityColors(enabled: boolean) {
  const foreground = (rgb: string, text: string): string =>
    enabled ? `\x1b[38;2;${rgb}m${text}\x1b[39m` : text;
  const color = (token: keyof typeof ACTIVITY_COLORS, text: string): string => foreground(ACTIVITY_COLORS[token], text);
  const tier = (text: string): string => foreground(TIER_PINKS[canonicalPersistedModelSlot(text)] ?? ACTIVITY_COLORS.tier, text);
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
