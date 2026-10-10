import { describe, expect, it } from "vitest";
import { addEvent, deliveryPoints, emptyScorecard, standingFor, unitPrice, WINDOW } from "../src/core/cfo.js";
import { planDispatch } from "../src/core/dispatcher.js";
import type { Agent, Area, Ticket } from "../src/core/types.js";

describe("CFO scoring", () => {
  it("never rewards cost alone: a cheap ticket sent back scores below an on-budget first pass", () => {
    expect(deliveryPoints(true, 0.4)).toBe(4); // first pass, efficient
    expect(deliveryPoints(true, 0.9)).toBe(3); // first pass, on budget
    expect(deliveryPoints(false, 0.1)).toBe(1); // cheap but needed rework: no efficiency bonus
    expect(deliveryPoints(true, 1.5)).toBe(1); // first pass but over budget
    expect(deliveryPoints(false, 1.5)).toBe(-1);
  });

  it("maps recent points to a standing", () => {
    expect(standingFor([4, 3])).toBe("trusted");
    expect(standingFor([1])).toBe("normal");
    expect(standingFor([-1, -1])).toBe("watch");
    expect(standingFor([-2, -2])).toBe("benched");
  });

  it("lets penalties wear off after a few good tickets", () => {
    let card = addEvent(emptyScorecard(), -2, { overruns: 1 });
    card = addEvent(card, -2, { reworks: 1 });
    expect(standingFor(card.recent)).toBe("benched");
    for (let i = 0; i < WINDOW; i++) card = addEvent(card, 3, { delivered: 1 });
    expect(card.recent).toHaveLength(WINDOW);
    expect(standingFor(card.recent)).toBe("trusted");
    expect(card.overruns).toBe(1); // history is kept, only standing recovers
  });

  it("splits the budget by size and keeps a 25% reserve", () => {
    const unit = unitPrice(10, ["S", "M", "L"]); // 7 units share $7.50
    expect(unit).toBeCloseTo(7.5 / 7);
  });
});

const area: Area = { id: "web", name: "Web", paths: ["web/"], lead: "e1", members: ["e1", "e2"] };
function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return { id, name: id, role: "engineer", status: "idle", spentUsd: 0, area: "web", ...patch };
}
let clock = 0;
function ticket(id: string, patch: Partial<Ticket> = {}): Ticket {
  return {
    id, title: id, description: "", acceptance: [], area: "web", files: [], dependsOn: [], status: "ready",
    priority: 1, attempts: 0, costUsd: 0, createdAt: ++clock, updatedAt: clock, ...patch,
  };
}
const solo: Area = { ...area, members: ["e1"] };

describe("batching", () => {
  it("clubs related tickets in one session when nobody else is free", () => {
    const plan = planDispatch({
      tickets: [ticket("A", { files: ["web/a.ts"] }), ticket("B", { files: ["web/b.ts"] })],
      areas: [solo], agents: [agent("e1")], leases: [],
    });
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0]).toMatchObject({ agentId: "e1", batch: ["A", "B"] });
    expect(plan.assignments[0]!.files).toEqual(["web/a.ts", "web/b.ts"]);
  });

  it("clubs a chain inside the area", () => {
    const plan = planDispatch({
      tickets: [ticket("A", { files: ["web/x/a.ts"] }), ticket("B", { files: ["web/y/b.ts"], dependsOn: ["A"] })],
      areas: [solo], agents: [agent("e1")], leases: [],
    });
    expect(plan.assignments[0]!.batch).toEqual(["A", "B"]);
    expect(plan.waiting).toHaveLength(0);
  });

  it("prefers parallel work: no batch while another engineer is free", () => {
    const plan = planDispatch({
      tickets: [ticket("A", { files: ["web/a.ts"] }), ticket("B", { files: ["web/b.ts"] })],
      areas: [area], agents: [agent("e1"), agent("e2")], leases: [],
    });
    expect(plan.assignments.map((a) => a.batch)).toEqual([["A"], ["B"]]);
  });

  it("leaves unrelated tickets, rejected batches and the cap alone", () => {
    const unrelated = planDispatch({
      tickets: [ticket("A", { files: ["web/x/a.ts"] }), ticket("B", { files: ["web/y/b.ts"] })],
      areas: [solo], agents: [agent("e1")], leases: [],
    });
    expect(unrelated.assignments[0]!.batch).toEqual(["A"]);

    const noBatch = planDispatch({
      tickets: [ticket("A", { files: ["web/a.ts"] }), ticket("B", { files: ["web/b.ts"], noBatch: true })],
      areas: [solo], agents: [agent("e1")], leases: [],
    });
    expect(noBatch.assignments[0]!.batch).toEqual(["A"]);

    const many = planDispatch({
      tickets: ["A", "B", "C", "D"].map((id) => ticket(id, { files: [`web/${id}.ts`] })),
      areas: [solo], agents: [agent("e1")], leases: [],
    });
    expect(many.assignments[0]!.batch).toHaveLength(3);
  });
});

describe("standing decides who gets what", () => {
  it("gives big tickets to trusted engineers and small ones to engineers on watch", () => {
    const agents = [agent("e1", { standing: "watch" }), agent("e2", { standing: "trusted" })];
    const big = planDispatch({ tickets: [ticket("A", { files: ["web/a.ts"], size: "L" })], areas: [area], agents, leases: [] });
    expect(big.assignments[0]!.agentId).toBe("e2");
    const small = planDispatch({
      tickets: [ticket("A", { files: ["web/a.ts"], size: "S" })],
      areas: [area], agents: [agent("e1", { standing: "trusted" }), agent("e2", { standing: "watch" })], leases: [],
    });
    expect(small.assignments[0]!.agentId).toBe("e2");
  });

  it("benches an engineer while someone else can work, but never strands an area", () => {
    const benched = planDispatch({
      tickets: [ticket("A", { files: ["web/a.ts"] })],
      areas: [area], agents: [agent("e1", { standing: "benched" }), agent("e2", { status: "working" })], leases: [],
    });
    expect(benched.assignments).toHaveLength(0);
    const allBenched = planDispatch({
      tickets: [ticket("A", { files: ["web/a.ts"] })],
      areas: [solo], agents: [agent("e1", { standing: "benched" })], leases: [],
    });
    expect(allBenched.assignments[0]!.agentId).toBe("e1");
  });
});
