import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock";

const [lockPath, gateDir, pauseBeforeReap, holdCallback, retriesValue] = process.argv.slice(2);
if (!lockPath || !gateDir) throw new Error("lockPath and gateDir are required");

fs.mkdirSync(gateDir, { recursive: true });

const waitState = new Int32Array(new SharedArrayBuffer(4));
function waitAtGate(name: string): void {
  fs.writeFileSync(path.join(gateDir, `${name}.ready`), "");
  const releaseFile = path.join(gateDir, `${name}.release`);
  while (!fs.existsSync(releaseFile)) {
    Atomics.wait(waitState, 0, 0, 10);
  }
}

const lockFile = `${lockPath}.lock`;
const originalUnlinkSync = fs.unlinkSync;
let pausedBeforeReap = false;
fs.unlinkSync = ((target: fs.PathLike) => {
  if (pauseBeforeReap === "true" && String(target) === lockFile && !pausedBeforeReap) {
    pausedBeforeReap = true;
    waitAtGate("before-reap");
  }
  return originalUnlinkSync(target);
}) as typeof fs.unlinkSync;

function publishResult(result: object): void {
  const resultFile = path.join(gateDir, "result.json");
  const temporary = `${resultFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(result));
  fs.renameSync(temporary, resultFile);
}

withLock(lockPath, async () => {
  fs.writeFileSync(path.join(gateDir, "callback.ready"), "");
  if (holdCallback === "true") waitAtGate("callback");
  return process.pid;
}, Number(retriesValue)).then(
  pid => publishResult({ status: "success", pid }),
  error => publishResult({ status: "error", message: error instanceof Error ? error.message : String(error) }),
);
