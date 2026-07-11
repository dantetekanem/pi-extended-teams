import { describe, expect, it } from "vitest";
import { isPiPromptPlanningMember, shouldSuppressLeadReportInjection } from "./workflow-metadata";

describe("lead report injection policy", () => {
  it("suppresses pi-prompt writer reports consumed through the private event channel", () => {
    expect(isPiPromptPlanningMember({ metadata: { piPromptPlanning: { version: 1, correlation: "private" } } } as never)).toBe(true);
    expect(shouldSuppressLeadReportInjection({ metadata: { piPromptPlanning: { version: 1, correlation: "private" } } } as never)).toBe(true);
    expect(shouldSuppressLeadReportInjection({ metadata: { piPromptPlanning: { version: 2 } } } as never)).toBe(false);
    expect(shouldSuppressLeadReportInjection({ metadata: {} } as never)).toBe(false);
  });
});
