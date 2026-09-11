import { spawnSync } from "node:child_process";

export function herdrCommand(...args: string[]): string {
  if (process.env.HERDR_ENV !== "1") throw new Error("This action requires Herdr.");
  const result = spawnSync("herdr", args, { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) {
    let code: string | undefined;
    try { code = JSON.parse(result.stderr).error?.code; } catch { /* Non-JSON CLI failure. */ }
    if (args[0] === "pane" && args[1] === "close" && code === "pane_not_found") return "";
    throw new Error(result.stderr || result.error?.message || "Herdr command failed.");
  }
  return result.stdout;
}
