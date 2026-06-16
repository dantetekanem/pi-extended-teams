import { Key, matchesKey } from "@mariozechner/pi-tui";

export function isDownInput(data: string): boolean {
  return matchesKey(data, Key.down) || data === "\x1b[B" || data === "j" || data === "J" || data === "\x0e";
}

export function isUpInput(data: string): boolean {
  return matchesKey(data, Key.up) || data === "\x1b[A" || data === "k" || data === "K" || data === "\x10";
}

export function isLeftInput(data: string): boolean {
  return matchesKey(data, Key.left) || data === "\x1b[D" || data === "h" || data === "H";
}

export function isRightInput(data: string): boolean {
  return matchesKey(data, Key.right) || data === "\x1b[C" || data === "l" || data === "L";
}
