import { anyOverlap, normalizePath, overlaps } from "./paths.js";
import type { Agent, Area, Lease, Ticket } from "./types.js";

/**
 * The dispatcher is plain code on purpose: instant, free and predictable.
 * Given the board, it decides which ready tickets start now and who builds
 * them. It never mutates state; the orchestrator applies the plan.
 *
 * Rules, in order, for each ready ticket (lowest priority number first):
 *  1. All dependencies are done.
 *  2. The ticket's area exists and is under its parallel limit.
 *  3. No live lease overlaps the files it will touch.
 *  4. An idle member of the area takes it (the lead first). If none is idle
 *     and the area's backlog is at the lending threshold, an idle engineer
 *     is lent: a floater first, then one whose own area has nothing ready.
 */

export interface DispatchInput {
  tickets: readonly Ticket[];
  areas: readonly Area[];
  agents: readonly Agent[];
  leases: readonly Lease[];
}

export interface DispatchOptions {
  /** Ready tickets in one area before idle engineers are lent to it. */
  lendThreshold?: number;
  /** Cap on assignments per tick. */
  maxAssignments?: number;
}

export interface Assignment {
  ticketId: string;
  agentId: string;
  /** Files the lease will cover. */
  files: string[];
  /** True if the engineer is on loan from outside the area. */
  lent: boolean;
}

export interface Waiting {
  ticketId: string;
  reason: string;
}

export interface DispatchPlan {
  assignments: Assignment[];
  waiting: Waiting[];
}

const BUILDER_ROLES = new Set(["engineer", "tech_lead"]);

/** Files a ticket will lease. No declared files means the whole area. */
export function leaseFilesFor(ticket: Ticket, area: Area | undefined): string[] {
  const declared = ticket.files.map(normalizePath).filter((f) => f !== "");
  if (declared.length > 0) return declared;
  return area ? area.paths.map(normalizePath) : [];
}

export function planDispatch(input: DispatchInput, options: DispatchOptions = {}): DispatchPlan {
  const lendThreshold = options.lendThreshold ?? 2;
  const maxAssignments = options.maxAssignments ?? Infinity;

  const areaById = new Map(input.areas.map((a) => [a.id, a]));
  const agentById = new Map(input.agents.map((a) => [a.id, a]));
  const done = new Set(input.tickets.filter((t) => t.status === "done").map((t) => t.id));
  const known = new Set(input.tickets.map((t) => t.id));

  const ready = input.tickets
    .filter((t) => t.status === "ready")
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

  // Ready tickets per area, used for lending decisions.
  const readyByArea = new Map<string, number>();
  for (const t of ready) readyByArea.set(t.area, (readyByArea.get(t.area) ?? 0) + 1);

  // Tickets holding a slot in their area (leases are held through review).
  const running = new Map<string, number>();
  for (const t of input.tickets) {
    if (t.status === "in_progress" || t.status === "review") {
      running.set(t.area, (running.get(t.area) ?? 0) + 1);
    }
  }

  const liveLeases: Lease[] = [...input.leases];
  const busy = new Set(input.agents.filter((a) => a.status !== "idle").map((a) => a.id));
  const assignments: Assignment[] = [];
  const waiting: Waiting[] = [];

  const isFree = (id: string) => {
    const a = agentById.get(id);
    return !!a && a.status === "idle" && !busy.has(id) && BUILDER_ROLES.has(a.role);
  };

  for (const ticket of ready) {
    if (assignments.length >= maxAssignments) {
      waiting.push({ ticketId: ticket.id, reason: "dispatch cap reached this tick" });
      continue;
    }

    // 1. Dependencies
    const missing = ticket.dependsOn.filter((d) => !known.has(d));
    if (missing.length > 0) {
      waiting.push({ ticketId: ticket.id, reason: `unknown dependency ${missing.join(", ")}` });
      continue;
    }
    const pending = ticket.dependsOn.filter((d) => !done.has(d));
    if (pending.length > 0) {
      waiting.push({ ticketId: ticket.id, reason: `waiting on ${pending.join(", ")}` });
      continue;
    }

    // 2. Area and its parallel limit
    const area = areaById.get(ticket.area);
    if (!area) {
      waiting.push({ ticketId: ticket.id, reason: `unknown area "${ticket.area}"` });
      continue;
    }
    const limit = area.maxParallel ?? (area.shared ? 1 : Math.max(1, area.members.length));
    if ((running.get(area.id) ?? 0) >= limit) {
      waiting.push({ ticketId: ticket.id, reason: `area ${area.id} at its limit of ${limit}` });
      continue;
    }

    // 3. File leases
    const files = leaseFilesFor(ticket, area);
    const clash = liveLeases.find((l) => anyOverlap(l.files, files));
    if (clash) {
      const pair = overlaps(clash.files, files)[0];
      waiting.push({
        ticketId: ticket.id,
        reason: `files leased by ${clash.ticketId}${pair ? ` (${pair[1]})` : ""}`,
      });
      continue;
    }

    // 4. Who builds it
    const ordered = [area.lead, ...area.members.filter((m) => m !== area.lead)];
    let agentId = ordered.find(isFree);
    let lent = false;

    if (!agentId && (readyByArea.get(area.id) ?? 0) >= lendThreshold) {
      const floater = input.agents.find(
        (a) => a.role === "engineer" && !a.area && isFree(a.id),
      );
      const spare = input.agents.find(
        (a) =>
          a.role === "engineer" &&
          !!a.area &&
          a.area !== area.id &&
          (readyByArea.get(a.area) ?? 0) === 0 &&
          isFree(a.id),
      );
      const pick = floater ?? spare;
      if (pick) {
        agentId = pick.id;
        lent = true;
      }
    }

    if (!agentId) {
      waiting.push({ ticketId: ticket.id, reason: `no idle engineer in ${area.id}` });
      continue;
    }

    assignments.push({ ticketId: ticket.id, agentId, files, lent });
    liveLeases.push({ ticketId: ticket.id, agentId, files, acquiredAt: 0 });
    busy.add(agentId);
    running.set(area.id, (running.get(area.id) ?? 0) + 1);
    readyByArea.set(area.id, (readyByArea.get(area.id) ?? 1) - 1);
  }

  return { assignments, waiting };
}
