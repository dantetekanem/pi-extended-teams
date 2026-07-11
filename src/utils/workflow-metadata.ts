import type { Member } from "./models";

export type MemberMetadataLike = Pick<Member, "metadata"> | null | undefined;

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanTrue(value: unknown): boolean {
  return value === true;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(item => stringValue(item)).filter((item): item is string => !!item);
  return values.length > 0 ? values : [];
}

export function workflowRunIdFromMetadata(metadata: Record<string, any> | undefined): string | undefined {
  const orchestration = asRecord(metadata?.orchestration);
  return stringValue(metadata?.workflowRunId) || stringValue(orchestration?.workflowRunId);
}

export function operationIdFromMetadata(metadata: Record<string, any> | undefined): string | undefined {
  const orchestration = asRecord(metadata?.orchestration);
  return stringValue(metadata?.operationId) || stringValue(orchestration?.operationId);
}

export function memberWorkflowRunId(member: MemberMetadataLike): string | undefined {
  return workflowRunIdFromMetadata(member?.metadata);
}

export function memberOperationId(member: MemberMetadataLike): string | undefined {
  return operationIdFromMetadata(member?.metadata);
}

export function isWorkflowSpawnedMember(member: MemberMetadataLike): boolean {
  return !!memberWorkflowRunId(member);
}

export function workflowPolicyForMember(member: MemberMetadataLike): Record<string, any> {
  const metadata = member?.metadata;
  const orchestration = asRecord(metadata?.orchestration);
  return asRecord(metadata?.workflowPolicy)
    || asRecord(metadata?.workflow)
    || asRecord(orchestration?.workflowPolicy)
    || asRecord(orchestration?.workflow)
    || {};
}

export function workflowAllowsReadHelper(member: MemberMetadataLike): boolean {
  if (!isWorkflowSpawnedMember(member)) return true;
  const policy = workflowPolicyForMember(member);
  return booleanTrue(policy.allowReadHelper) || booleanTrue(policy.allow_read_helper);
}

export function workflowAllowedSkills(member: MemberMetadataLike): string[] | true | null {
  if (!isWorkflowSpawnedMember(member)) return true;
  const policy = workflowPolicyForMember(member);
  if (booleanTrue(policy.allowSkills) || booleanTrue(policy.allow_skills)) return true;
  return stringList(policy.allowedSkills)
    ?? stringList(policy.allowed_skills)
    ?? stringList(policy.declaredSkills)
    ?? stringList(policy.declared_skills)
    ?? stringList(policy.skills)
    ?? null;
}

export function workflowAllowsSkill(member: MemberMetadataLike, skillName: string): boolean {
  const allowed = workflowAllowedSkills(member);
  if (allowed === true) return true;
  if (!allowed) return false;
  return allowed.includes(skillName);
}

export function isPiPromptPlanningMember(member: MemberMetadataLike): boolean {
  return asRecord(member?.metadata?.piPromptPlanning)?.version === 1;
}

export function shouldSuppressLeadReportInjection(member: MemberMetadataLike): boolean {
  return isWorkflowSpawnedMember(member) || isPiPromptPlanningMember(member);
}
