import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Agent,
  Area,
  BoardSnapshot,
  Gate,
  GateKind,
  Lease,
  LogEntry,
  Project,
  Ticket,
  TicketStatus,
} from "./types.js";

export type BoardEvent =
  | { type: "project"; project: Project | null }
  | { type: "ticket"; ticket: Ticket }
  | { type: "agent"; agent: Agent }
  | { type: "areas"; areas: Area[] }
  | { type: "leases"; leases: Lease[] }
  | { type: "gate"; gate: Gate }
  | { type: "log"; entry: LogEntry }
  | { type: "reset"; snapshot: BoardSnapshot };

const MAX_LOG = 500;

/**
 * The job board: single source of truth for tickets, agents, areas, leases
 * and gates. In-memory with an optional JSON snapshot on disk; the store
 * interface is small so a Postgres version can replace it later.
 */
export class Board {
  private state: BoardSnapshot = emptySnapshot();
  private counters = { ticket: 0, gate: 0 };
  private readonly events = new EventEmitter();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly persistPath?: string) {
    this.events.setMaxListeners(100);
    if (persistPath && existsSync(persistPath)) {
      const raw = JSON.parse(readFileSync(persistPath, "utf8")) as {
        state: BoardSnapshot;
        counters: { ticket: number; gate: number };
      };
      this.state = raw.state;
      this.counters = raw.counters;
    }
  }

  // ---- events ----------------------------------------------------------

  on(listener: (e: BoardEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  private emit(e: BoardEvent): void {
    this.events.emit("event", e);
    this.scheduleSave();
  }

  // ---- reads -----------------------------------------------------------

  snapshot(): BoardSnapshot {
    return structuredClone(this.state);
  }

  get project(): Project | null {
    return this.state.project;
  }
  get tickets(): readonly Ticket[] {
    return this.state.tickets;
  }
  get areas(): readonly Area[] {
    return this.state.areas;
  }
  get agents(): readonly Agent[] {
    return this.state.agents;
  }
  get leases(): readonly Lease[] {
    return this.state.leases;
  }
  get gates(): readonly Gate[] {
    return this.state.gates;
  }

  ticket(id: string): Ticket {
    const t = this.state.tickets.find((x) => x.id === id);
    if (!t) throw new Error(`No ticket ${id}`);
    return t;
  }
  agent(id: string): Agent {
    const a = this.state.agents.find((x) => x.id === id);
    if (!a) throw new Error(`No agent ${id}`);
    return a;
  }
  area(id: string): Area | undefined {
    return this.state.areas.find((x) => x.id === id);
  }
  gate(id: string): Gate {
    const g = this.state.gates.find((x) => x.id === id);
    if (!g) throw new Error(`No gate ${id}`);
    return g;
  }

  // ---- project ---------------------------------------------------------

  reset(): void {
    this.state = emptySnapshot();
    this.counters = { ticket: 0, gate: 0 };
    this.emit({ type: "reset", snapshot: this.snapshot() });
  }

  setProject(project: Project): void {
    this.state.project = project;
    this.emit({ type: "project", project: { ...project } });
  }

  updateProject(patch: Partial<Project>): Project {
    if (!this.state.project) throw new Error("No project");
    Object.assign(this.state.project, patch);
    this.emit({ type: "project", project: { ...this.state.project } });
    return this.state.project;
  }

  // ---- agents and areas ------------------------------------------------

  addAgent(agent: Omit<Agent, "status" | "spentUsd"> & Partial<Agent>): Agent {
    const a: Agent = { status: "idle", spentUsd: 0, ...agent };
    this.state.agents.push(a);
    this.emit({ type: "agent", agent: { ...a } });
    return a;
  }

  updateAgent(id: string, patch: Partial<Agent>): Agent {
    const a = this.agent(id);
    Object.assign(a, patch);
    this.emit({ type: "agent", agent: { ...a } });
    return a;
  }

  setAreas(areas: Area[]): void {
    this.state.areas = areas;
    this.emit({ type: "areas", areas: structuredClone(areas) });
  }

  // ---- tickets ---------------------------------------------------------

  addTicket(
    t: Omit<Ticket, "id" | "status" | "attempts" | "costUsd" | "createdAt" | "updatedAt"> &
      Partial<Pick<Ticket, "id" | "status">>,
  ): Ticket {
    const now = Date.now();
    const ticket: Ticket = {
      status: "backlog",
      attempts: 0,
      costUsd: 0,
      createdAt: now,
      updatedAt: now,
      ...t,
      id: t.id ?? `T-${++this.counters.ticket}`,
    };
    this.state.tickets.push(ticket);
    this.emit({ type: "ticket", ticket: { ...ticket } });
    return ticket;
  }

  nextTicketId(): string {
    return `T-${++this.counters.ticket}`;
  }

  updateTicket(id: string, patch: Partial<Ticket>): Ticket {
    const t = this.ticket(id);
    Object.assign(t, patch, { updatedAt: Date.now() });
    this.emit({ type: "ticket", ticket: { ...t } });
    return t;
  }

  moveTicket(id: string, status: TicketStatus, patch: Partial<Ticket> = {}): Ticket {
    return this.updateTicket(id, { ...patch, status });
  }

  // ---- leases ----------------------------------------------------------

  acquireLease(lease: Lease): void {
    this.state.leases.push(lease);
    this.emit({ type: "leases", leases: structuredClone(this.state.leases) });
  }

  releaseLease(ticketId: string): void {
    const before = this.state.leases.length;
    this.state.leases = this.state.leases.filter((l) => l.ticketId !== ticketId);
    if (this.state.leases.length !== before) {
      this.emit({ type: "leases", leases: structuredClone(this.state.leases) });
    }
  }

  // ---- gates -----------------------------------------------------------

  openGate(kind: GateKind, title: string, content: string, ticketId?: string): Gate {
    const gate: Gate = {
      id: `G-${++this.counters.gate}`,
      kind,
      title,
      content,
      status: "pending",
      createdAt: Date.now(),
      ...(ticketId ? { ticketId } : {}),
    };
    this.state.gates.push(gate);
    this.emit({ type: "gate", gate: { ...gate } });
    return gate;
  }

  resolveGate(id: string, approved: boolean, feedback?: string): Gate {
    const g = this.gate(id);
    if (g.status !== "pending") throw new Error(`Gate ${id} is already ${g.status}`);
    g.status = approved ? "approved" : "rejected";
    g.feedback = feedback;
    g.resolvedAt = Date.now();
    this.emit({ type: "gate", gate: { ...g } });
    return g;
  }

  // ---- spend -----------------------------------------------------------

  /** Record agent spend against the agent, the ticket and the project. */
  addSpend(agentId: string, usd: number, ticketId?: string): void {
    if (!usd) return;
    const a = this.agent(agentId);
    a.spentUsd += usd;
    this.emit({ type: "agent", agent: { ...a } });
    if (ticketId) {
      const t = this.ticket(ticketId);
      this.updateTicket(ticketId, { costUsd: t.costUsd + usd });
    }
    if (this.state.project) {
      this.updateProject({ spentUsd: this.state.project.spentUsd + usd });
    }
  }

  // ---- log -------------------------------------------------------------

  log(level: LogEntry["level"], message: string, extra: Partial<LogEntry> = {}): void {
    const entry: LogEntry = { at: Date.now(), level, message, ...extra };
    this.state.log.push(entry);
    if (this.state.log.length > MAX_LOG) this.state.log.splice(0, this.state.log.length - MAX_LOG);
    this.emit({ type: "log", entry });
  }

  // ---- persistence -----------------------------------------------------

  private scheduleSave(): void {
    if (!this.persistPath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 200);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (!this.persistPath) return;
    mkdirSync(dirname(this.persistPath), { recursive: true });
    writeFileSync(
      this.persistPath,
      JSON.stringify({ state: this.state, counters: this.counters }, null, 2),
    );
  }
}

function emptySnapshot(): BoardSnapshot {
  return { project: null, tickets: [], areas: [], agents: [], leases: [], gates: [], log: [] };
}
