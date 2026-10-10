import { anyOverlap, normalizePath, overlaps, pathsOverlap } from "./paths.js";
import type { Agent, Area, Lease, Standing, Ticket } from "./types.js";

/**
 * The dispatcher is plain code on purpose: instant, free and predictable.
 * Given the board, it decides which ready tickets start now and who builds
 * them. It never mutates state; the orchestrator applies the plan.
 *
 * Rules, in order, for each ready ticket (lowest priority number first):
 *  1. All dependencies are done (or skipped by the CEO).
 *  2. The ticket's area exists and has an engineer slot free.
 *  3. No live lease overlaps the files it will touch.
 *  4. Who builds it:
 *     - an escalated ticket waits for the tech lead;
 *     - otherwise an idle member of the area, picked by the CFO's standing:
 *       trusted engineers first for big or critical tickets, engineers on
 *       watch first for small ones, the lead first otherwise. Benched
 *       engineers get nothing while someone else in the area can work;
 *     - if no member is idle and the area's backlog is at the lending
 *       threshold, an idle engineer is lent: a floater first, then one whose
 *       own area has nothing ready.
 *  5. Batching: if no other engineer in the area is free to take more work,
 *     up to `maxBatch` related ready tickets (same folder, or a chain inside
 *     the area) ride along in the same session: one branch, one review, one
 *     merge. Parallel work always wins over batching.
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
  /** Most tickets one engineer builds in a single session (1 turns batching off). */
  maxBatch?: number;
  /** Most files a batch may lease, so a batch can't lock up an area. */
  maxBatchFiles?: number;
}

export interface Assignment {
  /** The primary ticket: its branch and lease carry the batch. */
  ticketId: string;
  agentId: string;
  /** Files the lease will cover (the whole batch's). */
  files: string[];
  /** True if the engineer is on loan from outside the area. */
  lent: boolean;
  /** Every ticket in this session, the primary first. Length 1 when not batched. */
  batch: string[];
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
const RANK: Record<Standing, number> = { trusted: 0, normal: 1, watch: 2, benched: 3 };

/** Files a ticket will lease. No declared files means the whole area. */
export function leaseFilesFor(ticket: Ticket, area: Area | undefined): string[] {
  const declared = ticket.files.map(normalizePath).filter((f) => f !== "");
  if (declared.length > 0) return declared;
  return area ? area.paths.map(normalizePath) : [];
}

function folderOf(path: string): string {
  const p = normalizePath(path);
  if (p.endsWith("/")) return p;
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i + 1);
}

/** Two files are related if they overlap or sit in the same (non-root) folder. */
function related(a: string, b: string): boolean {
  if (pathsOverlap(a, b)) return true;
  const fa = folderOf(a);
  return fa !== "" && fa === folderOf(b);
}

