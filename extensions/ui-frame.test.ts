import { describe, it, expect } from "vitest";
import { visibleWidth } from "@mariozechner/pi-tui";
import { panelBgFill, framePanel, frameWidget, frameWidgetFullWidth, logWindowStart } from "./index.js";

const PANEL_BG = "\x1b[48;5;235m";
const RESET = "\x1b[0m";
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("panel UI framing", () => {
  it("panelBgFill pads to the requested visible width with the dark background", () => {
    const filled = panelBgFill("hi", 10);
    expect(visibleWidth(filled)).toBe(10);
    expect(filled.startsWith(PANEL_BG)).toBe(true);
    expect(stripAnsi(filled)).toBe("hi        ");
  });

  it("panelBgFill re-asserts the background after embedded foreground resets", () => {
    const colored = `${"\x1b[38;5;213m"}name${RESET} ${"\x1b[2m"}detail${RESET}`;
    const filled = panelBgFill(colored, 20);
    const resets = (filled.match(/\x1b\[0m/g) || []).length;
    const backgrounds = (filled.match(/\x1b\[48;5;235m/g) || []).length;
    // Every reset (except the final terminator) is followed by a fresh bg code,
    // plus the leading bg, so backgrounds always outnumber/equal interior resets.
    expect(backgrounds).toBeGreaterThanOrEqual(resets);
    expect(visibleWidth(filled)).toBe(20);
  });

  it("framePanel draws a rounded border with uniform width and a dark interior", () => {
    const out = framePanel(["left", "right column"], 20);
    expect(out).toHaveLength(4); // top + 2 content + bottom
    const widths = out.map((l) => visibleWidth(l));
    expect(new Set(widths).size).toBe(1); // every row identical width
    expect(widths[0]).toBe(24); // innerWidth + 2 padding + 2 borders
    expect(stripAnsi(out[0]).startsWith("╭")).toBe(true);
    expect(stripAnsi(out[0]).endsWith("╮")).toBe(true);
    expect(stripAnsi(out.at(-1)!).startsWith("╰")).toBe(true);
    expect(stripAnsi(out[1]).startsWith("│")).toBe(true);
    expect(stripAnsi(out[1]).endsWith("│")).toBe(true);
    expect(out.every((l) => l.includes(PANEL_BG))).toBe(true);
  });

  it("framePanel truncates content wider than the inner width", () => {
    const out = framePanel(["this line is much too long for the panel"], 12);
    expect(new Set(out.map((l) => visibleWidth(l))).size).toBe(1);
    expect(visibleWidth(out[1])).toBe(16); // innerWidth + 2 padding + 2 borders
    expect(stripAnsi(out[1])).toContain("…");
  });

  it("frameWidget self-sizes the box to the widest content line", () => {
    const out = frameWidget(["short", "a much longer line here"]);
    const widest = visibleWidth("a much longer line here");
    expect(visibleWidth(out[0])).toBe(widest + 4);
    expect(new Set(out.map((l) => visibleWidth(l))).size).toBe(1);
  });

  it("frameWidgetFullWidth uses the full available render width", () => {
    const out = frameWidgetFullWidth(["status"], 40);
    expect(out).toHaveLength(3);
    expect(out.every((line) => visibleWidth(line) === 40)).toBe(true);
    expect(stripAnsi(out[0])).toBe(`╭${"─".repeat(38)}╮`);
  });

  it("logWindowStart anchors at the tail and scrolls upward by offset", () => {
    expect(logWindowStart(30, 10, 0)).toBe(20);
    expect(logWindowStart(30, 10, 5)).toBe(15);
    expect(logWindowStart(30, 10, 500)).toBe(0);
    expect(logWindowStart(5, 10, 5)).toBe(0);
  });
});
