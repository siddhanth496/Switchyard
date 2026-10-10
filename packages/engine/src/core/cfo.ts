import { SIZE_UNITS, type Scorecard, type Standing, type TicketSize } from "./types.js";

/**
 * The CFO's rules, as plain functions.
 *
 * Budgets: the project budget is split across tickets by size (S=1, M=2,
 * L=4 units), keeping a reserve for reviews, QA and retries.
 *
 * Scoring: every finished or failed attempt is an event worth points. Cost
 * is never rewarded on its own: the efficiency bonus needs a first-pass
 * merge, so a cheap ticket that fails review scores worse than an
 * on-budget one that passes. Only the last few events count, so penalties
 * wear off after a few good tickets.
 */

export const POINTS = {
  /** Merged without being sent back. */
  firstPass: 2,
  /** Merged within its budget. */
  onBudget: 1,
  /** Merged first pass at 60% of budget or less. */
  efficient: 1,
  /** Merged, but over budget. */
  overBudget: -1,
  /** Sent back by review, a failed build or touching leased files. */
  sentBack: -1,
  /** Cut off for blowing through its spend cap. */
  cutOff: -2,
  /** QA traced a bug to a ticket it merged. */
  bugTraced: -2,
} as const;

/** How many recent events count toward standing. */
export const WINDOW = 5;

/** Share of the project budget held back from ticket budgets. */
export const RESERVE_SHARE = 0.25;

/** A run is cut off at the ticket budget times this, by standing. */
export const HEADROOM: Record<Standing, number> = { trusted: 2, normal: 1.5, watch: 1, benched: 1 };

/** Merges elsewhere before a benched engineer gets work again. */
export const BENCH_MERGES = 2;

export function emptyScorecard(): Scorecard {
  return { delivered: 0, firstPass: 0, onBudget: 0, reworks: 0, overruns: 0, bugs: 0, recent: [] };
}

export function standingFor(recent: readonly number[]): Standing {
  const sum = recent.reduce((a, b) => a + b, 0);
  if (sum <= -4) return "benched";
  if (sum <= -2) return "watch";
  if (sum >= 5) return "trusted";
  return "normal";
}

type Counts = Partial<Omit<Scorecard, "recent">>;

export function addEvent(card: Scorecard, points: number, counts: Counts = {}): Scorecard {
  const next: Scorecard = { ...card, recent: [...card.recent, points].slice(-WINDOW) };
  for (const [k, v] of Object.entries(counts) as [keyof Counts, number][]) next[k] = (next[k] ?? 0) + v;
  return next;
}

/** Points for a merge, from whether it passed first time and its cost ratio (spent / budget). */
export function deliveryPoints(firstPass: boolean, ratio: number): number {
  let p = firstPass ? POINTS.firstPass : 0;
  p += ratio <= 1 ? POINTS.onBudget : POINTS.overBudget;
  if (firstPass && ratio <= 0.6) p += POINTS.efficient;
  return p;
}

export function unitsOf(size?: TicketSize): number {
  return SIZE_UNITS[size ?? "M"];
}

/**
 * Plans smaller than this many units are priced as if they had this many,
 * so a one-ticket change can't claim the whole budget.
 */
export const MIN_PLAN_UNITS = 10;

/** Dollars per budget unit when `budgetUsd` is split across tickets of these sizes. */
export function unitPrice(budgetUsd: number, sizes: (TicketSize | undefined)[]): number {
  const units = sizes.reduce((n, s) => n + unitsOf(s), 0);
  return units > 0 ? (budgetUsd * (1 - RESERVE_SHARE)) / Math.max(units, MIN_PLAN_UNITS) : 0;
}
