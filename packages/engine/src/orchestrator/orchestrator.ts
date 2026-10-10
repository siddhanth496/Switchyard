import { join, resolve } from "node:path";
import { Board } from "../core/board.js";
import { planDispatch, type Assignment } from "../core/dispatcher.js";
import { anyOverlap, overlaps, resolveArea } from "../core/paths.js";
import type { Agent, Area, Gate, GateKind, Project, Ticket } from "../core/types.js";
import {
  architecturePrompt,
  buildPrompt,
  prdPrompt,
  reviewPrompt,
  systemPrompts,
  ticketsPrompt,
} from "../agents/prompts.js";
import type { AgentResult, AgentRunner, AgentTask } from "../agents/runner.js";
import {
  ArchitectureSchema,
  BuildReportSchema,
  ReviewSchema,
  TicketPlanSchema,
  parseWith,
  type Architecture,
} from "../agents/schemas.js";
import { ProjectRepo } from "../git/repo.js";

export interface OrchestratorConfig {
  /** Folder where product repos are created. */
  workspaceDir: string;
  /** Engineers per (non-shared) area. The first is the area lead. */
  engineersPerArea?: number;
  /** Engineers with no home area, lent wherever the backlog builds up. */
  floaters?: number;
  /** Spend that pauses dispatching until the CEO approves more. */
  budgetUsd?: number;
  /** Attempts per ticket before it is marked failed. */
  maxAttempts?: number;
  /** Ready tickets in an area before idle engineers are lent to it. */
  lendThreshold?: number;
  /** Gates to approve automatically (demo and tests). */
  autoApprove?: GateKind[] | "all";
  /** How often the dispatcher re-checks the board, in ms. */
  tickMs?: number;
}

const IDS = { pm: "pm", taskCreator: "task-creator", techLead: "tech-lead", cfo: "cfo" } as const;

/**
 * Runs the company: PRD → architecture → tickets → parallel build → release,
 * with CEO gates between phases. All state lives on the board; this class
 * only drives it.
 */
export class Orchestrator {
  readonly board: Board;
  private readonly cfg: Required<Omit<OrchestratorConfig, "autoApprove">> & {
    autoApprove: GateKind[] | "all";
  };
  private repo: ProjectRepo | null = null;
  private prd = "";
  private architecture = "";
  private readonly gateWaiters = new Map<string, (g: Gate) => void>();
  private readonly running = new Map<string, Promise<void>>();
  private wake: (() => void) | null = null;
  private pipeline: Promise<void> | null = null;
  private buildLoop: Promise<void> | null = null;
  private abort = new AbortController();

  constructor(
    private readonly runner: AgentRunner,
    config: OrchestratorConfig,
    board?: Board,
  ) {
    this.board = board ?? new Board();
    this.cfg = {
      workspaceDir: resolve(config.workspaceDir),
      engineersPerArea: config.engineersPerArea ?? 1,
      floaters: config.floaters ?? 1,
      budgetUsd: config.budgetUsd ?? 20,
      maxAttempts: config.maxAttempts ?? 3,
      lendThreshold: config.lendThreshold ?? 2,
      autoApprove: config.autoApprove ?? [],
      tickMs: config.tickMs ?? 500,
    };
  }

  get isRunning(): boolean {
    return this.pipeline !== null;
  }

  get repoDir(): string | null {
    return this.repo?.dir ?? null;
  }

  // ---- public controls -------------------------------------------------

  /** Start a new product. Returns at once; the pipeline runs in the background. */
  start(idea: string, name?: string): Project {
    if (this.pipeline) throw new Error("A project is already running");
    this.abort = new AbortController();
    const project = this.setup(idea, name);
    this.pipeline = this.runPipeline(idea).finally(() => {
      this.pipeline = null;
    });
    return project;
  }

  /** Start and wait for the pipeline to finish (CLI and tests). */
  async run(idea: string, name?: string): Promise<Project> {
    this.start(idea, name);
    await this.pipeline;
    if (this.buildLoop) await this.buildLoop;
    return this.board.project!;
  }

  approve(gateId: string, feedback?: string): Gate {
    const gate = this.board.resolveGate(gateId, true, feedback);
    this.gateWaiters.get(gateId)?.(gate);
    this.gateWaiters.delete(gateId);
    return gate;
  }

