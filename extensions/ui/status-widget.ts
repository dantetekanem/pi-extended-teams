import { frameWidgetFullWidth } from "./frame";

export function bottomStatusWidget(contentLines: string[]) {
  return (_tui: any, _theme: any) => ({
    render(width: number): string[] {
      return frameWidgetFullWidth(contentLines, width);
    },
    invalidate() {},
  });
}
