import { describe, expect, it } from "vitest";
import { planDispatch } from "../src/core/dispatcher.js";
import { covers, normalizePath, owningArea, pathsOverlap, resolveArea } from "../src/core/paths.js";
import type { Agent, Area, Lease, Ticket } from "../src/core/types.js";

const areas: Area[] = [
  { id: "web", name: "Web", paths: ["web/"], lead: "e1", members: ["e1", "e2"] },
  { id: "api", name: "API", paths: ["api/"], lead: "e3", members: ["e3"] },
  { id: "billing", name: "Billing", paths: ["api/billing/"], lead: "e3", members: ["e3"] },
  { id: "shared", name: "Shared", paths: ["package.json", "db/schema.sql"], lead: "tl", members: ["tl"], shared: true },
];

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return { id, name: id, role: "engineer", status: "idle", spentUsd: 0, ...patch };
}

let clock = 0;
function ticket(id: string, patch: Partial<Ticket> = {}): Ticket {
  return {
    id,
    title: id,
    description: "",
    acceptance: [],
    area: "web",
    files: [],
    dependsOn: [],
    status: "ready",
    priority: 1,
    attempts: 0,
    costUsd: 0,
    createdAt: ++clock,
    updatedAt: clock,
    ...patch,
  };
}

describe("paths", () => {
  it("normalizes globs and leading ./", () => {
    expect(normalizePath("./src/auth/**")).toBe("src/auth/");
    expect(normalizePath("src\\a.ts")).toBe("src/a.ts");
  });

  it("treats a trailing slash as a directory prefix", () => {
    expect(covers("web/", "web/app/page.tsx")).toBe(true);
    expect(covers("web", "web/app/page.tsx")).toBe(false);
    expect(pathsOverlap("web/app/", "web/")).toBe(true);
    expect(pathsOverlap("web/a.ts", "web/b.ts")).toBe(false);
  });

  it("picks the most specific owning area", () => {
    expect(owningArea("api/billing/invoice.ts", areas)?.id).toBe("billing");
    expect(owningArea("api/users.ts", areas)?.id).toBe("api");
    expect(owningArea("README.md", areas)).toBeUndefined();
  });

  it("flags tickets that span two areas", () => {
    expect(resolveArea(["web/a.ts", "web/b.ts"], areas)).toEqual({ kind: "single", area: "web" });
    expect(resolveArea(["web/a.ts", "package.json"], areas)).toEqual({ kind: "single", area: "web" });
    expect(resolveArea(["web/a.ts", "api/users.ts"], areas).kind).toBe("split");
    expect(resolveArea(["nowhere.txt"], areas).kind).toBe("unowned");
  });
});

