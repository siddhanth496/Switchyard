/**
 * Core domain types. Everything the board, dispatcher, orchestrator and UI
 * share lives here, so the server can ship snapshots of it as plain JSON.
 */

export type Role =
  | "ceo"
  | "pm"
  | "task_creator"
  | "tech_lead"
  | "engineer"
  | "designer"
  | "qa"
  | "cfo"
  | "devops";

export type TicketStatus =
  | "backlog" // created, not yet released to the dispatcher
  | "ready" // waiting for the dispatcher
  | "in_progress" // an engineer holds it, with file leases
  | "review" // built and committed, waiting for review
  | "done" // merged into main
  | "failed" // out of attempts, waiting on the CEO
  | "skipped"; // the CEO chose to skip it; dependents go ahead without it

export interface Ticket {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  /** Area id from the ownership map. */
  area: string;
  /** Files (or directory prefixes ending in "/") the ticket expects to touch. */
  files: string[];
  /** Ticket ids that must be done first. */
  dependsOn: string[];
  status: TicketStatus;
  /** Lower runs first. */
  priority: number;
  assignee?: string;
  attempts: number;
  /** Reviewer feedback from the last rejected attempt. */
  feedback?: string;
  /** Files the last attempt actually changed. */
  changedFiles?: string[];
  /** Why each failed attempt failed, oldest first. */
  failures?: string[];
  /** True when the next attempt goes to the tech lead. */
  escalated?: boolean;
  /** "bug" for tickets QA filed. */
  kind?: "feature" | "bug";
  costUsd: number;
  createdAt: number;
  updatedAt: number;
}

export interface Area {
  id: string;
  name: string;
  /** Path prefixes this area owns, e.g. "src/auth/". */
  paths: string[];
  /** Agent id of the area lead: reviews notes, is first choice for work. */
  lead: string;
  /** Agent ids allowed to work in this area (lead included). */
  members: string[];
  /** Max tickets running at once in this area. Defaults to members.length. */
  maxParallel?: number;
  /** Shared hotspots (schema, routes, manifests): tickets run one at a time. */
  shared?: boolean;
}

export type AgentStatus = "idle" | "working" | "offline";

export interface Agent {
  id: string;
  name: string;
  role: Role;
  status: AgentStatus;
  /** Home area for engineers. Engineers with no area are floaters. */
  area?: string;
  currentTicket?: string;
  /** Last line of activity, for the live agent cards. */
  activity?: string;
  spentUsd: number;
}

export interface Lease {
  ticketId: string;
  agentId: string;
  files: string[];
  acquiredAt: number;
}

export type GateKind = "prd" | "architecture" | "spend" | "release" | "ticket_failed";
export type GateStatus = "pending" | "approved" | "rejected";

export interface Gate {
  id: string;
  kind: GateKind;
  title: string;
  /** Markdown shown to the CEO. */
  content: string;
  status: GateStatus;
  feedback?: string;
  /** The ticket a "ticket_failed" gate is about. */
  ticketId?: string;
  createdAt: number;
  resolvedAt?: number;
}

export type ProjectPhase =
  | "idle"
  | "planning" // PM writing the PRD
  | "architecture" // tech lead defining areas
  | "ticketing" // task creator breaking down work
  | "building" // dispatcher + engineers running
  | "testing" // QA testing the merged build
  | "paused" // waiting on a spend gate
  | "releasing" // waiting on the release gate
  | "shipped"
  | "failed";

export interface Project {
  id: string;
  name: string;
  idea: string;
  dir: string;
  phase: ProjectPhase;
  budgetUsd: number;
  spentUsd: number;
  createdAt: number;
}

export interface LogEntry {
  at: number;
  agentId?: string;
  ticketId?: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface BoardSnapshot {
  project: Project | null;
  tickets: Ticket[];
  areas: Area[];
  agents: Agent[];
  leases: Lease[];
  gates: Gate[];
  log: LogEntry[];
}