  reject(gateId: string, feedback: string): Gate {
    const gate = this.board.resolveGate(gateId, false, feedback);
    this.gateWaiters.get(gateId)?.(gate);
    this.gateWaiters.delete(gateId);
    return gate;
  }

  /** Give a failed ticket another round, optionally with guidance for the engineer. */
  retry(ticketId: string, guidance?: string): Ticket {
    const t = this.board.ticket(ticketId);
    if (t.status !== "failed") throw new Error(`${ticketId} is ${t.status}, not failed`);
    const gate = this.pendingFailureGate(ticketId);
    if (gate) this.approve(gate.id, guidance);
    else this.resolveFailed(ticketId, true, guidance);
    return this.board.ticket(ticketId);
  }

  /** Leave a failed ticket out; tickets that depend on it go ahead without it. */
  skip(ticketId: string): Ticket {
    const t = this.board.ticket(ticketId);
    if (t.status !== "failed") throw new Error(`${ticketId} is ${t.status}, not failed`);
    const gate = this.pendingFailureGate(ticketId);
    if (gate) this.reject(gate.id, "Skipped");
    else this.resolveFailed(ticketId, false);
    return this.board.ticket(ticketId);
  }

  private pendingFailureGate(ticketId: string): Gate | undefined {
    return this.board.gates.find((g) => g.kind === "ticket_failed" && g.ticketId === ticketId && g.status === "pending");
  }

  /** Stop dispatching and abort running agents. */
  stop(): void {
    this.abort.abort();
    this.poke();
  }

  // ---- pipeline --------------------------------------------------------

