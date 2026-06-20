import { describe, expect, it } from "vitest";
import { teamActivityStatusWidget, type TeamActivityStatusEntry, type TeamActivityStatusSnapshot } from "./status-widget.js";

function makeSnapshot(overrides: Partial<TeamActivityStatusSnapshot> = {}): TeamActivityStatusSnapshot {
  return {
    activeCount: 0,
    readCount: 0,
    writeCount: 0,
    unreadCount: 0,
    entries: [],
    updatedAt: Date.UTC(2026, 0, 1, 0, 0, 0),
    ...overrides,
  };
}

describe("agent activity status widget", () => {
  it("renders large collapsed snapshots as an aggregate without touching per-agent fields", () => {
    const inaccessibleEntry: TeamActivityStatusEntry = Object.defineProperties({}, {
      name: { get: () => { throw new Error("name should not be rendered in aggregate mode"); } },
      role: { get: () => { throw new Error("role should not be rendered in aggregate mode"); } },
      status: { get: () => { throw new Error("status should not be rendered in aggregate mode"); } },
      detail: { get: () => { throw new Error("detail should not be rendered in aggregate mode"); } },
    }) as TeamActivityStatusEntry;
    const entries = Array.from({ length: 100 }, () => inaccessibleEntry);
    const snapshot = makeSnapshot({
      activeCount: 100,
      readCount: 90,
      writeCount: 10,
      unreadCount: 3,
      entries,
      statusCounts: { thinking: 80, working: 10, bg: 10 },
    });

    const rendered = teamActivityStatusWidget(() => snapshot, () => false).render(120).join("\n");

    expect(rendered).toContain("100 active");
    expect(rendered).toContain("90 read");
    expect(rendered).toContain("10 write");
    expect(rendered).toContain("3 inbox");
    expect(rendered).toContain("summary");
    expect(rendered).toContain("80 thinking");
    expect(rendered).toContain("10 bg");
    expect(rendered).toContain("10 working");
    expect(rendered).toContain("/agents shows agent details");
  });

  it("keeps expanded rendering bounded while surfacing the aggregate summary", () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      name: `reader-${index}`,
      role: "read" as const,
      status: index < 8 ? "thinking" : "working",
      detail: `detail-${index}`,
    }));
    const snapshot = makeSnapshot({
      activeCount: 12,
      readCount: 12,
      entries,
      statusCounts: { thinking: 8, working: 4 },
    });

    const rendered = teamActivityStatusWidget(() => snapshot, () => true).render(160).join("\n");

    expect(rendered).toContain("8 thinking");
    expect(rendered).toContain("4 working");
    expect(rendered).toContain("reader-0");
    expect(rendered).toContain("reader-9");
    expect(rendered).not.toContain("reader-10");
    expect(rendered).not.toContain("detail-10");
    expect(rendered).toContain("2 more active agents");
  });
});