describe("dispatcher", () => {
  const agents = [agent("e1", { area: "web" }), agent("e2", { area: "web" }), agent("e3", { area: "api" }), agent("tl", { role: "tech_lead", area: "shared" })];

  it("assigns to the area lead first, then other members", () => {
    const plan = planDispatch({
      tickets: [ticket("A", { files: ["web/a.ts"] }), ticket("B", { files: ["web/b.ts"] })],
      areas,
      agents,
      leases: [],
    });
    expect(plan.assignments.map((a) => [a.ticketId, a.agentId])).toEqual([
      ["A", "e1"],
      ["B", "e2"],
    ]);
  });

  it("never runs two tickets with overlapping files in parallel", () => {
    const plan = planDispatch({
      tickets: [ticket("A", { files: ["web/app/"] }), ticket("B", { files: ["web/app/page.tsx"] })],
      areas,
      agents,
      leases: [],
    });
    expect(plan.assignments.map((a) => a.ticketId)).toEqual(["A"]);
    expect(plan.waiting[0]?.reason).toMatch(/leased by A/);
  });

  it("respects existing leases", () => {
    const leases: Lease[] = [{ ticketId: "X", agentId: "e3", files: ["package.json"], acquiredAt: 0 }];
    const plan = planDispatch({
      tickets: [ticket("A", { area: "shared", files: ["package.json"] })],
      areas,
      agents,
      leases,
    });
    expect(plan.assignments).toHaveLength(0);
  });

  it("waits for dependencies", () => {
    const plan = planDispatch({
      tickets: [ticket("A", { files: ["web/a.ts"], status: "in_progress" }), ticket("B", { files: ["web/b.ts"], dependsOn: ["A"] })],
      areas,
      agents: [agent("e1", { area: "web", status: "working" }), agent("e2", { area: "web" })],
      leases: [{ ticketId: "A", agentId: "e1", files: ["web/a.ts"], acquiredAt: 0 }],
    });
    expect(plan.assignments).toHaveLength(0);
    expect(plan.waiting[0]?.reason).toBe("waiting on A");
  });

  it("limits a shared area to the engineers it has", () => {
    const plan = planDispatch({
      tickets: [
        ticket("A", { area: "shared", files: ["package.json"], status: "in_progress" }),
        ticket("B", { area: "shared", files: ["db/schema.sql"] }),
      ],
      areas,
      agents: [agent("tl", { role: "tech_lead", area: "shared" })],
      leases: [{ ticketId: "A", agentId: "tl", files: ["package.json"], acquiredAt: 0 }],
    });
    expect(plan.waiting[0]?.reason).toMatch(/at its limit of 1/);
  });

  it("runs shared tickets in parallel when their files don't overlap", () => {
    const sharedAreas = areas.map((a) => (a.id === "shared" ? { ...a, lead: "s1", members: ["s1", "s2"] } : a));
    const plan = planDispatch({
      tickets: [
        ticket("A", { area: "shared", files: ["package.json"] }),
        ticket("B", { area: "shared", files: ["db/schema.sql"] }),
      ],
      areas: sharedAreas,
      agents: [agent("s1", { area: "shared" }), agent("s2", { area: "shared" })],
      leases: [],
    });
    expect(plan.assignments.map((a) => [a.ticketId, a.agentId])).toEqual([
      ["A", "s1"],
      ["B", "s2"],
    ]);
  });

  it("lends an idle engineer when an area's backlog builds up", () => {
    const plan = planDispatch(
      {
        tickets: [
          ticket("A", { area: "api", files: ["api/a.ts"] }),
          ticket("B", { area: "api", files: ["api/b.ts"] }),
          ticket("C", { area: "api", files: ["api/c.ts"] }),
        ],
        areas: areas.map((a) => (a.id === "api" ? { ...a, maxParallel: 3 } : a)),
        agents: [...agents, agent("f1")],
        leases: [],
      },
      { lendThreshold: 2 },
    );
    const byTicket = Object.fromEntries(plan.assignments.map((a) => [a.ticketId, a]));
    expect(byTicket.A?.agentId).toBe("e3");
    expect(byTicket.B).toMatchObject({ agentId: "f1", lent: true });
    // After two start, the backlog (1) is below the threshold: C waits.
    expect(byTicket.C).toBeUndefined();
  });

  it("lends an engineer whose own area has nothing ready", () => {
    const plan = planDispatch(
      {
        tickets: [
          ticket("A", { area: "api", files: ["api/a.ts"] }),
          ticket("B", { area: "api", files: ["api/b.ts"] }),
          ticket("C", { area: "api", files: ["api/c.ts"] }),
        ],
        areas: areas.map((a) => (a.id === "api" ? { ...a, maxParallel: 3 } : a)),
        agents,
        leases: [],
      },
      { lendThreshold: 2 },
    );
    expect(plan.assignments.map((a) => [a.ticketId, a.agentId, a.lent])).toEqual([
      ["A", "e3", false],
      ["B", "e1", true],
    ]);
  });

  it("sends an escalated ticket to the tech lead only", () => {
    const plan = planDispatch({
      tickets: [ticket("A", { files: ["web/a.ts"], escalated: true })],
      areas,
      agents,
      leases: [],
    });
    expect(plan.assignments.map((a) => a.agentId)).toEqual(["tl"]);
    const busy = planDispatch({
      tickets: [ticket("A", { files: ["web/a.ts"], escalated: true })],
      areas,
      agents: agents.map((a) => (a.id === "tl" ? { ...a, status: "working" as const } : a)),
      leases: [],
    });
    expect(busy.assignments).toHaveLength(0);
    expect(busy.waiting[0]?.reason).toMatch(/tech lead/);
  });

  it("treats a skipped dependency as resolved", () => {
    const plan = planDispatch({
      tickets: [ticket("A", { files: ["web/a.ts"], status: "skipped" }), ticket("B", { files: ["web/b.ts"], dependsOn: ["A"] })],
      areas,
      agents,
      leases: [],
    });
    expect(plan.assignments.map((a) => a.ticketId)).toEqual(["B"]);
  });

  it("does not lend below the threshold", () => {
    const plan = planDispatch(
      {
        tickets: [ticket("A", { area: "api", files: ["api/a.ts"] })],
        areas,
        agents: [agent("e3", { area: "api", status: "working" }), agent("f1")],
        leases: [],
      },
      { lendThreshold: 2 },
    );
    expect(plan.assignments).toHaveLength(0);
  });
});
