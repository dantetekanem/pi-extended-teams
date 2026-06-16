import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const ANSI_RESET = "\x1b[0m";
const ANSI_PURPLE = "\x1b[38;5;141m";
const ANSI_PANEL_BG = "\x1b[48;5;235m";

// Fill a line to `width` visible columns with the dark panel background. Every
// full reset emitted by pink/purple/dimAnsi/theme.fg is followed by a fresh
// background code so embedded foreground colors don't punch holes in the fill.
export function panelBgFill(line: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(line));
  const reasserted = line.split(ANSI_RESET).join(ANSI_RESET + ANSI_PANEL_BG);
  return `${ANSI_PANEL_BG}${reasserted}${" ".repeat(pad)}${ANSI_RESET}`;
}

// Wrap content lines in a rounded border with a dark interior. `innerWidth` is
// the column count between the one-space padding inside each side border.
export function framePanel(contentLines: string[], innerWidth: number): string[] {
  const span = innerWidth + 2;
  const rule = "─".repeat(span);
  const border = (text: string) => `${ANSI_PANEL_BG}${ANSI_PURPLE}${text}${ANSI_RESET}`;
  const out: string[] = [border(`╭${rule}╮`)];
  for (const line of contentLines) {
    const boundedLine = truncateToWidth(line, innerWidth, "…", true);
    out.push(border("│") + panelBgFill(` ${boundedLine} `, span) + border("│"));
  }
  out.push(border(`╰${rule}╯`));
  return out;
}

// Self-sizing frame for compact panels so each reads as a distinct dark card.
export function frameWidget(contentLines: string[]): string[] {
  const innerWidth = contentLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  return framePanel(contentLines, innerWidth);
}

// Full-width frame for belowEditor status widgets. The returned lines consume
// the whole render width so the bottom bar has no left/right gutters.
export function frameWidgetFullWidth(contentLines: string[], width: number): string[] {
  if (width <= 0) return [];
  if (width < 4) {
    return contentLines.map((line) => panelBgFill(truncateToWidth(line, width, "", true), width));
  }
  return framePanel(contentLines, width - 4);
}

export function logWindowStart(totalRows: number, viewportRows: number, offsetFromBottom: number): number {
  const maxStart = Math.max(0, totalRows - viewportRows);
  return Math.max(0, maxStart - Math.max(0, Math.min(offsetFromBottom, maxStart)));
}
