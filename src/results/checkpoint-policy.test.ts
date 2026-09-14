import { describe, expect, it } from "vitest";
import { normalizeCheckpointPolicy } from "./checkpoint-policy";

describe("checkpoint policy", () => {
  it("requires explicit opt-in and clones the bounded assignment policy", () => {
    expect(normalizeCheckpointPolicy(undefined)).toBeUndefined();
    const input = { inputs: ["src/auth", "src/policy.ts"], decisions: ["Anonymous requests stay denied."] };
    const policy = normalizeCheckpointPolicy(input);
    input.inputs.push("secrets");
    input.decisions.length = 0;
    expect(policy).toEqual({ inputs: ["src/auth", "src/policy.ts"], decisions: ["Anonymous requests stay denied."], retentionDays: 30 });
    expect(normalizeCheckpointPolicy({ inputs: ["."], retentionDays: 1 })).toEqual({ inputs: ["."], decisions: [], retentionDays: 1 });
    expect(normalizeCheckpointPolicy({ inputs: ["src"], retentionDays: 365 })?.retentionDays).toBe(365);
  });

  it.each([
    null, false, {}, { inputs: [] }, { inputs: [""] }, { inputs: ["  "] },
    { inputs: ["../secret"] }, { inputs: ["src/../secret"] }, { inputs: ["/tmp/source"] },
    { inputs: ["C:\\source"] }, { inputs: ["src\0secret"] },
    { inputs: ["src"], retentionDays: 0 }, { inputs: ["src"], retentionDays: 366 },
    { inputs: ["src"], retentionDays: 1.5 }, { inputs: ["src"], execute: "test" },
    { inputs: Array.from({ length: 65 }, (_, i) => `file-${i}`) },
    { inputs: ["src"], decisions: [""] }, { inputs: ["src"], decisions: Array(33).fill("decision") },
  ])("rejects unsupported policy %j", input => {
    expect(() => normalizeCheckpointPolicy(input)).toThrow("Invalid checkpoint policy");
  });
});
