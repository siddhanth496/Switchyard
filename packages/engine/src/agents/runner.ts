import type { Area, Role, Ticket } from "../core/types.js";

export type TaskKind = "prd" | "architecture" | "tickets" | "build" | "review";

/** One unit of agent work. The orchestrator builds these; runners execute them. */
export interface AgentTask {
  kind: TaskKind;
  agentId: string;
  role: Role;
  systemPrompt: string;
  prompt: string;
  /** Working directory: the project repo, or a ticket's worktree. */
  cwd: string;
  /** Whether the agent may edit files and run commands. */
  canWrite: boolean;
  maxTurns?: number;
  /** A last-chance attempt after repeated failures; runners may use a stronger model. */
  escalated?: boolean;
  /** Structured context, so test and mock runners don't need to parse prompts. */
  context: {
    idea?: string;
    prd?: string;
    feedback?: string;
    areas?: Area[];
    ticket?: Ticket;
    diff?: string;
  };
}

export interface AgentResult {
  ok: boolean;
  /** The agent's final message. */
  text: string;
  costUsd: number;
  error?: string;
}

export type ActivityListener = (line: string) => void;

export interface AgentRunner {
  readonly name: string;
  run(task: AgentTask, onActivity: ActivityListener, signal?: AbortSignal): Promise<AgentResult>;
}
