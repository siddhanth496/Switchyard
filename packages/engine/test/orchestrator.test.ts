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

    // Shared-area work goes to the shared area's engineer; the tech lead only reviews.
    const setup = tickets.find((t) => t.title.startsWith("Project manifest"))!;
    expect(setup.assignee).toBe("eng-shared-1");
    expect(tickets.some((t) => t.assignee === "tech-lead")).toBe(false);

    // Product repos ignore installs and builds from the first commit.
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("node_modules/");

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
          const trespassing = { ...t, files: [...t.files, "package.json"] };
          const res = await this.inner.run({ ...task, context: { ...task.context, ticket: trespassing, batch: [trespassing] } }, onActivity);
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
  /** A runner whose "App shell and styles" build fails while `broken` is true. */
  function flakyShell() {
    const state = { broken: true, prompts: [] as { title: string; agent: string; prompt: string; escalated?: boolean }[] };
    const inner = new MockRunner({ stepMs: 0 });
    const runner: AgentRunner = {
      name: "flaky",
      run: (task, onActivity) => {
        if (task.kind === "build") {
          state.prompts.push({ title: task.context.ticket!.title, agent: task.agentId, prompt: task.prompt, escalated: task.escalated });
          if (state.broken && task.context.ticket?.title === "App shell and styles") {
            return Promise.resolve({ ok: false, text: "", costUsd: 0, error: "tests failed" });
          }
        }
        return inner.run(task, onActivity);
      },
    };
    return { state, runner };
  }

  it("escalates the last attempt to the tech lead, then asks the CEO while other work continues", async () => {
    const { state, runner } = flakyShell();
    const orch = new Orchestrator(runner, {
      workspaceDir: workspace(),
      autoApprove: ["prd", "architecture", "release"],
      tickMs: 5,
    });
    orch.start("A notes app");

    const gate = await waitFor(() => orch.board.gates.find((g) => g.kind === "ticket_failed" && g.status === "pending"));
    const shell = orch.board.tickets.find((t) => t.title === "App shell and styles")!;
    expect(gate.ticketId).toBe(shell.id);
    expect(shell.status).toBe("failed");

    // Attempts 1-2 by the web owner, attempt 3 by the tech lead on the stronger model.
    const shellBuilds = state.prompts.filter((p) => p.title === "App shell and styles");
    expect(shellBuilds.map((p) => p.agent)).toEqual(["eng-web-1", "eng-web-1", "tech-lead"]);
    expect(shellBuilds[2]!.escalated).toBe(true);
    expect(shellBuilds[2]!.prompt).toContain("ESCALATED");

    // Independent work kept going; only the shell's dependents wait.
    await waitFor(() =>
      orch.board.tickets.filter((t) => t.title.includes("API") || t.title.startsWith("Project manifest")).every((t) => t.status === "done")
        ? true
        : undefined,
    );
    expect(orch.board.tickets.filter((t) => t.title.endsWith("page")).every((t) => t.status === "ready")).toBe(true);
    expect(orch.board.project!.phase).toBe("building");

    // Retry with guidance: it reaches the engineer, and the build ships.
    state.broken = false;
    orch.retry(shell.id, "Use plain CSS grid, no framework");
    await waitFor(() => (orch.board.project!.phase === "shipped" ? true : undefined), 20_000);
    const retried = state.prompts.filter((p) => p.title === "App shell and styles").at(-1)!;
    expect(retried.agent).toBe("eng-web-1");
    expect(retried.prompt).toContain("CEO guidance: Use plain CSS grid, no framework");
    expect(orch.board.tickets.every((t) => t.status === "done")).toBe(true);
  }, 30_000);

  it("skipping a failed ticket unblocks its dependents", async () => {
    const { state, runner } = flakyShell();
    const orch = new Orchestrator(runner, {
      workspaceDir: workspace(),
      autoApprove: ["prd", "architecture", "release"],
      tickMs: 5,
    });
    orch.start("A notes app");
    const gate = await waitFor(() => orch.board.gates.find((g) => g.kind === "ticket_failed" && g.status === "pending"));
    orch.skip(gate.ticketId!);

    await waitFor(() => (orch.board.project!.phase === "shipped" ? true : undefined), 20_000);
    const shell = orch.board.tickets.find((t) => t.id === gate.ticketId)!;
    expect(shell.status).toBe("skipped");
    const pages = orch.board.tickets.filter((t) => t.title.endsWith("page"));
    expect(pages.every((t) => t.status === "done")).toBe(true);
    const pagePrompt = state.prompts.find((p) => p.title === "Login page")!.prompt;
    expect(pagePrompt).toContain(`skipped ${shell.id}`);
    const release = orch.board.gates.find((g) => g.kind === "release")!;
    expect(release.content).toContain("Skipped by you");
  }, 30_000);

  it("unattended runs skip a broken ticket instead of retrying forever", async () => {
    const { runner } = flakyShell();
    const orch = new Orchestrator(runner, { workspaceDir: workspace(), autoApprove: "all", tickMs: 5 });
    const project = await orch.run("A notes app");
    expect(project.phase).toBe("shipped");
    expect(orch.board.tickets.find((t) => t.title === "App shell and styles")!.status).toBe("skipped");
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

describe("QA", () => {
  function counting(inner: MockRunner) {
    const calls = { qa: 0 };
    const runner: AgentRunner = {
      name: "counting",
      run: (task, onActivity) => {
        if (task.kind === "qa") calls.qa++;
        return inner.run(task, onActivity);
      },
    };
    return { calls, runner };
  }

  it("files the bugs it finds as tickets, re-tests after the fix, then releases", async () => {
    const { calls, runner } = counting(new MockRunner({ stepMs: 0, qaFindsBugOnce: true }));
    const orch = new Orchestrator(runner, { workspaceDir: workspace(), autoApprove: "all", tickMs: 5 });
    const phases: string[] = [];
    orch.board.on((e) => {
      if (e.type === "project" && e.project && phases.at(-1) !== e.project.phase) phases.push(e.project.phase);
    });

    const project = await orch.run("A notes app");
    expect(project.phase).toBe("shipped");
    expect(calls.qa).toBe(2);
    expect(phases).toEqual(expect.arrayContaining(["building", "testing", "releasing", "shipped"]));
    // building → testing → building (the bug) → testing → releasing
    expect(phases.filter((p) => p === "testing")).toHaveLength(2);

    const bug = orch.board.tickets.find((t) => t.kind === "bug")!;
    expect(bug.title).toBe("Bug: Empty notes list shows a blank page");
    expect(bug.area).toBe("web");
    expect(bug.status).toBe("done");
    expect(bug.description).toContain("Steps to reproduce");

    const release = orch.board.gates.find((g) => g.kind === "release")!;
    expect(release.content).toContain("**QA:** passed, after fixing 1 bug(s)");
    // QA worked in throwaway worktrees; nothing of theirs is left behind.
    expect(git(project.dir, "branch", "--list", "ticket/QA-*").trim()).toBe("");
  }, 30_000);

  it("stops after its last round and lists what is still broken as known issues", async () => {
    const { calls, runner } = counting(new MockRunner({ stepMs: 0, qaAlwaysFinds: "Sync loses edits" }));
    const orch = new Orchestrator(runner, { workspaceDir: workspace(), autoApprove: "all", tickMs: 5, qaRounds: 2 });
    const project = await orch.run("A notes app");
    expect(project.phase).toBe("shipped");
    expect(calls.qa).toBe(2);
    expect(orch.board.tickets.filter((t) => t.kind === "bug")).toHaveLength(1);
    const release = orch.board.gates.find((g) => g.kind === "release")!;
    expect(release.content).toContain("1 known issue(s) still open: Sync loses edits (high)");
  }, 30_000);

  it("can be turned off", async () => {
    const { calls, runner } = counting(new MockRunner({ stepMs: 0, qaFindsBugOnce: true }));
    const orch = new Orchestrator(runner, { workspaceDir: workspace(), autoApprove: "all", tickMs: 5, qaRounds: 0 });
    await orch.run("A notes app");
    expect(calls.qa).toBe(0);
    expect(orch.board.gates.find((g) => g.kind === "release")!.content).toContain("**QA:** turned off");
  }, 30_000);
});

describe("CFO budgets and scorecards", () => {
  it("budgets every ticket by size from the project budget, keeping a reserve", async () => {
    const orch = new Orchestrator(new MockRunner({ stepMs: 0 }), { workspaceDir: workspace(), autoApprove: "all", tickMs: 5, budgetUsd: 10 });
    orch.start("A notes app");
    await waitFor(() => (orch.board.tickets.length === 6 ? true : undefined));
    const byTitle = (s: string) => orch.board.tickets.find((t) => t.title.startsWith(s))!;
    const s = byTitle("Project manifest").budgetUsd!;
    const m = byTitle("App shell").budgetUsd!;
    const l = byTitle("Notes CRUD API").budgetUsd!;
    expect(m).toBeCloseTo(2 * s);
    expect(l).toBeCloseTo(4 * s);
    const total = orch.board.tickets.reduce((n, t) => n + (t.budgetUsd ?? 0), 0);
    expect(total).toBeLessThanOrEqual(10 * 0.75 + 1e-9);
    await waitFor(() => (orch.board.project!.phase === "shipped" ? true : undefined), 20_000);
  }, 30_000);

  it("cuts off an overspending attempt, penalizes it, and rewards clean deliveries", async () => {
    const orch = new Orchestrator(
      new MockRunner({ stepMs: 0, overspendFirstBuildOf: ["Notes CRUD API"] }),
      { workspaceDir: workspace(), autoApprove: "all", tickMs: 5, qaRounds: 0, maxBatch: 1 },
    );
    const project = await orch.run("A notes app");
    expect(project.phase).toBe("shipped");
    const crud = orch.board.tickets.find((t) => t.title === "Notes CRUD API")!;
    expect(crud.attempts).toBe(1);
    expect(crud.status).toBe("done");
    const log = orch.board.snapshot().log.map((l) => l.message);
    expect(log.some((m) => m.includes("cut off for overspending"))).toBe(true);
    expect(log.some((m) => /CFO \+4 to/.test(m))).toBe(true);
    const api = orch.board.agent("eng-api-1");
    expect(api.score!.overruns).toBeGreaterThanOrEqual(1);
    expect(api.score!.recent).toContain(-2);
    // The web engineer delivered everything first pass under budget.
    expect(orch.board.agent("eng-web-1").standing).toBe("trusted");
  }, 30_000);

  it("batches related tickets and splits a rejected batch back into singles", async () => {
    const orch = new Orchestrator(
      new MockRunner({ stepMs: 0, rejectFirstReviewOf: ["Notes CRUD API"] }),
      { workspaceDir: workspace(), autoApprove: "all", tickMs: 5, qaRounds: 0, floaters: 0 },
    );
    const project = await orch.run("A notes app");
    expect(project.phase).toBe("shipped");
    const log = orch.board.snapshot().log.map((l) => l.message);
    const batchLine = log.find((m) => m.includes("(batched)"));
    expect(batchLine).toBeDefined();
    expect(log.some((m) => m.includes("split back into single tickets"))).toBe(true);
    // After the split, each ticket was built and merged on its own.
    const auth = orch.board.tickets.find((t) => t.title === "Auth API")!;
    const crud = orch.board.tickets.find((t) => t.title === "Notes CRUD API")!;
    expect(auth.status).toBe("done");
    expect(crud.status).toBe("done");
    expect(crud.noBatch).toBe(true);
    expect(orch.board.tickets.every((t) => t.status === "done")).toBe(true);
  }, 30_000);

  it("traces a QA bug to the engineer who merged the files", async () => {
    const orch = new Orchestrator(new MockRunner({ stepMs: 0, qaFindsBugOnce: true }), {
      workspaceDir: workspace(), autoApprove: "all", tickMs: 5,
    });
    await orch.run("A notes app");
    const notesPage = orch.board.tickets.find((t) => t.title === "Notes list page")!;
    const builder = orch.board.agent(notesPage.assignee!);
    expect(builder.score!.bugs).toBe(1);
    expect(orch.board.snapshot().log.some((l) => l.message.includes(`traced "Empty notes list shows a blank page" to ${notesPage.id}`))).toBe(true);
  }, 30_000);
});

describe("changes after the build", () => {
  it("turns a held release into change tickets, rebuilds, re-tests and asks again", async () => {
    const orch = new Orchestrator(new MockRunner({ stepMs: 0 }), {
      workspaceDir: workspace(),
      autoApprove: ["prd", "architecture"],
      tickMs: 5,
    });
    orch.start("A notes app");
    const first = await waitFor(() => orch.board.gates.find((g) => g.kind === "release" && g.status === "pending"), 20_000);
    orch.reject(first.id, "Add a search box to the notes page");

    const second = await waitFor(
      () => orch.board.gates.find((g) => g.kind === "release" && g.status === "pending" && g.id !== first.id),
      20_000,
    );
    expect(second.title).toBe("Approve the release (round 2)");
    const change = orch.board.tickets.find((t) => t.kind === "change")!;
    expect(change.title).toBe("Change: Add a search box to the notes page");
    // Priced at the original plan's rate: same as the plan's other S ticket.
    const setupS = orch.board.tickets.find((t) => t.title.startsWith("Project manifest"))!;
    expect(change.budgetUsd).toBeCloseTo(setupS.budgetUsd!);
    expect(change.status).toBe("done");
    expect(orch.board.snapshot().log.some((l) => l.message === "QA round 1: testing the merged build")).toBe(true);
    orch.approve(second.id);
    await waitFor(() => (orch.board.project!.phase === "shipped" ? true : undefined));
  }, 30_000);

  it("continues an existing product: updates the PRD, reuses its areas, builds only the change", async () => {
    const ws = workspace();
    const first = new Orchestrator(new MockRunner({ stepMs: 0 }), { workspaceDir: ws, autoApprove: "all", tickMs: 5, qaRounds: 0 });
    const v1 = await first.run("A notes app");
    expect(v1.phase).toBe("shipped");
    expect(readFileSync(join(v1.dir, "docs/areas.json"), "utf8")).toContain('"web"');
    const commitsBefore = git(v1.dir, "rev-list", "--count", "main").trim();

    const second = new Orchestrator(new MockRunner({ stepMs: 0 }), { workspaceDir: ws, autoApprove: "all", tickMs: 5, qaRounds: 0 });
    const v2 = await second.run("Add tags to notes", undefined, { existingDir: v1.dir });
    expect(v2.phase).toBe("shipped");
    expect(v2.dir).toBe(v1.dir);
    expect(v2.name).toBe(v1.name);
    // Areas came from docs/areas.json: no architecture gate this time.
    expect(second.board.gates.some((g) => g.kind === "architecture")).toBe(false);
    expect(second.board.gates.find((g) => g.kind === "prd")!.title).toBe("Approve the updated PRD");
    expect(second.board.tickets).toHaveLength(1);
    expect(second.board.tickets[0]!.kind).toBe("change");
    expect(Number(git(v1.dir, "rev-list", "--count", "main").trim())).toBeGreaterThan(Number(commitsBefore));
    expect(readFileSync(join(v1.dir, "web/notes.html"), "utf8")).toContain("Change: Add tags to notes");
  }, 40_000);
});
