// Project: pi-extended-teams
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createTask,
  updateTask,
  readTask,
  listTasks,
  submitPlan,
  evaluatePlan,
  markOwnerTasksBlockedByFileClaims,
  clearOwnerFileClaimBlocks,
  updateTaskGuarded,
} from "./tasks";
import * as paths from "./paths";
import * as teams from "./teams";

// Keep this suite isolated from messaging tests and parallel Vitest workers.
let testDir: string;

describe("Tasks Utilities", () => {
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-tasks-"));
    
    // Override paths to use testDir
    vi.spyOn(paths, "taskDir").mockReturnValue(testDir);
    vi.spyOn(paths, "configPath").mockReturnValue(path.join(testDir, "config.json"));
    
    // Create a dummy team config
    fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify({ name: "test-team" }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("should create a task successfully", async () => {
    const task = await createTask("test-team", "Test Subject", "Test Description");
    expect(task.id).toBe("1");
    expect(task.subject).toBe("Test Subject");
    expect(fs.existsSync(path.join(testDir, "1.json"))).toBe(true);
  });

  it("should update a task successfully", async () => {
    await createTask("test-team", "Test Subject", "Test Description");
    const updated = await updateTask("test-team", "1", { status: "in_progress" });
    expect(updated.status).toBe("in_progress");
    
    const taskData = JSON.parse(fs.readFileSync(path.join(testDir, "1.json"), "utf-8"));
    expect(taskData.status).toBe("in_progress");
  });

  it("should guard task updates by version and operation id", async () => {
    const task = await createTask("test-team", "Guarded", "Description");
    const result = await updateTaskGuarded(
      "test-team",
      task.id,
      { status: "in_progress" },
      { expectedStatus: "pending", expectedVersion: task.version, operationId: "op-1" }
    );

    expect(result.updated).toBe(true);
    expect(result.idempotent).toBe(false);
    expect(result.task.status).toBe("in_progress");

    const replay = await updateTaskGuarded(
      "test-team",
      task.id,
      { status: "completed" },
      { expectedStatus: "pending", expectedVersion: task.version, operationId: "op-1" }
    );
    expect(replay.updated).toBe(false);
    expect(replay.idempotent).toBe(true);
    expect(replay.task.status).toBe("in_progress");

    await expect(updateTaskGuarded(
      "test-team",
      task.id,
      { status: "completed" },
      { expectedStatus: "pending", expectedVersion: task.version }
    )).rejects.toThrow(/status guard failed/);
  });

  it("should submit a plan successfully", async () => {
    const task = await createTask("test-team", "Test Subject", "Test Description");
    const plan = "Step 1: Do something\nStep 2: Profit";
    const updated = await submitPlan("test-team", task.id, plan);
    expect(updated.status).toBe("planning");
    expect(updated.plan).toBe(plan);
    
    const taskData = JSON.parse(fs.readFileSync(path.join(testDir, `${task.id}.json`), "utf-8"));
    expect(taskData.status).toBe("planning");
    expect(taskData.plan).toBe(plan);
  });

  it("should fail to submit an empty plan", async () => {
    const task = await createTask("test-team", "Empty Test", "Should fail");
    await expect(submitPlan("test-team", task.id, "")).rejects.toThrow("Plan must not be empty");
    await expect(submitPlan("test-team", task.id, "   ")).rejects.toThrow("Plan must not be empty");
  });

  it("should list tasks", async () => {
    await createTask("test-team", "Task 1", "Desc 1");
    await createTask("test-team", "Task 2", "Desc 2");
    const tasksList = await listTasks("test-team");
    expect(tasksList.length).toBe(2);
    expect(tasksList[0].id).toBe("1");
    expect(tasksList[1].id).toBe("2");
  });

  it("should have consistent lock paths (Fixed BUG 2)", async () => {
    // This test verifies that both updateTask and readTask now use the same lock path
    // Both should now lock `${taskId}.json.lock`
    
    await createTask("test-team", "Bug Test", "Testing lock consistency");
    const taskId = "1";
    
    const taskFile = path.join(testDir, `${taskId}.json`);
    const commonLockFile = `${taskFile}.lock`;
    
    // 1. Holding the common lock
    fs.writeFileSync(commonLockFile, "9999");
    
    // 2. Try updateTask, it should fail
    // Using small retries to speed up the test and avoid fake timer issues with native setTimeout
    await expect(updateTask("test-team", taskId, { status: "in_progress" }, 2)).rejects.toThrow("Could not acquire lock");

    // 3. Try readTask, it should fail too
    await expect(readTask("test-team", taskId, 2)).rejects.toThrow("Could not acquire lock");
    
    fs.unlinkSync(commonLockFile);
  });

  it("should approve a plan successfully", async () => {
    const task = await createTask("test-team", "Plan Test", "Should be approved");
    await submitPlan("test-team", task.id, "Wait for it...");
    
    const approved = await evaluatePlan("test-team", task.id, "approve");
    expect(approved.status).toBe("in_progress");
    expect(approved.planFeedback).toBe("");
  });

  it("should reject a plan with feedback", async () => {
    const task = await createTask("test-team", "Plan Test", "Should be rejected");
    await submitPlan("test-team", task.id, "Wait for it...");
    
    const feedback = "Not good enough!";
    const rejected = await evaluatePlan("test-team", task.id, "reject", feedback);
    expect(rejected.status).toBe("planning");
    expect(rejected.planFeedback).toBe(feedback);
  });

  it("should fail to evaluate a task not in 'planning' status", async () => {
    const task = await createTask("test-team", "Status Test", "Invalid status for eval");
    // status is "pending"
    await expect(evaluatePlan("test-team", task.id, "approve")).rejects.toThrow("must be in 'planning' status");
  });

  it("should fail to evaluate a task without a plan", async () => {
    const task = await createTask("test-team", "Plan Missing Test", "No plan submitted");
    await updateTask("test-team", task.id, { status: "planning" }); // bypass submitPlan to have no plan
    await expect(evaluatePlan("test-team", task.id, "approve")).rejects.toThrow("no plan has been submitted");
  });

  it("should fail to reject a plan without feedback", async () => {
    const task = await createTask("test-team", "Feedback Test", "Should require feedback");
    await submitPlan("test-team", task.id, "My plan");
    await expect(evaluatePlan("test-team", task.id, "reject")).rejects.toThrow("Feedback is required when rejecting a plan");
    await expect(evaluatePlan("test-team", task.id, "reject", "   ")).rejects.toThrow("Feedback is required when rejecting a plan");
  });

  it("marks owned open tasks blocked by file-claim conflicts", async () => {
    const task = await createTask("test-team", "Claim Block Test", "Should be blocked");
    await updateTask("test-team", task.id, {
      status: "in_progress",
      owner: "alice",
      blockedBy: ["upstream-task"],
    });

    const conflicts = [{ path: "src/a.ts", heldBy: "bob" }];
    const updated = await markOwnerTasksBlockedByFileClaims(
      "test-team",
      "alice",
      conflicts,
      "2026-06-14T00:00:00.000Z"
    );

    expect(updated.map(t => t.id)).toEqual([task.id]);
    const blockedTask = await readTask("test-team", task.id);
    expect(blockedTask.blockedBy).toEqual(["upstream-task", "file-claim:src%2Fa.ts:bob"]);
    expect(blockedTask.metadata?.fileClaimBlock).toEqual({
      blockedAt: "2026-06-14T00:00:00.000Z",
      conflicts,
    });
  });

  it("clears file-claim blockers after the owner gets the claim", async () => {
    const task = await createTask("test-team", "Claim Clear Test", "Should unblock");
    await updateTask("test-team", task.id, {
      status: "in_progress",
      owner: "alice",
      blockedBy: ["upstream-task"],
    });
    await markOwnerTasksBlockedByFileClaims(
      "test-team",
      "alice",
      [{ path: "src/a.ts", heldBy: "bob" }],
      "2026-06-14T00:00:00.000Z"
    );

    const updated = await clearOwnerFileClaimBlocks("test-team", "alice", ["src/a.ts"]);

    expect(updated.map(t => t.id)).toEqual([task.id]);
    const unblockedTask = await readTask("test-team", task.id);
    expect(unblockedTask.blockedBy).toEqual(["upstream-task"]);
    expect(unblockedTask.metadata?.fileClaimBlock).toBeUndefined();
  });

  it("should sanitize task IDs in all file operations", async () => {
    const dirtyId = "../evil-id";
    // sanitizeName should throw on this dirtyId
    await expect(readTask("test-team", dirtyId)).rejects.toThrow(/Invalid name: "..\/evil-id"/);
    await expect(updateTask("test-team", dirtyId, { status: "in_progress" })).rejects.toThrow(/Invalid name: "..\/evil-id"/);
    await expect(evaluatePlan("test-team", dirtyId, "approve")).rejects.toThrow(/Invalid name: "..\/evil-id"/);
  });
});
