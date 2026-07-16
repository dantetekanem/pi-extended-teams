import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const ANSI_RESET = "\x1b[0m";
const ANSI_PURPLE = "\x1b[38;5;141m";
const ANSI_PANEL_BG = "\x1b[48;5;235m";
const SINGLE_COLUMN_FRAME_TEXT = /^[\x20-\x7E\u00B7]*$/;

// Fill a line to `width` visible columns with the dark panel background. Every
// full reset emitted by pink/purple/dimAnsi/theme.fg is followed by a fresh
// background code so embedded foreground colors don't punch holes in the fill.
function panelBgFillMeasured(line: string, lineWidth: number, width: number, background: string): string {
  const pad = Math.max(0, width - lineWidth);
  const reasserted = line.includes(ANSI_RESET)
    ? line.split(ANSI_RESET).join(ANSI_RESET + background)
    : line;
  return `${background}${reasserted}${" ".repeat(pad)}${ANSI_RESET}`;
}

export function panelBgFill(line: string, width: number, background = ANSI_PANEL_BG): string {
  return panelBgFillMeasured(line, visibleWidth(line), width, background);
}

function renderFramePanelRow(line: string, innerWidth: number, span: number, background: string, sideBorder: string): string {
  const singleColumn = SINGLE_COLUMN_FRAME_TEXT.test(line);
  if (singleColumn && line.length <= innerWidth) {
    return `${sideBorder}${background} ${line} ${" ".repeat(innerWidth - line.length)}${ANSI_RESET}${sideBorder}`;
  }
  const lineWidth = singleColumn ? line.length : visibleWidth(line);
  const boundedLine = lineWidth > innerWidth ? truncateToWidth(line, innerWidth, "…", true) : line;
  const boundedWidth = lineWidth > innerWidth ? (singleColumn ? boundedLine.length : visibleWidth(boundedLine)) : lineWidth;
  return sideBorder + panelBgFillMeasured(` ${boundedLine} `, boundedWidth + 2, span, background) + sideBorder;
}

export function createFramePanelRowRenderer(innerWidth: number, background = ANSI_PANEL_BG): (line: string) => string {
  const span = innerWidth + 2;
  const sideBorder = `${background}${ANSI_PURPLE}│${ANSI_RESET}`;
  return (line: string) => renderFramePanelRow(line, innerWidth, span, background, sideBorder);
}

// Wrap content lines in a rounded border with a dark interior. `innerWidth` is
// the column count between the one-space padding inside each side border.
export function framePanel(contentLines: string[], innerWidth: number, background = ANSI_PANEL_BG): string[] {
  const span = innerWidth + 2;
  const rule = "─".repeat(span);
  const border = (text: string) => `${background}${ANSI_PURPLE}${text}${ANSI_RESET}`;
  const sideBorder = border("│");
  const out: string[] = [border(`╭${rule}╮`)];
  for (const line of contentLines) {
    const lineWidth = visibleWidth(line);
    const boundedLine = lineWidth > innerWidth ? truncateToWidth(line, innerWidth, "…", true) : line;
    const boundedWidth = lineWidth > innerWidth ? visibleWidth(boundedLine) : lineWidth;
    out.push(sideBorder + panelBgFillMeasured(` ${boundedLine} `, boundedWidth + 2, span, background) + sideBorder);
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