export function planDispatch(input: DispatchInput, options: DispatchOptions = {}): DispatchPlan {
  const lendThreshold = options.lendThreshold ?? 2;
  const maxAssignments = options.maxAssignments ?? Infinity;
  const maxBatch = Math.max(1, options.maxBatch ?? 3);
  const maxBatchFiles = options.maxBatchFiles ?? 12;

  const areaById = new Map(input.areas.map((a) => [a.id, a]));
  const agentById = new Map(input.agents.map((a) => [a.id, a]));
  const standing = (id: string): Standing => agentById.get(id)?.standing ?? "normal";
  const done = new Set(
    input.tickets.filter((t) => t.status === "done" || t.status === "skipped").map((t) => t.id),
  );
  const known = new Set(input.tickets.map((t) => t.id));

  const ready = input.tickets
    .filter((t) => t.status === "ready")
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

  // Ready tickets per area, used for lending decisions.
  const readyByArea = new Map<string, number>();
  for (const t of ready) readyByArea.set(t.area, (readyByArea.get(t.area) ?? 0) + 1);

  // Engineers busy in each area. Counted by engineer, not ticket: a batch of
  // three takes one slot. Leases are held through review.
  const runningSets = new Map<string, Set<string>>();
  for (const t of input.tickets) {
    if (t.status === "in_progress" || t.status === "review") {
      const set = runningSets.get(t.area) ?? new Set<string>();
      set.add(t.assignee ?? `ticket:${t.id}`);
      runningSets.set(t.area, set);
    }
  }
  const running = new Map([...runningSets].map(([k, v]) => [k, v.size]));

  const liveLeases: Lease[] = [...input.leases];
  const busy = new Set(input.agents.filter((a) => a.status !== "idle").map((a) => a.id));
  const taken = new Set<string>();
  const assignments: Assignment[] = [];
  const waiting: Waiting[] = [];

  const isFree = (id: string) => {
    const a = agentById.get(id);
    return !!a && a.status === "idle" && !busy.has(id) && BUILDER_ROLES.has(a.role);
  };

  const claim = (ticket: Ticket, agentId: string, files: string[], lent: boolean, batch: string[], area: Area) => {
    assignments.push({ ticketId: ticket.id, agentId, files, lent, batch });
    liveLeases.push({ ticketId: ticket.id, agentId, files, acquiredAt: 0 });
    busy.add(agentId);
    for (const id of batch) taken.add(id);
    running.set(area.id, (running.get(area.id) ?? 0) + 1);
    readyByArea.set(area.id, (readyByArea.get(area.id) ?? batch.length) - batch.length);
  };

  for (const ticket of ready) {
    if (taken.has(ticket.id)) continue; // already riding in a batch
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

    // 2. Area and its engineer slots
    const area = areaById.get(ticket.area);
    if (!area) {
      waiting.push({ ticketId: ticket.id, reason: `unknown area "${ticket.area}"` });
      continue;
    }
    // File leases already keep parallel tickets off each other's files, so an
    // area can run as many sessions as it has engineers.
    const limit = area.maxParallel ?? Math.max(1, area.members.length);
    if ((running.get(area.id) ?? 0) >= limit) {
      waiting.push({ ticketId: ticket.id, reason: `area ${area.id} at its limit of ${limit}` });
      continue;
    }

    // 3. File leases
    const files = leaseFilesFor(ticket, area);
    const clash = liveLeases.find((l) => anyOverlap(l.files, files));
    if (clash) {
      const pair = overlaps(clash.files, files)[0];
      waiting.push({ ticketId: ticket.id, reason: `files leased by ${clash.ticketId}${pair ? ` (${pair[1]})` : ""}` });
      continue;
    }

    // 4. Who builds it
    if (ticket.escalated) {
      const lead = input.agents.find((a) => a.role === "tech_lead" && isFree(a.id));
      if (!lead) {
        waiting.push({ ticketId: ticket.id, reason: "escalated, waiting for the tech lead" });
        continue;
      }
      claim(ticket, lead.id, files, lead.area !== area.id, [ticket.id], area);
      continue;
    }

    const leadFirst = [area.lead, ...area.members.filter((m) => m !== area.lead)];
    const allBenched = area.members.every((m) => standing(m) === "benched");
    const eligible = leadFirst.filter((m) => allBenched || standing(m) !== "benched");
    const big = ticket.size === "L" || ticket.priority === 0;
    const small = ticket.size === "S";
    const byStanding = (dir: 1 | -1) =>
      [...eligible].sort((a, b) => dir * (RANK[standing(a)] - RANK[standing(b)]) || leadFirst.indexOf(a) - leadFirst.indexOf(b));
    const ordered = big ? byStanding(1) : small ? byStanding(-1) : eligible;

    // An idle engineer that could be lent to this area: a floater first, then
    // one whose own area has nothing ready.
    const lendable = (except?: string) => {
      const canLend = (a: Agent) =>
        a.id !== except && a.role === "engineer" && standing(a.id) !== "benched" && isFree(a.id);
      return (
        input.agents.find((a) => canLend(a) && !a.area) ??
        input.agents.find((a) => canLend(a) && !!a.area && a.area !== area.id && (readyByArea.get(a.area) ?? 0) === 0)
      );
    };

    let agentId = ordered.find(isFree);
    let lent = false;
    if (!agentId && (readyByArea.get(area.id) ?? 0) >= lendThreshold) {
      const pick = lendable();
      if (pick) {
        agentId = pick.id;
        lent = true;
      }
    }
    if (!agentId) {
      waiting.push({ ticketId: ticket.id, reason: `no idle engineer in ${area.id}` });
      continue;
    }

    // 5. Batching: only when nobody else in the area could take the extra work.
    const batch = [ticket.id];
    const batchFiles = [...files];
    // Someone else could take the rest: a free area member, or an engineer the
    // lending rule would bring in for the backlog left after this ticket.
    const backlogAfter = (readyByArea.get(area.id) ?? 1) - 1;
    const othersFree =
      eligible.some((m) => m !== agentId && isFree(m)) || (backlogAfter >= lendThreshold && !!lendable(agentId));
    if (!lent && !ticket.noBatch && maxBatch > 1 && !othersFree) {
      for (const cand of ready) {
        if (batch.length >= maxBatch) break;
        if (cand.id === ticket.id || taken.has(cand.id) || cand.area !== area.id) continue;
        if (cand.escalated || cand.noBatch) continue;
        if (cand.dependsOn.some((d) => !done.has(d) && !batch.includes(d))) continue;
        const candFiles = leaseFilesFor(cand, area);
        if (batchFiles.length + candFiles.length > maxBatchFiles) continue;
        if (liveLeases.some((l) => anyOverlap(l.files, candFiles))) continue;
        const chained = cand.dependsOn.some((d) => batch.includes(d));
        const nearby = candFiles.some((f) => batchFiles.some((g) => related(f, g)));
        if (!chained && !nearby) continue;
        batch.push(cand.id);
        batchFiles.push(...candFiles.filter((f) => !batchFiles.includes(f)));
      }
    }

    claim(ticket, agentId, batchFiles, lent, batch, area);
  }

  // A ticket first parked as waiting may have joined a batch later on.
  return { assignments, waiting: waiting.filter((w) => !taken.has(w.ticketId)) };
}
