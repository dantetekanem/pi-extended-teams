import { describe, expect, it } from "vitest";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  THINKING_LEVEL_NAMES,
} from "./thinking-levels";

describe("Pi model thinking capabilities", () => {
  it("includes max in the canonical thinking-level list", () => {
    expect(THINKING_LEVEL_NAMES).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("exposes only off for non-reasoning models", () => {
    expect(getSupportedThinkingLevels({ reasoning: false })).toEqual(["off"]);
  });

  it("provides standard levels by default and keeps xhigh/max opt-in", () => {
    expect(getSupportedThinkingLevels({ reasoning: true })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("uses non-null model mappings to expose xhigh and max and null to hide levels", () => {
    expect(getSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        xhigh: "xhigh",
        max: "max",
      },
    })).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });

  it("matches Pi's nearest-supported fallback order", () => {
    const standardModel = { reasoning: true };
    const maxWithoutXhigh = {
      reasoning: true,
      thinkingLevelMap: { high: null, xhigh: null, max: "max" },
    };

    expect(clampThinkingLevel(standardModel, "max")).toBe("high");
    expect(clampThinkingLevel(maxWithoutXhigh, "high")).toBe("max");
  });
});
