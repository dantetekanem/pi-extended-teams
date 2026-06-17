export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface Member {
  agentId: string;
  name: string;
  agentType: string;
  model?: string;
  joinedAt: number;
  tmuxPaneId: string;
  windowId?: string;
  cwd: string;
  subscriptions: any[];
  prompt?: string;
  color?: string;
  thinking?: ThinkingLevel;
  planModeRequired?: boolean;
  backendType?: string;
  isActive?: boolean;
  /** "read" agents run in-process (no pane); "write" agents spawn in tmux. */
  role?: "read" | "write";
  /** Optional category preset name from settings.json. */
  category?: string;
  /** Agent that requested this read helper; final reports are delivered there. */
  requestedBy?: string;
  /** Marks extension-managed helper agents with special delivery/cleanup semantics. */
  helperKind?: "read_helper";
}

export interface TeamConfig {
  name: string;
  description: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId: string;
  members: Member[];
  defaultModel?: string;
  separateWindows?: boolean;
}

export interface TaskFile {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "planning" | "in_progress" | "completed" | "deleted";
  plan?: string;
  planFeedback?: string;
  blocks: string[];
  blockedBy: string[];
  owner?: string;
  metadata?: Record<string, any>;
}

export interface InboxMessage {
  from: string;
  text: string;
  timestamp: string;
  read: boolean;
  summary?: string;
  color?: string;
}
