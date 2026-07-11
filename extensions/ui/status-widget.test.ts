import { describe, expect, it, vi } from "vitest";
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
  it("renders open snapshots without a collapse hint", () => {
    const entries: TeamActivityStatusEntry[] = [{
      name: "reader",
      role: "read",
      status: "thinking",
      detail: "provider/model · 12 tok · waiting for model response",
    }];
    const snapshot = makeSnapshot({
      activeCount: 1,
      readCount: 1,
      entries,
      statusCounts: { thinking: 1 },
    });

    const lines = teamActivityStatusWidget(() => snapshot, () => false).render(120);
    const rendered = lines.join("\n");

    expect(lines[0]).toContain("agent activity");
    expect(lines.at(-1)).toContain("─");
    expect(rendered).toContain("1 active");
    expect(rendered).toContain("1 read");
    expect(rendered).toContain("↓ navigate");
    expect(rendered).not.toContain("/agents");
    expect(rendered).toContain("reader");
    expect(rendered).toContain("thinking");
    expect(rendered).not.toContain("collapse");
    expect(rendered).not.toContain("ctrl+o");
  });

  it("fades the old progress and reveals the new phrase within one second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let snapshot = makeSnapshot({
        activeCount: 1,
        readCount: 1,
        entries: [{
          name: "reader",
          role: "read",
          displayText: "(reader) model/high · reading-fast · 1s · 10 tok · Collecting files.",
        }],
      });
      const requestRender = vi.fn();
      const widget = teamActivityStatusWidget(() => snapshot, () => false, requestRender);
      expect(widget.render(120).join("\n")).toContain("Collecting files.");

      snapshot = makeSnapshot({
        activeCount: 1,
        readCount: 1,
        entries: [{
          name: "reader",
          role: "read",
          displayText: "(reader) model/high · reading-fast · 2s · 12 tok · Reviewing results.",
        }],
      });
      const fading = widget.render(120).join("\n");
      expect(fading).toContain("Collecting files");
      expect(fading).not.toContain("Reviewing results");

      vi.advanceTimersByTime(650);
      const revealing = widget.render(120).join("\n");
      expect(revealing).toContain("Reviewing");
      expect(revealing).not.toContain("Reviewing results.");

      vi.advanceTimersByTime(350);
      expect(widget.render(120).join("\n")).toMatch(/Reviewing results\.{1,3}/);
      expect(requestRender).toHaveBeenCalled();
      widget.dispose();
    } finally {
      vi.useRealTimers();
    }
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