  private setup(idea: string, name?: string): Project {
    this.board.reset();
    const slug =
      (name ?? idea)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32) || "product";
    const dir = join(this.cfg.workspaceDir, `${slug}-${Date.now().toString(36)}`);
    const project: Project = {
      id: slug,
      name: name ?? idea.split(/[.\n]/)[0]!.slice(0, 60),
      idea,
      dir,
      phase: "planning",
      budgetUsd: this.cfg.budgetUsd,
      spentUsd: 0,
      createdAt: Date.now(),
    };
    this.board.setProject(project);
    this.board.addAgent({ id: IDS.pm, name: "PM", role: "pm" });
    this.board.addAgent({ id: IDS.techLead, name: "Tech lead", role: "tech_lead" });
    this.board.addAgent({ id: IDS.taskCreator, name: "Task creator", role: "task_creator" });
    this.board.addAgent({
      id: IDS.cfo,
      name: "CFO",
      role: "cfo",
      activity: `Budget $${this.cfg.budgetUsd.toFixed(2)}`,
    });
    this.repo = new ProjectRepo(dir);
    return project;
  }

  private async runPipeline(idea: string): Promise<void> {
    const repo = this.repo!;
    try {
      await repo.init({
        "README.md": `# ${this.board.project!.name}\n\n${idea}\n\nBuilt by an AI software company.\n`,
        "docs/owners/.gitkeep": "",
      });
      this.board.log("info", "Created the product repo");

      // 1. PRD
      this.prd = await this.untilApproved("prd", async (feedback, previous) => {
        this.board.updateProject({ phase: "planning" });
        const res = await this.runAgent(IDS.pm, {
          kind: "prd",
          systemPrompt: systemPrompts.pm,
          prompt: prdPrompt(idea, feedback, previous),
          cwd: repo.dir,
          canWrite: false,
          context: { idea, feedback },
        });
        return { title: "Approve the PRD", content: res.text, value: res.text };
      });
      await repo.commitToMain({ "docs/PRD.md": this.prd }, "PM: add PRD");

      // 2. Architecture and areas
      const arch = await this.untilApproved<Architecture>("architecture", async (feedback) => {
        this.board.updateProject({ phase: "architecture" });
        const res = await this.runAgent(IDS.techLead, {
          kind: "architecture",
          systemPrompt: systemPrompts.tech_lead,
          prompt: architecturePrompt(this.prd, feedback),
          cwd: repo.dir,
          canWrite: false,
          context: { prd: this.prd, feedback },
        });
        const parsed = parseWith(ArchitectureSchema, res.text);
        return { title: "Approve the architecture", content: renderArchitecture(parsed), value: parsed };
      });
      this.architecture = arch.summary;
      const areas = this.staffAreas(arch);
      await repo.commitToMain(
        {
          "docs/ARCHITECTURE.md": renderArchitecture(arch),
          ...Object.fromEntries(
            areas.map((a) => [
              `docs/owners/${a.id}.md`,
              `# Owner notes: ${a.name}\n\nPaths: ${a.paths.join(", ")}\nLead: ${a.lead}\n\n## Notes\n`,
            ]),
          ),
        },
        "Tech lead: add architecture and owner notes",
      );

      // 3. Tickets
      this.board.updateProject({ phase: "ticketing" });
      const plan = await this.runAgent(IDS.taskCreator, {
        kind: "tickets",
        systemPrompt: systemPrompts.task_creator,
        prompt: ticketsPrompt(this.prd, this.architecture, areas),
        cwd: repo.dir,
        canWrite: false,
        context: { prd: this.prd, areas },
      });
      this.createTickets(parseWith(TicketPlanSchema, plan.text).tickets, areas);

      // 4. Build
      this.board.updateProject({ phase: "building" });
      await this.ensureBuildLoop();
    } catch (err) {
      if (this.abort.signal.aborted) {
        this.board.log("warn", "Stopped by the CEO");
      } else {
        this.board.log("error", `Pipeline failed: ${(err as Error).message}`);
      }
      this.board.updateProject({ phase: "failed" });
    }
  }

  /** Run a step, open a gate on its output, and redo it until the CEO approves. */
  private async untilApproved<T>(
    kind: GateKind,
    step: (feedback?: string, previous?: string) => Promise<{ title: string; content: string; value: T }>,
  ): Promise<T> {
    let feedback: string | undefined;
    let previous: string | undefined;
    for (;;) {
      const out = await step(feedback, previous);
      const gate = await this.waitForGate(this.board.openGate(kind, out.title, out.content));
      if (gate.status === "approved") return out.value;
      feedback = gate.feedback;
      previous = out.content;
      this.board.log("info", `CEO requested changes: ${feedback ?? ""}`);
    }
  }

  private waitForGate(gate: Gate): Promise<Gate> {
    const auto = this.cfg.autoApprove === "all" || this.cfg.autoApprove.includes(gate.kind);
    const p = new Promise<Gate>((res, rej) => {
      this.gateWaiters.set(gate.id, res);
      this.abort.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
    });
    this.board.log("info", `Waiting on CEO: ${gate.title}`);
    // Under "all", a failed ticket is skipped rather than retried, so an
    // unattended run can't loop on a broken ticket and burn the budget.
    if (gate.kind === "ticket_failed" && this.cfg.autoApprove === "all") {
      queueMicrotask(() => this.reject(gate.id, "auto-skipped"));
    } else if (auto) {
      queueMicrotask(() => this.approve(gate.id, "auto-approved"));
    }
    return p;
  }

  /** Create engineers for each area from the approved architecture. */
  private staffAreas(arch: Architecture): Area[] {
    const areas: Area[] = [];
    for (const a of arch.areas) {
      if (a.shared) {
        areas.push({ ...a, lead: IDS.techLead, members: [IDS.techLead], shared: true });
        continue;
      }
      const members: string[] = [];
      for (let i = 1; i <= this.cfg.engineersPerArea; i++) {
        const id = `eng-${a.id}-${i}`;
        this.board.addAgent({ id, name: `Engineer ${a.id} ${i}`, role: "engineer", area: a.id });
        members.push(id);
      }
      areas.push({ id: a.id, name: a.name, paths: a.paths, lead: members[0]!, members });
    }
    for (let i = 1; i <= this.cfg.floaters; i++) {
      this.board.addAgent({ id: `eng-floater-${i}`, name: `Engineer floater ${i}`, role: "engineer" });
    }
    this.board.setAreas(areas);
    return areas;
  }

  private createTickets(planned: { key: string; title: string; description: string; acceptance: string[]; area?: string; files: string[]; dependsOn: string[]; priority: number }[], areas: Area[]): void {
    const idByKey = new Map<string, string>();
    for (const p of planned) idByKey.set(p.key, this.board.nextTicketId());
    const areaIds = new Set(areas.map((a) => a.id));

    for (const p of planned) {
      const res = resolveArea(p.files, areas);
      let area: string;
      if (res.kind === "single") {
        area = res.area;
      } else {
        area = p.area && areaIds.has(p.area) ? p.area : (areas.find((a) => a.shared) ?? areas[0]!).id;
        const why =
          res.kind === "split" ? `spans areas ${res.areas.join(", ")}` : `has unowned files ${res.files.join(", ")}`;
        this.board.log("warn", `Ticket "${p.title}" ${why}; assigned to ${area}`);
      }
      const dependsOn = p.dependsOn.flatMap((k) => {
        const id = idByKey.get(k);
        if (!id) this.board.log("warn", `Ticket "${p.title}" depends on unknown key "${k}"; ignored`);
        return id ? [id] : [];
      });
      this.board.addTicket({
        id: idByKey.get(p.key)!,
        title: p.title,
        description: p.description,
        acceptance: p.acceptance,
        area,
        files: p.files,
        dependsOn,
        priority: p.priority,
        status: "ready",
      });
    }
    this.board.log("info", `Task creator filed ${planned.length} tickets`);
  }

  // ---- build loop ------------------------------------------------------

  private ensureBuildLoop(): Promise<void> {
    if (!this.buildLoop) {
      this.buildLoop = this.build().finally(() => {
        this.buildLoop = null;
      });
    }
    return this.buildLoop;
  }

  private async build(): Promise<void> {
    let stuck: string[] = [];
    while (!this.abort.signal.aborted) {
      const project = this.board.project!;
      // Failed tickets stay open: they wait on a CEO decision, not on us.
      const open = this.board.tickets.filter((t) => !["done", "skipped"].includes(t.status));
      if (open.length === 0 && this.running.size === 0) break;

      if (project.phase === "building") {
        const plan = planDispatch(
          { tickets: this.board.tickets, areas: this.board.areas, agents: this.board.agents, leases: this.board.leases },
          { lendThreshold: this.cfg.lendThreshold },
        );
        for (const a of plan.assignments) this.startTicket(a);
        // Nothing running and nothing startable. If a failure is waiting on
        // the CEO, wait for that decision; otherwise nothing can unblock it.
        if (plan.assignments.length === 0 && this.running.size === 0) {
          const awaitingCeo = this.board.tickets.some((t) => t.status === "failed" && this.pendingFailureGate(t.id));
          if (!awaitingCeo) {
            stuck = plan.waiting.map((w) => `${w.ticketId} (${w.reason})`);
            break;
          }
        }
      }
      await this.sleepUntilWoken();
    }
    await Promise.allSettled(this.running.values());
    if (this.abort.signal.aborted) return;

    if (stuck.length > 0) {
      this.board.updateProject({ phase: "failed" });
      this.board.log("error", `Build stopped, blocked: ${stuck.join("; ")}`);
      return;
    }

    this.board.updateProject({ phase: "releasing" });
    const log = await this.repo!.log(50);
    const merged = this.board.tickets.filter((t) => t.status === "done");
    const skipped = this.board.tickets.filter((t) => t.status === "skipped");
    const summary = `${merged.length} of ${this.board.tickets.length} tickets merged into main.
${skipped.length > 0 ? `\n**Skipped by you:** ${skipped.map((t) => `${t.id} ${t.title}`).join(", ")}. Dependents were built without them, using stubs.\n` : ""}
**Spend:** $${this.board.project!.spentUsd.toFixed(2)} of $${this.board.project!.budgetUsd.toFixed(2)}

**Repo:** \`${this.repo!.dir}\`

Recent commits:
${log.slice(0, 15).map((l) => `- ${l}`).join("\n")}`;
    const gate = await this.waitForGate(this.board.openGate("release", "Approve the v1 release", summary));
    if (gate.status === "approved") {
      this.board.updateProject({ phase: "shipped" });
      this.board.log("info", "Shipped v1");
    } else {
      this.board.updateProject({ phase: "failed" });
      this.board.log("warn", `Release held by the CEO: ${gate.feedback ?? ""}`);
    }
  }

  private sleepUntilWoken(): Promise<void> {
    return new Promise((res) => {
      const timer = setTimeout(done, this.cfg.tickMs);
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wake === done) self.wake = null;
        res();
      }
      this.wake = done;
    });
  }

  private poke(): void {
    this.wake?.();
  }

  private startTicket(a: Assignment): void {
    const ticket = this.board.ticket(a.ticketId);
    this.board.acquireLease({ ticketId: a.ticketId, agentId: a.agentId, files: a.files, acquiredAt: Date.now() });
    this.board.moveTicket(a.ticketId, "in_progress", { assignee: a.agentId });
    this.board.updateAgent(a.agentId, { status: "working", currentTicket: a.ticketId });
    this.board.log(
      "info",
      `${a.ticketId} → ${this.board.agent(a.agentId).name}${a.lent ? ` (lent to ${ticket.area})` : ""}`,
      { ticketId: a.ticketId, agentId: a.agentId },
    );
    const p = this.runTicket(a)
      .catch((err) => this.sendBack(a, `Unexpected error: ${(err as Error).message}`))
      .finally(() => {
        this.running.delete(a.ticketId);
        this.poke();
      });
    this.running.set(a.ticketId, p);
  }

  private async runTicket(a: Assignment): Promise<void> {
    const repo = this.repo!;
    const t = this.board.ticket(a.ticketId);
    const worktree = await repo.openWorktree(t.id);
    const notes = repo.readMain(`docs/owners/${t.area}.md`);

    // Build
    const skippedDeps = t.dependsOn
      .map((id) => this.board.ticket(id))
      .filter((d) => d.status === "skipped")
      .map((d) => ({ id: d.id, title: d.title }));
    const build = await this.runAgent(
      a.agentId,
      {
        kind: "build",
        systemPrompt: systemPrompts.engineer,
        prompt: buildPrompt(t, notes, this.prd, {
          skippedDeps,
          escalation: t.escalated ? { failures: t.failures ?? [] } : undefined,
        }),
        cwd: worktree,
        canWrite: true,
        escalated: t.escalated,
        context: { ticket: { ...t }, prd: this.prd },
      },
      t.id,
    );
    if (!build.ok) return this.sendBack(a, `Build failed: ${build.error ?? "unknown error"}`);

    const committed = await repo.commitWorktree(t.id, `${t.id}: ${t.title}`);
    if (!committed) return this.sendBack(a, "No changes were made.");

    // Lease check: touching files someone else holds is a conflict.
    const changed = await repo.changedFiles(t.id);
    this.board.updateTicket(t.id, { changedFiles: changed });
    const others = this.board.leases.filter((l) => l.ticketId !== t.id);
    const clashes = others.filter((l) => anyOverlap(l.files, changed));
    if (clashes.length > 0) {
      const detail = clashes
        .map((l) => `${overlaps(l.files, changed).map((p) => p[1]).join(", ")} (leased by ${l.ticketId})`)
        .join("; ");
      // Discard the attempt: the branch holds the trespassing commit.
      return this.sendBack(a, `Touched files leased by another ticket: ${detail}. Stay within your files.`, {
        discardBranch: true,
      });
    }
    const outside = changed.filter((f) => !anyOverlap([f], a.files));
    if (outside.length > 0) {
      this.board.log("warn", `${t.id} also changed ${outside.join(", ")} (outside its lease, no conflict)`, {
        ticketId: t.id,
      });
    }

    // Review
    this.board.moveTicket(t.id, "review");
    this.board.updateAgent(a.agentId, { activity: "Waiting for review" });
    const review = await this.runAgent(
      IDS.techLead,
      {
        kind: "review",
        systemPrompt: systemPrompts.reviewer,
        prompt: reviewPrompt(t, await repo.diff(t.id)),
        cwd: worktree,
        canWrite: false,
        context: { ticket: { ...this.board.ticket(t.id) } },
      },
      t.id,
      { keepStatus: true },
    );
    let verdict: { verdict: "approve" | "changes"; feedback: string };
    try {
      verdict = parseWith(ReviewSchema, review.text);
    } catch {
      verdict = review.ok
        ? { verdict: "approve", feedback: "" }
        : { verdict: "changes", feedback: `Review failed: ${review.error ?? "unknown"}` };
      if (review.ok) this.board.log("warn", `${t.id}: review output unreadable; approving`, { ticketId: t.id });
    }
    this.board.updateAgent(IDS.techLead, {
      activity: `Reviewed ${t.id}: ${verdict.verdict === "approve" ? "approved" : "changes requested"}`,
    });
    if (verdict.verdict === "changes") return this.sendBack(a, verdict.feedback || "Changes requested.");

    // Merge
    const merged = await repo.merge(t.id, `Merge ${t.id}: ${t.title}`);
    if (!merged.ok) return this.sendBack(a, `Merge conflict with main: ${merged.error}`);

    // Owner notes: the area lead is the only writer.
    let report = { summary: "", notes: "" };
    try {
      report = parseWith(BuildReportSchema, build.text);
    } catch {
      /* the report is optional */
    }
    const area = this.board.area(t.area);
    if (report.notes.trim() && area) {
      const path = `docs/owners/${area.id}.md`;
      const lead = this.board.agent(area.lead).name;
      await repo.commitToMain(
        { [path]: `${repo.readMain(path).trimEnd()}\n- ${report.notes.trim()} _(${t.id}, recorded by ${lead})_\n` },
        `${lead}: owner notes for ${t.id}`,
      );
    }

    await repo.closeWorktree(t.id, true);
    this.board.releaseLease(t.id);
    this.board.moveTicket(t.id, "done", { feedback: undefined });
    this.board.updateAgent(a.agentId, { status: "idle", currentTicket: undefined, activity: `Shipped ${t.id}` });
    this.board.log("info", `${t.id} merged: ${t.title}`, { ticketId: t.id, agentId: a.agentId });
    this.checkBudget();
  }

  /**
   * A failed or rejected attempt. The owner gets the early attempts; the
   * last one is escalated to the tech lead with the full failure history.
   * If that fails too, the CEO decides: retry with guidance, or skip.
   */
  private async sendBack(a: Assignment, feedback: string, opts: { discardBranch?: boolean } = {}): Promise<void> {
    const t = this.board.ticket(a.ticketId);
    const attempts = t.attempts + 1;
    const failures = [...(t.failures ?? []), feedback];
    await this.repo!.closeWorktree(t.id, opts.discardBranch ?? false).catch(() => undefined);
    this.board.releaseLease(t.id);
    this.board.updateAgent(a.agentId, { status: "idle", currentTicket: undefined, activity: `Sent back ${t.id}` });
    const meta = { ticketId: t.id, agentId: a.agentId };

    if (attempts >= this.cfg.maxAttempts) {
      this.board.moveTicket(t.id, "failed", { attempts, feedback, failures, assignee: undefined, escalated: false });
      this.board.log("error", `${t.id} failed after ${attempts} attempts: ${feedback}`, meta);
      this.askCeoAboutFailure(t.id);
      return;
    }

    const escalate = attempts === this.cfg.maxAttempts - 1;
    this.board.moveTicket(t.id, "ready", { attempts, feedback, failures, assignee: undefined, escalated: escalate });
    this.board.log("warn", `${t.id} sent back: ${feedback}`, meta);
    if (escalate) this.board.log("info", `${t.id} escalated to the tech lead for its last attempt`, meta);
  }

  /** Open a decision card for a failed ticket. Other work keeps going meanwhile. */
  private askCeoAboutFailure(ticketId: string): void {
    const t = this.board.ticket(ticketId);
    const waiting = this.board.tickets.filter((x) => x.dependsOn.includes(ticketId) && !["done", "skipped"].includes(x.status));
    const content = `**${t.id}: ${t.title}** failed ${t.attempts} times, the last attempt by the tech lead.

**Why each attempt failed**

${(t.failures ?? []).map((f, i) => `${i + 1}. ${f}`).join("\n")}

**Waiting on it:** ${waiting.length > 0 ? waiting.map((x) => `${x.id} ${x.title}`).join(", ") : "nothing else"}. Other tickets keep building while you decide.

- **Retry with guidance:** your note goes to the owner engineer, who gets fresh attempts with the tech lead as backup.
- **Skip this ticket:** it's left out. Tickets that depend on it go ahead and stub around it, and the release notes list it.`;
    const gate = this.board.openGate("ticket_failed", `${t.id} failed: ${t.title}`, content, t.id);
    void this.waitForGate(gate).then(
      (g) => this.resolveFailed(ticketId, g.status === "approved", g.feedback),
      () => undefined,
    );
  }

  private resolveFailed(ticketId: string, retry: boolean, guidance?: string): void {
    const t = this.board.ticket(ticketId);
    if (t.status !== "failed") return;
    const note = guidance?.trim() && guidance !== "auto-approved" ? guidance.trim() : undefined;
    if (retry) {
      this.board.moveTicket(ticketId, "ready", {
        attempts: 0,
        escalated: false,
        feedback: note ? `CEO guidance: ${note}\n\nLast failure: ${t.feedback ?? ""}` : t.feedback,
      });
      this.board.log("info", `CEO sent ${ticketId} back for another round${note ? " with guidance" : ""}`, { ticketId });
    } else {
      this.board.moveTicket(ticketId, "skipped", { escalated: false });
      this.board.log("warn", `CEO skipped ${ticketId}; tickets that depend on it go ahead without it`, { ticketId });
    }
    if (this.board.project?.phase === "failed") {
      this.board.updateProject({ phase: "building" });
      void this.ensureBuildLoop();
    }
    this.poke();
  }

  // ---- agents ----------------------------------------------------------

  private async runAgent(
    agentId: string,
    task: Omit<AgentTask, "agentId" | "role">,
    ticketId?: string,
    opts: { keepStatus?: boolean } = {},
  ): Promise<AgentResult> {
    const agent = this.board.agent(agentId);
    const prevStatus = agent.status;
    if (!opts.keepStatus) this.board.updateAgent(agentId, { status: "working" });
    const res = await this.runner.run(
      { ...task, agentId, role: agent.role },
      (line) => this.board.updateAgent(agentId, { activity: line }),
      this.abort.signal,
    );
    this.board.addSpend(agentId, res.costUsd, ticketId);
    this.checkBudget();
    if (!opts.keepStatus && task.kind !== "build") {
      const finished = { prd: "Handed in the PRD", architecture: "Handed in the architecture", tickets: "Filed the tickets", review: "", build: "" }[task.kind];
      this.board.updateAgent(agentId, {
        status: prevStatus === "working" ? "working" : "idle",
        ...(res.ok && finished ? { activity: finished } : {}),
      });
    }
    if (!res.ok && task.kind !== "build") {
      throw new Error(`${agent.name} failed: ${res.error ?? "unknown error"}`);
    }
    return res;
  }

  /** The CFO's job for now: watch spend and stop new work at the budget. */
  private checkBudget(): void {
    const p = this.board.project;
    if (!p) return;
    const done = this.board.tickets.filter((t) => t.status === "done").length;
    this.board.updateAgent(IDS.cfo, {
      activity: `Spent $${p.spentUsd.toFixed(2)} of $${p.budgetUsd.toFixed(2)} · ${done} tickets done`,
    });
    if (p.spentUsd < p.budgetUsd || p.phase !== "building") return;
    if (this.board.gates.some((g) => g.kind === "spend" && g.status === "pending")) return;

    this.board.updateProject({ phase: "paused" });
    this.board.log("warn", `Budget reached: $${p.spentUsd.toFixed(2)}. Dispatch paused.`, { agentId: IDS.cfo });
    const gate = this.board.openGate(
      "spend",
      `Approve another $${this.cfg.budgetUsd.toFixed(2)}`,
      `Spend has reached **$${p.spentUsd.toFixed(2)}** of the **$${p.budgetUsd.toFixed(2)}** budget.\n\n` +
        `Running tickets will finish; no new tickets start until you approve.\n\n` +
        costTable(this.board.tickets, this.board.agents),
    );
    void this.waitForGate(gate).then(
      (g) => {
        if (g.status === "approved") {
          this.board.updateProject({ phase: "building", budgetUsd: p.budgetUsd + this.cfg.budgetUsd });
        } else {
          this.board.log("warn", "CEO declined more budget; stopping");
          this.stop();
        }
        this.poke();
      },
      () => undefined,
    );
  }
}

function renderArchitecture(a: Architecture): string {
  const rows = a.areas
    .map((x) => `| ${x.name} | ${x.paths.join(", ")} | ${x.shared ? "Shared: one ticket at a time" : "Owned"} |`)
    .join("\n");
  return `${a.summary}\n\n## Ownership areas\n\n| Area | Paths | Work |\n| --- | --- | --- |\n${rows}\n`;
}

function costTable(tickets: readonly Ticket[], agents: readonly Agent[]): string {
  const top = [...tickets].sort((x, y) => y.costUsd - x.costUsd).slice(0, 5);
  const byAgent = [...agents].filter((a) => a.spentUsd > 0).sort((x, y) => y.spentUsd - x.spentUsd);
  return (
    `| Ticket | Cost |\n| --- | --- |\n${top.map((t) => `| ${t.id} ${t.title} | $${t.costUsd.toFixed(2)} |`).join("\n")}\n\n` +
    `| Agent | Spent |\n| --- | --- |\n${byAgent.map((a) => `| ${a.name} | $${a.spentUsd.toFixed(2)} |`).join("\n")}`
  );
}
