import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { BoardSnapshot, Ticket } from "../core/types.js";

/**
 * Each product's last board, saved next to its repo (`<repo>.board.json`,
 * like `<repo>.worktrees/`), so continuing a product shows where it left
 * off and picks up its unfinished tickets. Outside the repo, so it's never
 * committed.
 */
export interface ProductHistory {
  savedAt: number;
  snapshot: BoardSnapshot;
}

export function historyPath(dir: string): string {
  return `${dir}.board.json`;
}

export function readHistory(dir: string): ProductHistory | undefined {
  const path = historyPath(dir);
  if (!existsSync(path)) return undefined;
  try {
    const h = JSON.parse(readFileSync(path, "utf8")) as ProductHistory;
    return h?.snapshot?.tickets ? h : undefined;
  } catch {
    return undefined;
  }
}

/** Save the board, minus what's big and only useful live (screenshots, old log lines). */
export function writeHistory(dir: string, snapshot: BoardSnapshot): void {
  const slim: BoardSnapshot = {
    ...snapshot,
    gates: snapshot.gates.map(({ images: _images, ...g }) => g),
    log: snapshot.log.slice(-200),
    leases: [],
  };
  const path = historyPath(dir);
  // Write then rename, so a crash mid-write never leaves half a file.
  writeFileSync(`${path}.tmp`, JSON.stringify({ savedAt: Date.now(), snapshot: slim } satisfies ProductHistory));
  renameSync(`${path}.tmp`, path);
}

/** Tickets a later run still has to do. */
export function unfinished(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((t) => !["done", "skipped"].includes(t.status));
}

/** The highest ticket number used, so a later run keeps counting from there. */
export function lastTicketNumber(tickets: readonly Ticket[]): number {
  return tickets.reduce((n, t) => Math.max(n, Number(t.id.replace(/^T-/, "")) || 0), 0);
}

/** What the start screen shows about a product's last run. */
export function summarizeHistory(h: ProductHistory) {
  const { project, tickets } = h.snapshot;
  const open = unfinished(tickets);
  const lastRelease = [...h.snapshot.gates].reverse().find((g) => g.kind === "release");
  return {
    savedAt: h.savedAt,
    idea: project?.idea ?? "",
    phase: project?.phase ?? "idle",
    brand: project?.brand ? { name: project.brand.name, tagline: project.brand.tagline, logoSvg: project.brand.logoSvg } : undefined,
    spentUsd: project?.spentUsd ?? 0,
    counts: {
      merged: tickets.filter((t) => t.status === "done").length,
      skipped: tickets.filter((t) => t.status === "skipped").length,
      open: open.length,
    },
    open: open.map((t) => ({ id: t.id, title: t.title, status: t.status, kind: t.kind })),
    recent: tickets
      .filter((t) => t.status === "done")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8)
      .map((t) => ({ id: t.id, title: t.title, kind: t.kind })),
    lastRelease: lastRelease ? { title: lastRelease.title, status: lastRelease.status, feedback: lastRelease.feedback } : undefined,
  };
}
export type HistorySummary = ReturnType<typeof summarizeHistory>;
