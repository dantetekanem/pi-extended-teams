import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as paths from "../utils/paths";
import { withLock } from "../utils/lock";
import { createReportResult, effectiveTaskOutcome, ReportedTaskDetailsSchema, type ReportResult } from "./report-result";
import { syncPathAndParents, writeJsonDurably } from "./durable-json";

const reference = Type.String({ minLength: 1 });
const variants = <T extends string>(...values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
export const CompletionGroupPolicySchema = Type.Object({
  delivery: variants("immediate", "all-settled"),
}, { additionalProperties: false });
export type CompletionGroupPolicy = Static<typeof CompletionGroupPolicySchema>;
export function normalizeCompletionGroupPolicy(value: unknown): CompletionGroupPolicy | undefined {
  if (value === undefined) return undefined;
  if (!Value.Check(CompletionGroupPolicySchema, value)) throw new Error("Invalid completion group policy.");
  return structuredClone(value);
}
const SeedSchema = Type.Object({
  name: reference, suppressed: Type.Optional(Type.Boolean()), assignmentKey: Type.Optional(reference),
}, { additionalProperties: false });
const seed = (member: Static<typeof SeedSchema>) => ({
  name: member.name, suppressed: member.suppressed === true,
  ...(member.assignmentKey ? { assignmentKey: member.assignmentKey } : {}),
});
const OptionsSchema = Type.Object({
  teamName: reference, sessionId: reference, submissionId: reference,
  policy: CompletionGroupPolicySchema, members: Type.Array(SeedSchema, { minItems: 1 }),
}, { additionalProperties: false });
export interface CompletionGroupOptions extends Omit<Static<typeof OptionsSchema>, "policy"> {
  policy?: CompletionGroupPolicy;
}
export interface CompletionGroupBinding { groupId: string; slotId: string; }
const ReportSchema = Type.Object({
  runId: reference, reportId: reference, runtimeStatus: Type.Optional(variants("completed", "failed")),
  outcome: ReportedTaskDetailsSchema.properties.outcome,
  effectiveOutcome: ReportedTaskDetailsSchema.properties.outcome,
  verification: variants("not-requested", "pending", "passed", "failed", "stale"),
}, { additionalProperties: false });
const MemberSchema = Type.Object({
  slotId: reference, name: reference, suppressed: Type.Boolean(), assignmentKey: Type.Optional(reference),
  status: variants("pending", "queued", "running", "reported", "rejected", "cancelled", "interrupted"),
  queueId: Type.Optional(reference), runId: Type.Optional(reference),
  report: Type.Optional(ReportSchema), reason: Type.Optional(reference),
}, { additionalProperties: false });
const DeliverySchema = Type.Object({
  id: reference, kind: variants("member", "urgent", "settled"),
  slotIds: Type.Array(reference, { minItems: 1, uniqueItems: true }), status: variants("pending", "enqueued"),
  wake: Type.Optional(Type.Object({ state: variants("pending", "observed"), entryId: Type.Optional(reference),
    error: Type.Optional(reference) }, { additionalProperties: false })),
}, { additionalProperties: false });
const LedgerSchema = Type.Object({
  version: Type.Literal(1), groupId: reference, teamName: reference, sessionId: reference, submissionId: reference,
  policy: CompletionGroupPolicySchema, sealed: Type.Boolean(),
  members: Type.Array(MemberSchema, { minItems: 1 }), deliveries: Type.Array(DeliverySchema),
}, { additionalProperties: false });
export type CompletionGroupState = Static<typeof LedgerSchema>;
export type CompletionDelivery = Static<typeof DeliverySchema>;
const eventBinding = { slotId: reference, groupId: Type.Optional(reference) };
const EventSchema = Type.Union([
  Type.Object({ ...eventBinding, type: Type.Literal("queued"), queueId: reference }, { additionalProperties: false }),
  Type.Object({ ...eventBinding, type: Type.Literal("running"), runId: reference }, { additionalProperties: false }),
  Type.Object({ ...eventBinding, type: Type.Literal("reported"), report: ReportSchema }, { additionalProperties: false }),
  Type.Object({ ...eventBinding, type: variants("rejected", "cancelled", "interrupted"),
    runId: Type.Optional(reference), reason: reference }, { additionalProperties: false }),
  Type.Object({ ...eventBinding, type: variants("rejected", "cancelled"),
    queueId: reference, reason: reference }, { additionalProperties: false }),
]);
export type CompletionGroupEvent = Static<typeof EventSchema>;
const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const completionGroupIdentity = (options: Pick<CompletionGroupOptions, "teamName" | "sessionId" | "submissionId">) =>
  `group:${digest([options.teamName, options.sessionId, options.submissionId])}`;
const terminal = (member: CompletionGroupState["members"][number]) =>
  !["pending", "queued", "running"].includes(member.status);
const urgent = (member: CompletionGroupState["members"][number]) => member.status === "rejected" || (!!member.report &&
  (member.report.runtimeStatus === "failed" || ["blocked", "failed"].includes(member.report.effectiveOutcome ?? member.report.outcome ?? "") || ["failed", "stale"].includes(member.report.verification)));
const deliveryIdentity = (groupId: string, kind: CompletionDelivery["kind"], slots: string[]) =>
  `delivery:${digest([groupId, kind, slots])}`;

export class CompletionGroup {
  readonly journalPath: string;
  private newlyCreated = false;
  get created(): boolean { return this.newlyCreated; }

  constructor(readonly teamName: string, readonly groupId: string) {
    if (!teamName || !/^group:[a-f0-9]{64}$/.test(groupId)) throw new Error("Invalid completion group identity.");
    this.journalPath = path.join(paths.teamDir(teamName), "completion-groups", `${groupId.slice(6)}.json`);
  }

  static async create(options: CompletionGroupOptions): Promise<CompletionGroup | undefined> {
    if (normalizeCompletionGroupPolicy(options.policy) === undefined) return undefined;
    if (!Value.Check(OptionsSchema, options)) throw new Error("Invalid completion group assignment.");
    const bound = structuredClone(options);
    const group = new CompletionGroup(bound.teamName, completionGroupIdentity(bound));
    const seeds = bound.members.map(seed);
    fs.mkdirSync(path.dirname(group.journalPath), { recursive: true, mode: 0o700 });
    await withLock(group.journalPath, async () => {
      if (fs.existsSync(group.journalPath)) {
        const existing = group.read();
        if (!isDeepStrictEqual(existing.policy, bound.policy)
          || !isDeepStrictEqual(existing.members.map(seed), seeds)) {
          throw new Error("Completion group assignment binding has changed.");
        }
        syncPathAndParents(group.journalPath);
        return;
      }
      writeJsonDurably(group.journalPath, {
        version: 1, groupId: group.groupId, teamName: bound.teamName, sessionId: bound.sessionId,
        submissionId: bound.submissionId, policy: bound.policy, sealed: false, deliveries: [],
        members: seeds.map((member, index) => ({ ...member, slotId: `${group.groupId}:${index}`, status: "pending" })),
      });
      group.newlyCreated = true;
    });
    return group;
  }

  read(): CompletionGroupState {
    let state: unknown;
    try { state = JSON.parse(fs.readFileSync(this.journalPath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Referenced completion group is unavailable; inspect ${this.journalPath}.`);
      }
      throw new Error(`Corrupt completion group; inspect ${this.journalPath}.`);
    }
    if (!Value.Check(LedgerSchema, state) || state.groupId !== this.groupId
      || state.teamName !== this.teamName || completionGroupIdentity(state) !== this.groupId) {
      throw new Error("Corrupt completion group binding.");
    }
    for (const [index, member] of state.members.entries()) {
      const reportId = member.runId && createReportResult(state.teamName, member.name, member.runId, {}).reportId;
      if (member.slotId !== `${this.groupId}:${index}`
        || (member.status === "pending" && (member.runId || member.queueId))
        || (member.status === "queued" && (!member.queueId || member.runId))
        || (member.status === "running" && !member.runId)
        || ((member.status === "reported") !== !!member.report)
        || (member.report && (member.report.runId !== member.runId || member.report.reportId !== reportId))) {
        throw new Error("Corrupt completion member binding.");
      }
    }
    if (new Set(state.deliveries.map(delivery => delivery.id)).size !== state.deliveries.length) {
      throw new Error("Corrupt completion delivery identity.");
    }
    for (const delivery of state.deliveries) {
      if ((delivery.wake && (delivery.status !== "enqueued" || ((delivery.wake.state === "observed") !== !!delivery.wake.entryId)))
        || delivery.id !== deliveryIdentity(this.groupId, delivery.kind, delivery.slotIds)
        || (delivery.kind !== "settled" && delivery.slotIds.length !== 1)
        || (delivery.kind === "settled" && (!state.sealed || !state.members.every(terminal)))
        || delivery.slotIds.some(id => !state.members.some(member => member.slotId === id && terminal(member) && !member.suppressed))) {
        throw new Error("Corrupt completion delivery binding.");
      }
    }
    return state;
  }

  binding(index: number): CompletionGroupBinding {
    const member = this.read().members[index];
    if (!member) throw new Error("Unknown completion group slot.");
    return { groupId: this.groupId, slotId: member.slotId };
  }

  private plan(state: CompletionGroupState): void {
    const visible = state.members.filter(member => terminal(member) && !member.suppressed);
    const covered = new Set(state.deliveries.flatMap(delivery => delivery.slotIds));
    const due = visible.filter(member => !covered.has(member.slotId));
    const append = (kind: CompletionDelivery["kind"], slotIds: string[]) => {
      state.deliveries.push({ id: deliveryIdentity(this.groupId, kind, slotIds), kind, slotIds, status: "pending" });
    };
    if (due.length === 0) return;
    if (state.policy.delivery === "all-settled" && state.sealed && state.members.every(terminal)) {
      append("settled", visible.map(member => member.slotId));
      return;
    }
    for (const member of due) {
      if (state.policy.delivery === "immediate") append("member", [member.slotId]);
      else if (urgent(member)) append("urgent", [member.slotId]);
    }
  }

  private async update(change: (state: CompletionGroupState) => void): Promise<CompletionGroupState> {
    this.read();
    return withLock(this.journalPath, async () => {
      const state = this.read();
      const before = JSON.stringify(state);
      change(state);
      this.plan(state);
      if (JSON.stringify(state) !== before) writeJsonDurably(this.journalPath, state);
      else syncPathAndParents(this.journalPath);
      return state;
    });
  }

  async apply(event: CompletionGroupEvent): Promise<void> {
    if (!Value.Check(EventSchema, event) || (event.groupId && event.groupId !== this.groupId)) {
      throw new Error("Invalid completion event binding.");
    }
    const input = structuredClone(event);
    if (input.type === "reported") {
      if (input.report.outcome === undefined) delete input.report.outcome;
      if (input.report.effectiveOutcome === undefined) delete input.report.effectiveOutcome;
    }
    await this.update(state => {
      const member = state.members.find(item => item.slotId === input.slotId);
      if (!member) throw new Error("Unknown completion slot binding.");
      if (input.type === "queued") {
        if (member.queueId === input.queueId) return;
        if (member.status !== "pending") throw new Error("Completion slot is already admitted or settled.");
        Object.assign(member, { queueId: input.queueId, status: "queued" });
      } else if (input.type === "running") {
        if (member.runId) {
          if (member.runId !== input.runId) throw new Error("Completion run binding has changed.");
          return;
        }
        if (terminal(member)) throw new Error("Completion slot is already settled.");
        Object.assign(member, { runId: input.runId, status: "running" });
      } else if (input.type === "reported") {
        const expected = member.runId && createReportResult(this.teamName, member.name, member.runId, {}).reportId;
        if (input.report.runId !== member.runId || input.report.reportId !== expected) {
          throw new Error("Completion report binding has changed.");
        }
        if (member.report) {
          if (!isDeepStrictEqual(member.report, input.report)) throw new Error("Conflicting completion report binding.");
          return;
        }
        if (member.status !== "running") throw new Error("Completion slot is already settled.");
        Object.assign(member, { report: input.report, status: "reported" });
      } else {
        if ("queueId" in input) {
          // Queue identity is immutable across admission. Resolve its terminal
          // state under this lock, retaining any run bound while removal waited.
          if (member.queueId !== input.queueId) throw new Error("Completion settlement queue binding has changed.");
        } else if (member.runId !== input.runId) throw new Error("Completion settlement run binding has changed.");
        if (terminal(member)) return;
        Object.assign(member, { status: input.type, reason: input.reason });
      }
    });
  }

  async recordReport(slotId: string, result: ReportResult, runtimeStatus?: "completed" | "failed"): Promise<void> {
    await this.apply({ type: "reported", slotId, report: { reportId: result.reportId, runId: result.runId,
      ...(runtimeStatus ? { runtimeStatus } : {}),
      outcome: result.outcome, effectiveOutcome: effectiveTaskOutcome(result), verification: result.verification.state } });
  }

  async seal(): Promise<void> { await this.update(state => { state.sealed = true; }); }

  async prepareDeliveries(): Promise<CompletionDelivery[]> {
    const state = await this.update(() => {});
    return state.deliveries.filter(delivery => delivery.status === "pending");
  }

  async reserveWake(deliveryId: string): Promise<boolean> {
    let reserved = false;
    await this.update(state => {
      const delivery = state.deliveries.find(item => item.id === deliveryId);
      if (delivery?.status !== "enqueued") throw new Error("Completion wake requires an enqueued index.");
      if (!delivery.wake) {
        delivery.wake = { state: "pending" };
        reserved = true;
      }
    });
    return reserved;
  }

  async recordWakeEvidence(deliveryId: string, evidence: { entryId: string } | { error: string }): Promise<void> {
    await this.update(state => {
      const wake = state.deliveries.find(item => item.id === deliveryId)?.wake;
      if (!wake) throw new Error("Completion wake has no reserved request.");
      if ("entryId" in evidence) {
        if (!evidence.entryId || (wake.entryId && wake.entryId !== evidence.entryId)) throw new Error("Completion wake observation binding has changed.");
        Object.assign(wake, { state: "observed", entryId: evidence.entryId });
      } else {
        if (!evidence.error) throw new Error("Completion wake error is unavailable.");
        wake.error = evidence.error;
      }
    });
  }

  async markEnqueued(deliveryId: string): Promise<void> {
    await this.update(state => {
      const delivery = state.deliveries.find(item => item.id === deliveryId);
      if (!delivery) throw new Error("Unknown completion delivery identity.");
      delivery.status = "enqueued";
    });
  }
}
