import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockRunner } from "../src/agents/mock.js";
import type { AgentResult, AgentRunner, AgentTask } from "../src/agents/runner.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";

function workspace() {
  return mkdtempSync(join(tmpdir(), "agentco-"));
}

function git(dir: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

describe("orchestrator (mock agents, real git)", () => {
  it("builds and ships the whole plan with parallel engineers", async () => {
    const orch = new Orchestrator(new MockRunner({ stepMs: 0, rejectFirstReviewOf: ["Notes CRUD API"] }), {
      workspaceDir: workspace(),
      autoApprove: "all",
      engineersPerArea: 2,
      tickMs: 10,
    });

    let maxParallel = 0;
    orch.board.on(() => {
      const n = orch.board.tickets.filter((t) => t.status === "in_progress" || t.status === "review").length;
      maxParallel = Math.max(maxParallel, n);
    });

    const project = await orch.run("A minimal notes app with login");

    expect(project.phase).toBe("shipped");
    const tickets = orch.board.tickets;
    expect(tickets).toHaveLength(6);
    expect(tickets.every((t) => t.status === "done")).toBe(true);
    expect(maxParallel).toBeGreaterThan(1);
    expect(orch.board.leases).toHaveLength(0);

    // The rejected ticket went round twice.
    const crud = tickets.find((t) => t.title === "Notes CRUD API")!;
    expect(crud.attempts).toBe(1);

    // Every ticket's work is on main, and owner notes were recorded.
    const dir = project.dir;
    expect(git(dir, "branch", "--show-current").trim()).toBe("main");
    expect(readFileSync(join(dir, "web/notes.html"), "utf8")).toContain("Notes list page");
    expect(readFileSync(join(dir, "docs/owners/api.md"), "utf8")).toContain("Notes CRUD API");
    expect(git(dir, "status", "--porcelain").trim()).toBe("");

    // Dependencies were respected: setup merged before the API tickets.
    const merges = git(dir, "log", "--reverse", "--format=%s", "--merges");
    const order = merges.split("\n").filter(Boolean);
    const setupId = tickets.find((t) => t.title.startsWith("Project manifest"))!.id;
    const authId = tickets.find((t) => t.title === "Auth API")!.id;
    expect(order.findIndex((m) => m.includes(setupId))).toBeLessThan(order.findIndex((m) => m.includes(authId)));
  }, 30_000);

  it("waits at the PRD gate and redoes the PRD on rejection", async () => {
    const orch = new Orchestrator(new MockRunner({ stepMs: 0 }), {
      workspaceDir: workspace(),
      autoApprove: ["architecture", "release"],
      tickMs: 10,
    });
    orch.start("A notes app");
    const gate = await waitFor(() => orch.board.gates.find((g) => g.kind === "prd" && g.status === "pending"));
    expect(orch.board.project!.phase).toBe("planning");

    orch.reject(gate.id, "Add password reset");
    const second = await waitFor(() =>
      orch.board.gates.find((g) => g.kind === "prd" && g.status === "pending" && g.id !== gate.id),
    );
    expect(second.content).toContain("Add password reset");
    orch.approve(second.id);

    await waitFor(() => (orch.board.project!.phase === "shipped" ? true : undefined), 20_000);
  }, 30_000);

  it("pauses dispatch at the budget and resumes when approved", async () => {
    const orch = new Orchestrator(new MockRunner({ stepMs: 0 }), {
      workspaceDir: workspace(),
      autoApprove: ["prd", "architecture", "release"],
      budgetUsd: 0.06,
      tickMs: 10,
    });
    orch.start("A notes app");
    const spend = await waitFor(() => orch.board.gates.find((g) => g.kind === "spend" && g.status === "pending"));
    expect(orch.board.project!.phase).toBe("paused");
    orch.approve(spend.id);
    // Each approval adds another 0.06; keep approving until it ships.
    await waitFor(() => {
      const g = orch.board.gates.find((x) => x.kind === "spend" && x.status === "pending");
      if (g) orch.approve(g.id);
      return orch.board.project!.phase === "shipped" ? true : undefined;
    }, 20_000);
    expect(orch.board.gates.filter((g) => g.kind === "spend").length).toBeGreaterThan(1);
  }, 30_000);

  it("sends back a ticket that touches files another ticket holds", async () => {
    // An engineer that also edits the shared manifest while setup holds it.
    class Trespasser implements AgentRunner {
      readonly name = "trespasser";
      private inner = new MockRunner({ stepMs: 5 });
      async run(task: AgentTask, onActivity: (l: string) => void): Promise<AgentResult> {
        const t = task.context.ticket;
        // Keep setup busy (and its lease on package.json live) for a while.
        if (task.kind === "build" && t?.title.startsWith("Project manifest")) {
          await new Promise((r) => setTimeout(r, 400));
        }
        if (task.kind === "build" && t?.title === "App shell and styles" && t.attempts === 0) {
          const res = await this.inner.run({ ...task, context: { ...task.context, ticket: { ...t, files: [...t.files, "package.json"] } } }, onActivity);
          return res;
        }
        return this.inner.run(task, onActivity);
      }
    }
    const orch = new Orchestrator(new Trespasser(), { workspaceDir: workspace(), autoApprove: "all", tickMs: 5 });
    const project = await orch.run("A notes app");
    expect(project.phase).toBe("shipped");
    const shell = orch.board.tickets.find((t) => t.title === "App shell and styles")!;
    expect(shell.attempts).toBeGreaterThanOrEqual(1);
    expect(orch.board.snapshot().log.some((l) => l.message.includes("leased by"))).toBe(true);
  }, 30_000);
});

describe("failures", () => {
  it("stops when a failed ticket blocks others, and resumes after a retry", async () => {
    let broken = true;
    const inner = new MockRunner({ stepMs: 0 });
    const runner: AgentRunner = {
      name: "flaky",
      run: (task, onActivity) =>
        broken && task.kind === "build" && task.context.ticket?.title === "App shell and styles"
          ? Promise.resolve({ ok: false, text: "", costUsd: 0, error: "tests failed" })
          : inner.run(task, onActivity),
    };
    const orch = new Orchestrator(runner, { workspaceDir: workspace(), autoApprove: "all", tickMs: 5, maxAttempts: 2 });

    const first = await orch.run("A notes app");
    expect(first.phase).toBe("failed");
    const shell = orch.board.tickets.find((t) => t.title === "App shell and styles")!;
    expect(shell.status).toBe("failed");
    expect(shell.attempts).toBe(2);
    // The pages that depend on the shell never started.
    expect(orch.board.tickets.filter((t) => t.title.endsWith("page")).every((t) => t.status === "ready")).toBe(true);

    broken = false;
    orch.retry(shell.id);
    await waitFor(() => (orch.board.project!.phase === "shipped" ? true : undefined), 20_000);
    expect(orch.board.tickets.every((t) => t.status === "done")).toBe(true);
  }, 30_000);
});

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
