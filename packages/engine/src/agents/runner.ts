import type { Area, Role, Ticket } from "../core/types.js";

export type TaskKind =
  | "prd"
  | "brand"
  | "design"
  | "feasibility"
  | "architecture"
  | "tickets"
  | "build"
  | "review"
  | "qa"
  | "design_review"
  | "launch";

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
  /** Hard spend cap for this task; the run is cut off past it. */
  budgetUsd?: number;
  /** Structured context, so test and mock runners don't need to parse prompts. */
  context: {
    idea?: string;
    prd?: string;
    feedback?: string;
    areas?: Area[];
    ticket?: Ticket;
    /** All tickets in a batch, the primary first. */
    batch?: Ticket[];
    diff?: string;
    /** QA round, starting at 1. */
    qaRound?: number;
    /** What the CEO asked to change in an existing product. */
    changeRequest?: string;
    /** The approved brand, as markdown. */
    brand?: string;
    /** The design under review or being revised, as markdown. */
    design?: string;
    /** Notes from the PM's last feasibility review. */
    pmNotes?: string;
    /** Design round, starting at 1; the last one is the PM's final call. */
    designRound?: number;
    finalRound?: boolean;
  };
}

export interface AgentResult {
  ok: boolean;
  /** The agent's final message. */
  text: string;
  costUsd: number;
  error?: string;
  /** True if the run was cut off for hitting its spend cap. */
  overBudget?: boolean;
}

export type ActivityListener = (line: string) => void;

export interface AgentRunner {
  readonly name: string;
  run(task: AgentTask, onActivity: ActivityListener, signal?: AbortSignal): Promise<AgentResult>;
}
