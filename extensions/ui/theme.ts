export type ExtendedTeamsForegroundToken =
  | "accent"
  | "border"
  | "borderAccent"
  | "customMessageLabel"
  | "dim"
  | "error"
  | "muted"
  | "success"
  | "syntaxFunction"
  | "syntaxString"
  | "text"
  | "thinkingText"
  | "warning";

export type ExtendedTeamsBackgroundToken = "customMessageBg";

export interface ExtendedTeamsTheme {
  fg(token: ExtendedTeamsForegroundToken, text: string): string;
  bg(token: ExtendedTeamsBackgroundToken, text: string): string;
}

const plainTheme: ExtendedTeamsTheme = {
  fg: (_token, text) => text,
  bg: (_token, text) => text,
};

export function resolveExtendedTeamsTheme(theme?: Partial<ExtendedTeamsTheme> | null): ExtendedTeamsTheme {
  if (!theme) return plainTheme;
  return {
    fg: (token, text) => typeof theme.fg === "function" ? theme.fg(token, text) : text,
    bg: (token, text) => typeof theme.bg === "function" ? theme.bg(token, text) : text,
  };
}
