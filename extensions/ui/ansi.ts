export const ANSI_RESET = "\x1b[0m";
export const ANSI_PINK = "\x1b[38;5;213m";
export const ANSI_PURPLE = "\x1b[38;5;141m";
export const ANSI_DIM = "\x1b[2m";

export function pink(text: string): string {
  return `${ANSI_PINK}${text}${ANSI_RESET}`;
}

export function purple(text: string): string {
  return `${ANSI_PURPLE}${text}${ANSI_RESET}`;
}

export function dimAnsi(text: string): string {
  return `${ANSI_DIM}${text}${ANSI_RESET}`;
}
