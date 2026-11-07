import { randomUUID } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";

const [destination, runId] = process.argv.slice(2);
const timeout = setTimeout(() => process.exit(1), 2000);
timeout.unref();
let temporary;
try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Hook input exceeds limit");
    chunks.push(chunk);
  }
  const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    event?.hook_event_name === "StopFailure" &&
    !event.agent_id &&
    ["rate_limit", "overloaded"].includes(event.error)
  ) {
    temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ runId, reason: event.error }), { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  }
} finally {
  clearTimeout(timeout);
  if (temporary) await rm(temporary, { force: true });
}
