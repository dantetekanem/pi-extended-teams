import { listCheckpointRecords, retireCheckpoint } from "./specialist-checkpoint";

export async function expireCheckpoints(now = Date.now()): Promise<string[]> {
  const { records, errors } = listCheckpointRecords();
  const diagnostics = errors.map(error => error.message);
  for (const record of records) {
    if (record.state !== "ready" || record.expiresAt > now) continue;
    try {
      await retireCheckpoint(record.id, "expired", now);
    } catch (error) {
      diagnostics.push(`Checkpoint ${record.id}: ${String(error)}`);
    }
  }
  return diagnostics;
}
