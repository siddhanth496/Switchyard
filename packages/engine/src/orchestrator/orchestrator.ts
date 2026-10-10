import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Board } from "../core/board.js";
import { planDispatch, type Assignment } from "../core/dispatcher.js";
import { anyOverlap, overlaps, resolveArea } from "../core/paths.js";
import type { Agent, Area, Gate, GateImage, GateKind, Project, Scorecard, Ticket, TicketSize } from "../core/types.js";
import {
  BENCH_MERGES,
  HEADROOM,
  POINTS,
  addEvent,
  deliveryPoints,
  emptyScorecard,
  standingFor,
  unitPrice,
  unitsOf,
} from "../core/cfo.js";
import {
  architecturePrompt,
  brandPrompt,
  buildPrompt,
  designPrompt,
  feasibilityPrompt,
  launchPrompt,
  prdChangePrompt,
  prdPrompt,
  qaPrompt,
  reviewPrompt,
  systemPrompts,
  ticketsPrompt,
} from "../agents/prompts.js";
import type { AgentResult, AgentRunner, AgentTask } from "../agents/runner.js";
import {
  ArchitectureSchema,
  BrandSchema,
  BuildReportSchema,
  DesignSchema,
  FeasibilitySchema,
  LaunchSchema,
  QaReportSchema,
  ReviewSchema,
  TicketPlanSchema,
  parseWith,
  type Architecture,
  type BrandPlan,
  type Feasibility,
  type QaReport,
} from "../agents/schemas.js";
import { ProjectRepo } from "../git/repo.js";
import { monogramLogo, paletteSvg, renderBrand, renderDesign, renderLaunch, safeSvg, slugify, toBrand } from "./brand.js";

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
  /** QA test rounds before release (0 turns QA off). Bugs from the last round become known issues. */
  qaRounds?: number;
  /** Most related tickets one engineer builds in a session (1 turns batching off). */
  maxBatch?: number;
  /** Marketing names and brands the product, and writes the launch copy. */
  marketing?: boolean;
  /** The designer drafts a design system and key screens; the PM checks feasibility. */
  design?: boolean;
  /** Designer ↔ PM rounds before the PM makes the final call on scope. */
  designRounds?: number;
}

/** Starting .gitignore for every product repo: dependencies, builds, secrets and OS clutter. */
const PRODUCT_GITIGNORE = `node_modules/
.pnpm-store/
dist/
build/
out/
.next/
.turbo/
coverage/
*.log
.env
.env.*
!.env.example
.DS_Store
`;

const IDS = {
  pm: "pm",
  taskCreator: "task-creator",
  techLead: "tech-lead",
  qa: "qa",
  cfo: "cfo",
  marketing: "marketing",
  designer: "designer",
} as const;

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
  private qaRound = 0;
  private releaseRound = 0;
  /** True when working on a product that already exists. */
  private existing = false;
  private unitUsd = 0;
  private mergeCount = 0;
  private qaNotes: string[] = [];
  private knownIssues: string[] = [];
  /** The approved brand and design, as markdown, for later prompts. */
  private brandDoc = "";
  private designDoc = "";
  private launchWritten = false;

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
      qaRounds: config.qaRounds ?? 2,
      maxBatch: config.maxBatch ?? 3,
      marketing: config.marketing ?? true,
      design: config.design ?? true,
      designRounds: Math.max(1, config.designRounds ?? 2),
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
  start(idea: string, name?: string, opts: { existingDir?: string } = {}): Project {
    if (this.pipeline) throw new Error("A project is already running");
    this.abort = new AbortController();
    const project = this.setup(idea, name, opts.existingDir);
    this.pipeline = this.runPipeline(idea).finally(() => {
      this.pipeline = null;
    });
    return project;
  }

  /** Start and wait for the pipeline to finish (CLI and tests). */
  async run(idea: string, name?: string, opts: { existingDir?: string } = {}): Promise<Project> {
    this.start(idea, name, opts);
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

  private setup(idea: string, name?: string, existingDir?: string): Project {
    this.board.reset();
    this.existing = !!existingDir;
    const existingName = existingDir ? productName(existingDir) : undefined;
    const slug =
      (name ?? existingName ?? idea)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32) || "product";
    const dir = existingDir ?? join(this.cfg.workspaceDir, `${slug}-${Date.now().toString(36)}`);
    const project: Project = {
      id: slug,
      name: name ?? existingName ?? idea.split(/[.\n]/)[0]!.slice(0, 60),
      idea,
      dir,
      phase: "planning",
      budgetUsd: this.cfg.budgetUsd,
      spentUsd: 0,
      teams: { marketing: this.cfg.marketing, design: this.cfg.design },
      createdAt: Date.now(),
    };
    this.board.setProject(project);
    this.board.addAgent({ id: IDS.pm, name: "PM", role: "pm" });
    this.board.addAgent({ id: IDS.techLead, name: "Tech lead", role: "tech_lead" });
    this.board.addAgent({ id: IDS.taskCreator, name: "Task creator", role: "task_creator" });
    this.board.addAgent({ id: IDS.qa, name: "QA", role: "qa", activity: "Tests the build before release" });
    this.qaRound = 0;
    this.releaseRound = 0;
    this.unitUsd = 0;
    this.mergeCount = 0;
    this.qaNotes = [];
    this.knownIssues = [];
    this.brandDoc = "";
    this.designDoc = "";
    this.launchWritten = false;
    this.board.addAgent({
      id: IDS.cfo,
      name: "CFO",
      role: "cfo",
      activity: `Budget $${this.cfg.budgetUsd.toFixed(2)}`,
    });
    if (this.cfg.design) {
      this.board.addAgent({ id: IDS.designer, name: "Designer", role: "designer", activity: "Design system and key screens" });
    }
    if (this.cfg.marketing) {
      this.board.addAgent({ id: IDS.marketing, name: "Marketing lead", role: "marketing", activity: "Name, logo, voice and launch" });
    }
    this.repo = new ProjectRepo(dir);
    return project;
  }

  private async runPipeline(idea: string): Promise<void> {
    const repo = this.repo!;
    try {
      if (this.existing) {
        this.board.log("info", `Continuing ${this.board.project!.name}: ${idea}`);
      } else {
        await repo.init({
          "README.md": `# ${this.board.project!.name}\n\n${idea}\n\nBuilt by an AI software company.\n`,
          ".gitignore": PRODUCT_GITIGNORE,
          "docs/owners/.gitkeep": "",
        });
        this.board.log("info", "Created the product repo");
      }
      const existingFiles = this.existing ? await repo.listFiles() : undefined;

      // 1. PRD (for an existing product: the PM updates it for the change)
      const currentPrd = this.existing ? repo.readMain("docs/PRD.md") || repo.readMain("README.md") : "";
      this.prd = await this.untilApproved("prd", async (feedback, previous) => {
        this.board.updateProject({ phase: "planning" });
        const res = await this.runAgent(IDS.pm, {
          kind: "prd",
          systemPrompt: systemPrompts.pm,
          prompt: this.existing ? prdChangePrompt(currentPrd, idea, feedback, previous) : prdPrompt(idea, feedback, previous),
          cwd: repo.dir,
          canWrite: false,
          context: { idea, feedback },
        });
        return { title: this.existing ? "Approve the updated PRD" : "Approve the PRD", content: res.text, value: res.text };
      });
      await repo.commitToMain({ "docs/PRD.md": this.prd }, this.existing ? "PM: update PRD" : "PM: add PRD");

      // 2. Brand (marketing), then design (designer, signed off by the PM)
      await this.brandPhase(idea);
      await this.designPhase(idea);

      // 3. Architecture and areas (an existing product reuses its saved areas)
      let arch = this.existing ? savedAreas(repo.readMain("docs/areas.json")) : undefined;
      if (arch) {
        this.board.log("info", `Using the existing ownership areas: ${arch.areas.map((a) => a.id).join(", ")}`);
      } else {
        arch = await this.untilApproved<Architecture>("architecture", async (feedback) => {
          this.board.updateProject({ phase: "architecture" });
          const res = await this.runAgent(IDS.techLead, {
            kind: "architecture",
            systemPrompt: systemPrompts.tech_lead,
            prompt: architecturePrompt(this.prd, feedback, existingFiles, this.designDoc || undefined),
            cwd: repo.dir,
            canWrite: false,
            context: { prd: this.prd, feedback },
          });
          const parsed = parseWith(ArchitectureSchema, res.text);
          return { title: "Approve the architecture", content: renderArchitecture(parsed), value: parsed };
        });
      }
      this.architecture = arch.summary;
      const areas = this.staffAreas(arch);
      const notes = Object.fromEntries(
        areas
          .filter((a) => !repo.readMain(`docs/owners/${a.id}.md`))
          .map((a) => [`docs/owners/${a.id}.md`, `# Owner notes: ${a.name}\n\nPaths: ${a.paths.join(", ")}\nLead: ${a.lead}\n\n## Notes\n`]),
      );
      await repo.commitToMain(
        {
          "docs/ARCHITECTURE.md": renderArchitecture(arch),
          // Saved so a later change request can reuse the same areas.
          "docs/areas.json": `${JSON.stringify(arch, null, 2)}\n`,
          ...notes,
        },
        "Tech lead: architecture, areas and owner notes",
      );

      // 4. Tickets (for an existing product: only the requested change)
      this.board.updateProject({ phase: "ticketing" });
      const plan = await this.runAgent(IDS.taskCreator, {
        kind: "tickets",
        systemPrompt: systemPrompts.task_creator,
        prompt: ticketsPrompt(
          this.prd,
          this.architecture,
          areas,
          existingFiles ? { request: idea, existingFiles } : undefined,
          this.designDoc || undefined,
        ),
        cwd: repo.dir,
        canWrite: false,
        context: { prd: this.prd, areas, changeRequest: this.existing ? idea : undefined },
      });
      this.createTickets(parseWith(TicketPlanSchema, plan.text).tickets, areas, this.existing ? "change" : undefined);

      // 5. Build
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
    step: (feedback?: string, previous?: string) => Promise<{ title: string; content: string; value: T; images?: GateImage[] }>,
  ): Promise<T> {
    let feedback: string | undefined;
    let previous: string | undefined;
    for (;;) {
      const out = await step(feedback, previous);
      const gate = await this.waitForGate(this.board.openGate(kind, out.title, out.content, undefined, out.images));
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

  /**
   * Marketing names and brands the product: name, tagline, positioning,
   * voice, colors and logo. The CEO approves it; the product takes the name.
   * An existing product keeps the brand it has (or its name, if it has none).
   */
  private async brandPhase(idea: string): Promise<void> {
    const repo = this.repo!;
    const saved = savedBrand(repo.readMain("docs/brand/brand.json"));
    if (saved) {
      this.applyBrand(saved);
      this.board.log("info", `Using the existing brand: ${saved.name}`, { agentId: IDS.marketing });
      return;
    }
    if (!this.cfg.marketing || this.existing) return;

    const plan = await this.untilApproved<BrandPlan>("brand", async (feedback, previous) => {
      this.board.updateProject({ phase: "branding" });
      const res = await this.runAgent(IDS.marketing, {
        kind: "brand",
        systemPrompt: systemPrompts.marketing,
        prompt: brandPrompt(idea, this.prd, feedback, previous),
        cwd: repo.dir,
        canWrite: false,
        context: { idea, prd: this.prd, feedback },
      });
      const proposed = parseWith(BrandSchema, res.text);
      const logo = safeSvg(proposed.logoSvg);
      if (!logo) this.board.log("warn", "Marketing's logo wasn't a usable SVG; showing a monogram instead", { agentId: IDS.marketing });
      const brand = { ...proposed, logoSvg: logo ?? monogramLogo(proposed.name, proposed.palette[0]?.hex) };
      return {
        title: `Approve the brand: ${brand.name}`,
        content: renderBrand(brand),
        value: brand,
        images: [
          { title: `${brand.name} logo`, svg: brand.logoSvg },
          { title: "Colors", svg: paletteSvg(brand.palette) },
        ],
      };
    });

    const readme = repo.readMain("README.md").replace(/^# .*$/m, `# ${plan.name}\n\n> ${plan.tagline}`);
    await repo.commitToMain(
      {
        "docs/brand/BRAND.md": renderBrand(plan),
        "docs/brand/logo.svg": `${plan.logoSvg}\n`,
        "docs/brand/brand.json": `${JSON.stringify(plan, null, 2)}\n`,
        "README.md": readme,
      },
      `Marketing: brand ${plan.name}, logo and voice`,
    );
    this.applyBrand(plan);
    this.board.log("info", `The product is now ${plan.name}: "${plan.tagline}"`, { agentId: IDS.marketing });
  }

  private applyBrand(plan: BrandPlan): void {
    this.brandDoc = renderBrand(plan);
    this.board.updateProject({ name: plan.name, brand: toBrand(plan) });
    if (this.board.agents.some((a) => a.id === IDS.marketing)) {
      this.board.updateAgent(IDS.marketing, { activity: `Brand: ${plan.name}` });
    }
  }

  /**
   * The designer drafts the design system and key screens; the PM checks
   * it against the PRD and has the final call on scope. They go back and
   * forth up to `designRounds` times, then the PM's cuts are binding. The
   * CEO then approves the result. An existing product's design is updated
   * for the change, if it has one.
   */
  private async designPhase(idea: string): Promise<void> {
    const repo = this.repo!;
    const current = this.existing ? repo.readMain("docs/design/DESIGN.md") : "";
    this.designDoc = current;
    if (!this.cfg.design || (this.existing && !current)) return;

    type Approved = { doc: string; files: Record<string, string> };
    const approved = await this.untilApproved<Approved>("design", async (feedback, previous) => {
      this.board.updateProject({ phase: "design" });
      let pmNotes: string | undefined;
      let last = previous;
      for (let round = 1; ; round++) {
        const final = round >= this.cfg.designRounds;
        const res = await this.runAgent(IDS.designer, {
          kind: "design",
          systemPrompt: systemPrompts.designer,
          prompt: designPrompt(this.prd, this.brandDoc, {
            feedback: round === 1 ? feedback : undefined,
            pmNotes,
            previous: last,
            current: current || undefined,
            change: this.existing ? idea : undefined,
          }),
          cwd: repo.dir,
          canWrite: false,
          context: { prd: this.prd, brand: this.brandDoc, feedback, pmNotes, designRound: round, changeRequest: this.existing ? idea : undefined },
        });
        const design = parseWith(DesignSchema, res.text);
        const draft = renderDesign(design);

        const check = await this.runAgent(IDS.pm, {
          kind: "feasibility",
          systemPrompt: systemPrompts.pm_feasibility,
          prompt: feasibilityPrompt(this.prd, draft, round, final),
          cwd: repo.dir,
          canWrite: false,
          context: { prd: this.prd, design: draft, designRound: round, finalRound: final },
        });
        let review: Feasibility;
        try {
          review = parseWith(FeasibilitySchema, check.text);
        } catch {
          review = { verdict: "feasible", notes: "", cuts: [] };
          this.board.log("warn", "The PM's feasibility review was unreadable; treating the design as feasible", { agentId: IDS.pm });
        }
        if (review.verdict === "changes" && !final) {
          pmNotes = [review.notes, ...review.cuts.map((c) => `Cut: ${c}`)].filter(Boolean).join("\n");
          last = draft;
          this.board.log("info", `PM sent the design back: ${review.notes || review.cuts.join("; ")}`, { agentId: IDS.pm });
          continue;
        }
        // On the last round the PM's word is final, whatever the verdict: its cuts stand.
        const cuts = review.cuts;
        this.board.log(
          "info",
          `PM signed off the design${cuts.length ? `, cutting ${cuts.length} item(s) from this version` : ""}`,
          { agentId: IDS.pm },
        );
        const doc = renderDesign(design, { ...review, verdict: "feasible", rounds: round });
        const files: Record<string, string> = {
          "docs/design/DESIGN.md": doc,
          "docs/design/tokens.css": `${design.tokensCss.trim() || tokensFromBrand(this.board.project?.brand?.palette ?? [])}\n`,
        };
        const images: GateImage[] = [];
        for (const screen of design.screens) {
          const svg = safeSvg(screen.wireframeSvg);
          if (!svg) continue;
          files[`docs/design/wireframes/${slugify(screen.name)}.svg`] = `${svg}\n`;
          images.push({ title: screen.name, svg });
        }
        return {
          title: this.existing ? "Approve the updated design" : "Approve the design",
          content: doc,
          value: { doc, files },
          images,
        };
      }
    });

    await repo.commitToMain(approved.files, this.existing ? "Designer: update the design" : "Designer: design system and key screens");
    this.designDoc = approved.doc;
    this.board.updateAgent(IDS.designer, { activity: "Design approved" });
  }

  /** Create engineers for each area from the approved architecture. */
  private staffAreas(arch: Architecture): Area[] {
    const areas: Area[] = [];
    // Every area, shared included, gets its own engineers. The tech lead
    // reviews and takes escalations; making it a builder too turned it into
    // a single lane that every foundation ticket queued behind.
    for (const a of arch.areas) {
      const members: string[] = [];
      for (let i = 1; i <= this.cfg.engineersPerArea; i++) {
        const id = `eng-${a.id}-${i}`;
        this.board.addAgent({ id, name: `Engineer ${a.id} ${i}`, role: "engineer", area: a.id, score: emptyScorecard(), standing: "normal" });
        members.push(id);
      }
      areas.push({ id: a.id, name: a.name, paths: a.paths, lead: members[0]!, members, ...(a.shared ? { shared: true } : {}) });
    }
    for (let i = 1; i <= this.cfg.floaters; i++) {
      this.board.addAgent({ id: `eng-floater-${i}`, name: `Engineer floater ${i}`, role: "engineer", score: emptyScorecard(), standing: "normal" });
    }
    this.board.setAreas(areas);
    return areas;
  }

  private createTickets(planned: { key: string; title: string; description: string; acceptance: string[]; area?: string; files: string[]; dependsOn: string[]; priority: number; size?: TicketSize }[], areas: Area[], kind?: "change"): void {
    const idByKey = new Map<string, string>();
    for (const p of planned) idByKey.set(p.key, this.board.nextTicketId());
    const areaIds = new Set(areas.map((a) => a.id));

    for (const p of planned) {
      const area = this.areaFor(p.files, p.area && areaIds.has(p.area) ? p.area : undefined, p.title, areas);
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
        size: p.size ?? "M",
        status: "ready",
        ...(kind ? { kind } : {}),
      });
    }
    this.board.log("info", `Task creator filed ${planned.length} ${kind === "change" ? "change " : ""}tickets`);
    this.allocateBudgets();
  }

  /** The area owning a ticket's files; falls back to a hint, then the shared area. */
  private areaFor(files: string[], hint: string | undefined, title: string, areas: Area[]): string {
    const res = resolveArea(files, areas);
    if (res.kind === "single") return res.area;
    const nonShared = areas.find((a) => !a.shared);
    const fromSplit = res.kind === "split" ? res.areas[0] : undefined;
    const area = hint ?? fromSplit ?? (areas.find((a) => a.shared) ?? nonShared ?? areas[0]!).id;
    const why =
      files.length === 0
        ? "lists no files"
        : res.kind === "split"
          ? `spans areas ${res.areas.join(", ")}`
          : `has unowned files ${res.files.join(", ")}`;
    this.board.log("warn", `Ticket "${title}" ${why}; assigned to ${area}`);
    return area;
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

  /** Build until the board is clear, let QA test, repeat for its bugs, then release. */
  private async build(): Promise<void> {
    for (;;) {
      for (;;) {
        const outcome = await this.dispatchUntilDone();
        if (outcome !== "done") return;
        if (this.qaRound >= this.cfg.qaRounds) break;
        const filed = await this.runQa();
        if (this.abort.signal.aborted) return;
        if (filed === 0) break;
        this.board.updateProject({ phase: "building" });
      }
      // A held release comes back as change tickets; build, test and ask again.
      const next = await this.release();
      if (next !== "changes" || this.abort.signal.aborted) return;
      this.board.updateProject({ phase: "building" });
    }
  }

  /** Turn the CEO's feedback on a held release into change tickets. Returns how many. */
  private async fileChangeTickets(feedback: string): Promise<number> {
    const repo = this.repo!;
    this.board.updateProject({ phase: "ticketing" });
    try {
      const areas = [...this.board.areas];
      const res = await this.runAgent(IDS.taskCreator, {
        kind: "tickets",
        systemPrompt: systemPrompts.task_creator,
        prompt: ticketsPrompt(
          this.prd,
          this.architecture,
          areas,
          { request: feedback, existingFiles: await repo.listFiles() },
          this.designDoc || undefined,
        ),
        cwd: repo.dir,
        canWrite: false,
        context: { prd: this.prd, areas, changeRequest: feedback },
      });
      const planned = parseWith(TicketPlanSchema, res.text).tickets;
      this.createTickets(planned, areas, "change");
      return planned.length;
    } catch (err) {
      if (this.abort.signal.aborted) return 0;
      this.board.log("warn", `Couldn't turn your feedback into tickets: ${(err as Error).message}`, { agentId: IDS.taskCreator });
      return 0;
    }
  }

  /** Dispatch until every ticket is merged or skipped. */
  private async dispatchUntilDone(): Promise<"done" | "stuck" | "aborted"> {
    let stuck: string[] = [];
    while (!this.abort.signal.aborted) {
      const project = this.board.project!;
      // Failed tickets stay open: they wait on a CEO decision, not on us.
      const open = this.board.tickets.filter((t) => !["done", "skipped"].includes(t.status));
      if (open.length === 0 && this.running.size === 0) break;

      if (project.phase === "building") {
        const plan = planDispatch(
          { tickets: this.board.tickets, areas: this.board.areas, agents: this.board.agents, leases: this.board.leases },
          { lendThreshold: this.cfg.lendThreshold, maxBatch: this.cfg.maxBatch },
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
    if (this.abort.signal.aborted) return "aborted";
    if (stuck.length > 0) {
      this.board.updateProject({ phase: "failed" });
      this.board.log("error", `Build stopped, blocked: ${stuck.join("; ")}`);
      return "stuck";
    }
    return "done";
  }

  /**
   * QA tests the merged build in a throwaway worktree and files bugs as
   * tickets. Returns how many it filed. On the last round, bugs are kept
   * as known issues for the release card instead of looping forever.
   */
  private async runQa(): Promise<number> {
    const repo = this.repo!;
    const round = ++this.qaRound;
    this.board.updateProject({ phase: "testing" });
    this.board.log("info", `QA round ${round}: testing the merged build`, { agentId: IDS.qa });

    const scratch = `QA-${round}`;
    const dir = await repo.openWorktree(scratch);
    const merged = this.board.tickets.filter((t) => t.status === "done");
    const earlier = this.board.tickets
      .filter((t) => t.kind === "bug")
      .map((t) => ({ title: t.title.replace(/^Bug: /, ""), fixed: t.status === "done" }));
    let report: QaReport;
    try {
      const res = await this.runAgent(IDS.qa, {
        kind: "qa",
        systemPrompt: systemPrompts.qa,
        prompt: qaPrompt(this.prd, merged, [...this.board.areas], round, earlier),
        cwd: dir,
        canWrite: true,
        maxTurns: 40,
        context: { qaRound: round, prd: this.prd },
      });
      report = parseWith(QaReportSchema, res.text);
    } catch (err) {
      if (this.abort.signal.aborted) return 0;
      const why = (err as Error).message;
      this.qaNotes.push(`Round ${round}: QA couldn't finish (${why}).`);
      this.board.log("warn", `QA round ${round} couldn't finish: ${why}`, { agentId: IDS.qa });
      return 0;
    } finally {
      await repo.closeWorktree(scratch, true);
    }

    if (report.verdict === "pass" || report.bugs.length === 0) {
      this.qaNotes.push(`Round ${round}: passed. ${report.summary}`.trim());
      this.board.updateAgent(IDS.qa, { activity: `Round ${round} passed` });
      this.board.log("info", `QA round ${round} passed`, { agentId: IDS.qa });
      return 0;
    }

    if (round >= this.cfg.qaRounds) {
      this.knownIssues = report.bugs.map((b) => `${b.title} (${b.severity})`);
      this.qaNotes.push(`Round ${round}: ${report.bugs.length} issue(s) still open. ${report.summary}`.trim());
      this.board.updateAgent(IDS.qa, { activity: `Round ${round}: ${report.bugs.length} still open` });
      this.board.log("warn", `QA round ${round} still found ${report.bugs.length} bug(s); listed as known issues`, {
        agentId: IDS.qa,
      });
      return 0;
    }

    const areas = [...this.board.areas];
    for (const bug of report.bugs) {
      const area = this.areaFor(bug.files, undefined, `Bug: ${bug.title}`, areas);
      const steps = bug.steps.length ? `\n\nSteps to reproduce:\n${bug.steps.map((x, i) => `${i + 1}. ${x}`).join("\n")}` : "";
      this.board.addTicket({
        title: `Bug: ${bug.title}`,
        description: `${bug.description}${steps}${bug.expected ? `\n\nExpected: ${bug.expected}` : ""}\n\nFound by QA in round ${round} (${bug.severity}).`,
        acceptance: [bug.expected || "The bug no longer reproduces"],
        area,
        files: bug.files,
        dependsOn: [],
        priority: 0,
        status: "ready",
        kind: "bug",
        size: "M",
      });
      this.traceBug(bug.title, bug.files);
    }
    this.allocateBudgets();
    this.qaNotes.push(`Round ${round}: filed ${report.bugs.length} bug(s). ${report.summary}`.trim());
    this.board.updateAgent(IDS.qa, { activity: `Round ${round}: filed ${report.bugs.length} bug(s)` });
    this.board.log("warn", `QA round ${round} filed ${report.bugs.length} bug(s)`, { agentId: IDS.qa });
    return report.bugs.length;
  }

  /** Penalize whoever merged the files a QA bug points at. */
  private traceBug(title: string, files: string[]): void {
    if (files.length === 0) return;
    const culprit = [...this.board.tickets]
      .reverse()
      .find((t) => t.status === "done" && t.kind !== "bug" && t.assignee && anyOverlap(t.changedFiles ?? t.files, files));
    if (!culprit?.assignee) return;
    this.score(culprit.assignee, POINTS.bugTraced, { bugs: 1 }, `QA traced "${title}" to ${culprit.id}`);
  }

  private async release(): Promise<"shipped" | "changes"> {
    this.board.updateProject({ phase: "releasing" });
    const launch = await this.writeLaunchCopy();
    const log = await this.repo!.log(50);
    const tickets = this.board.tickets;
    const merged = tickets.filter((t) => t.status === "done");
    const skipped = tickets.filter((t) => t.status === "skipped");
    const bugsFixed = tickets.filter((t) => t.kind === "bug" && t.status === "done").length;
    const qa =
      this.cfg.qaRounds === 0
        ? "turned off"
        : this.knownIssues.length > 0
          ? `${this.knownIssues.length} known issue(s) still open: ${this.knownIssues.join("; ")}`
          : `passed${bugsFixed > 0 ? `, after fixing ${bugsFixed} bug(s) it found` : ""}`;
    const summary = `${merged.length} of ${tickets.length} tickets merged into main.
${skipped.length > 0 ? `\n**Skipped by you:** ${skipped.map((t) => `${t.id} ${t.title}`).join(", ")}. Dependents were built without them, using stubs.\n` : ""}
**QA:** ${qa}
${this.qaNotes.length > 0 ? `\n${this.qaNotes.map((n) => `- ${n}`).join("\n")}\n` : ""}
${launch ? `**Launch copy** (from marketing): ${launch}\n\n` : ""}**Spend:** $${this.board.project!.spentUsd.toFixed(2)} of $${this.board.project!.budgetUsd.toFixed(2)}

**Repo:** \`${this.repo!.dir}\`

Recent commits:
${log.slice(0, 15).map((l) => `- ${l}`).join("\n")}`;
    const title = this.releaseRound === 0 ? (this.existing ? "Approve the release" : "Approve the v1 release") : `Approve the release (round ${this.releaseRound + 1})`;
    const gate = await this.waitForGate(this.board.openGate("release", title, summary));
    if (gate.status === "approved") {
      this.board.updateProject({ phase: "shipped" });
      this.board.log("info", this.existing ? "Shipped the update" : "Shipped v1");
      return "shipped";
    }

    // Held: the CEO's feedback becomes change tickets, then build, QA and ask again.
    const feedback = gate.feedback?.trim() ?? "";
    this.board.log("info", `CEO held the release: ${feedback}`);
    this.releaseRound++;
    const filed = feedback ? await this.fileChangeTickets(feedback) : 0;
    if (filed > 0) {
      this.qaRound = 0; // the changes get a fresh QA pass
      this.knownIssues = [];
      this.qaNotes.push(`Release round ${this.releaseRound}: you asked for changes (${filed} ticket(s)).`);
    } else {
      this.board.log("warn", "No change tickets came out of the feedback; asking for the release again", { agentId: IDS.taskCreator });
    }
    return "changes";
  }

  /**
   * Marketing writes the launch copy once, before the first release card,
   * in the brand's voice and claiming only what was merged. Returns a
   * one-line summary for the card, or undefined.
   */
  private async writeLaunchCopy(): Promise<string | undefined> {
    const brand = this.board.project?.brand;
    if (!this.cfg.marketing || !brand || this.launchWritten) return undefined;
    this.launchWritten = true;
    const repo = this.repo!;
    try {
      const shipped = this.board.tickets.filter((t) => t.status === "done" && t.kind !== "bug");
      const res = await this.runAgent(IDS.marketing, {
        kind: "launch",
        systemPrompt: systemPrompts.marketing,
        prompt: launchPrompt(this.prd, this.brandDoc, shipped, this.existing ? this.board.project!.idea : undefined),
        cwd: repo.dir,
        canWrite: false,
        context: { prd: this.prd, brand: this.brandDoc, changeRequest: this.existing ? this.board.project!.idea : undefined },
      });
      const launch = parseWith(LaunchSchema, res.text);
      await repo.commitToMain({ "docs/brand/LAUNCH.md": renderLaunch(brand.name, launch) }, "Marketing: launch copy");
      return `_${launch.headline}_${launch.description ? ` ${launch.description}` : ""} Full copy in \`docs/brand/LAUNCH.md\`.`;
    } catch (err) {
      if (!this.abort.signal.aborted) {
        this.board.log("warn", `Marketing couldn't write the launch copy: ${(err as Error).message}`, { agentId: IDS.marketing });
      }
      return undefined;
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
    const batched = a.batch.length > 1;
    this.board.acquireLease({ ticketId: a.ticketId, agentId: a.agentId, files: a.files, acquiredAt: Date.now() });
    for (const id of a.batch) {
      this.board.moveTicket(id, "in_progress", { assignee: a.agentId, batchWith: batched ? [...a.batch] : undefined });
    }
    this.board.updateAgent(a.agentId, { status: "working", currentTicket: a.batch.join(", ") });
    this.board.log(
      "info",
      `${a.batch.join(" + ")} → ${this.board.agent(a.agentId).name}${a.lent ? ` (lent to ${ticket.area})` : ""}${batched ? " (batched)" : ""}`,
      { ticketId: a.ticketId, agentId: a.agentId },
    );
    const p = this.runTicket(a)
      .catch((err) => this.sendBack(a, `Unexpected error: ${(err as Error).message}`, { penalty: 0 }))
      .finally(() => {
        this.running.delete(a.ticketId);
        this.poke();
      });
    this.running.set(a.ticketId, p);
  }

  private async runTicket(a: Assignment): Promise<void> {
    const repo = this.repo!;
    const tickets = a.batch.map((id) => this.board.ticket(id));
    const t = tickets[0]!;
    const ids = a.batch.join(" + ");
    const worktree = await repo.openWorktree(t.id);
    const notes = repo.readMain(`docs/owners/${t.area}.md`);
    const agent = this.board.agent(a.agentId);

    // The CFO's budget for this session, and the hard cut-off.
    const allotted = tickets.reduce((n, x) => n + (x.budgetUsd ?? unitsOf(x.size) * this.unitUsd), 0);
    const spentBefore = tickets.reduce((n, x) => n + (x.buildSpendUsd ?? 0), 0);
    const cap = allotted > 0 ? Math.max(0.05, allotted * HEADROOM[agent.standing ?? "normal"]) : undefined;

    // Build
    const inBatch = new Set(a.batch);
    const skippedDeps = [...new Set(tickets.flatMap((x) => x.dependsOn))]
      .filter((id) => !inBatch.has(id))
      .map((id) => this.board.ticket(id))
      .filter((d) => d.status === "skipped")
      .map((d) => ({ id: d.id, title: d.title }));
    const build = await this.runAgent(
      a.agentId,
      {
        kind: "build",
        systemPrompt: systemPrompts.engineer,
        prompt: buildPrompt(t, notes, this.prd, {
          batch: tickets,
          skippedDeps,
          escalation: t.escalated ? { failures: t.failures ?? [] } : undefined,
          budget: cap ? { allotted, spent: spentBefore, cap } : undefined,
          trackRecord: this.trackRecordNote(agent),
        }),
        cwd: worktree,
        canWrite: true,
        escalated: t.escalated,
        budgetUsd: cap,
        context: { ticket: { ...t }, batch: tickets.map((x) => ({ ...x })), prd: this.prd },
      },
      a.batch,
    );
    // Build spend is tracked per ticket for the CFO, split evenly in a batch.
    for (const x of tickets) {
      this.board.updateTicket(x.id, { buildSpendUsd: (x.buildSpendUsd ?? 0) + build.costUsd / tickets.length });
    }
    if (!build.ok) {
      if (build.overBudget) {
        return this.sendBack(
          a,
          `Ran out of budget: cut off at $${(cap ?? 0).toFixed(2)} (budget $${allotted.toFixed(2)}). Take a narrower approach: ` +
            "read only the files you need, reuse existing code, and skip optional extras.",
          { penalty: POINTS.cutOff, cutOff: true },
        );
      }
      return this.sendBack(a, `Build failed: ${build.error ?? "unknown error"}`);
    }

    const committed = await repo.commitWorktree(t.id, `${ids}: ${tickets.map((x) => x.title).join("; ")}`);
    if (!committed) return this.sendBack(a, "No changes were made.");

    // Lease check: touching files someone else holds is a conflict.
    const changed = await repo.changedFiles(t.id);
    for (const x of tickets) this.board.updateTicket(x.id, { changedFiles: changed });
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
      this.board.log("warn", `${ids} also changed ${outside.join(", ")} (outside its lease, no conflict)`, {
        ticketId: t.id,
      });
    }

    // Review
    for (const x of tickets) this.board.moveTicket(x.id, "review");
    this.board.updateAgent(a.agentId, { activity: "Waiting for review" });
    const review = await this.runAgent(
      IDS.techLead,
      {
        kind: "review",
        systemPrompt: systemPrompts.reviewer,
        prompt: reviewPrompt(t, await repo.diff(t.id), tickets),
        cwd: worktree,
        canWrite: false,
        context: { ticket: { ...this.board.ticket(t.id) }, batch: a.batch.map((id) => ({ ...this.board.ticket(id) })) },
      },
      a.batch,
      { keepStatus: true },
    );
    let verdict: { verdict: "approve" | "changes"; feedback: string };
    try {
      verdict = parseWith(ReviewSchema, review.text);
    } catch {
      verdict = review.ok
        ? { verdict: "approve", feedback: "" }
        : { verdict: "changes", feedback: `Review failed: ${review.error ?? "unknown"}` };
      if (review.ok) this.board.log("warn", `${ids}: review output unreadable; approving`, { ticketId: t.id });
    }
    this.board.updateAgent(IDS.techLead, {
      activity: `Reviewed ${ids}: ${verdict.verdict === "approve" ? "approved" : "changes requested"}`,
    });
    if (verdict.verdict === "changes") return this.sendBack(a, verdict.feedback || "Changes requested.");

    // Merge
    const merged = await repo.merge(t.id, `Merge ${ids}: ${tickets.map((x) => x.title).join("; ")}`);
    if (!merged.ok) return this.sendBack(a, `Merge conflict with main: ${merged.error}`, { penalty: 0 });

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
        { [path]: `${repo.readMain(path).trimEnd()}\n- ${report.notes.trim()} _(${ids}, recorded by ${lead})_\n` },
        `${lead}: owner notes for ${ids}`,
      );
    }

    await repo.closeWorktree(t.id, true);
    this.board.releaseLease(t.id);
    for (const x of tickets) this.board.moveTicket(x.id, "done", { feedback: undefined });
    this.board.updateAgent(a.agentId, { status: "idle", currentTicket: undefined, activity: `Shipped ${ids}` });
    this.board.log("info", `${ids} merged: ${tickets.map((x) => x.title).join("; ")}`, { ticketId: t.id, agentId: a.agentId });

    // The CFO scores the delivery: cost against budget, and whether it passed first time.
    const spent = a.batch.reduce((n, id) => n + (this.board.ticket(id).buildSpendUsd ?? 0), 0);
    const ratio = allotted > 0 ? spent / allotted : 0;
    const firstPass = tickets.every((x) => x.attempts === 0);
    const points = deliveryPoints(firstPass, ratio);
    this.score(a.agentId, points, {
      delivered: tickets.length,
      firstPass: firstPass ? 1 : 0,
      onBudget: ratio <= 1 ? 1 : 0,
      overruns: ratio > 1 ? 1 : 0,
    }, `${ids} merged${firstPass ? " first pass" : ""} at ${Math.round(ratio * 100)}% of its $${allotted.toFixed(2)} budget`);
    this.mergeCount++;
    this.liftBenches();
    this.checkBudget();
  }

  /**
   * A failed or rejected attempt. The owner gets the early attempts; the
   * last one is escalated to the tech lead with the full failure history.
   * If that fails too, the CEO decides: retry with guidance, or skip.
   * A rejected batch splits back into single tickets for the retry.
   */
  private async sendBack(
    a: Assignment,
    feedback: string,
    opts: { discardBranch?: boolean; penalty?: number; cutOff?: boolean } = {},
  ): Promise<void> {
    const batched = a.batch.length > 1;
    await this.repo!.closeWorktree(a.ticketId, opts.discardBranch || batched).catch(() => undefined);
    this.board.releaseLease(a.ticketId);
    this.board.updateAgent(a.agentId, { status: "idle", currentTicket: undefined, activity: `Sent back ${a.batch.join(", ")}` });

    const penalty = opts.penalty ?? POINTS.sentBack;
    if (penalty !== 0) {
      this.score(
        a.agentId,
        penalty,
        opts.cutOff ? { overruns: 1, reworks: 1 } : { reworks: 1 },
        `${a.batch.join(" + ")} ${opts.cutOff ? "cut off for overspending" : "sent back"}`,
      );
    }
    if (batched) {
      this.board.log("info", `Batch ${a.batch.join(" + ")} split back into single tickets for the retry`, {
        ticketId: a.ticketId,
      });
    }

    for (const id of a.batch) {
      const t = this.board.ticket(id);
      const attempts = t.attempts + 1;
      const failures = [...(t.failures ?? []), feedback];
      const meta = { ticketId: t.id, agentId: a.agentId };
      const common = { attempts, feedback, failures, assignee: undefined, batchWith: undefined, noBatch: batched || t.noBatch };

      if (attempts >= this.cfg.maxAttempts) {
        this.board.moveTicket(t.id, "failed", { ...common, escalated: false });
        this.board.log("error", `${t.id} failed after ${attempts} attempts: ${feedback}`, meta);
        this.askCeoAboutFailure(t.id);
        continue;
      }
      const escalate = attempts === this.cfg.maxAttempts - 1;
      this.board.moveTicket(t.id, "ready", { ...common, escalated: escalate });
      this.board.log("warn", `${t.id} sent back: ${feedback}`, meta);
      if (escalate) this.board.log("info", `${t.id} escalated to the tech lead for its last attempt`, meta);
    }
  }

  // ---- CFO -------------------------------------------------------------

  /** Record a scored event for an engineer and update its standing. */
  private score(agentId: string, points: number, counts: Partial<Omit<Scorecard, "recent">>, reason: string): void {
    const agent = this.board.agent(agentId);
    if (agent.role !== "engineer") return; // the tech lead's escalations aren't scored
    const card = addEvent(agent.score ?? emptyScorecard(), points, counts);
    const was = agent.standing ?? "normal";
    let standing = standingFor(card.recent);
    let benchedUntilMerges = agent.benchedUntilMerges;
    if (was === "benched" && benchedUntilMerges !== undefined && this.mergeCount < benchedUntilMerges) {
      standing = "benched"; // the bench runs its course
    } else if (standing === "benched") {
      benchedUntilMerges = this.mergeCount + BENCH_MERGES;
    }
    this.board.updateAgent(agentId, { score: card, standing, benchedUntilMerges });
    const sign = points > 0 ? `+${points}` : `${points}`;
    this.board.log(points < 0 ? "warn" : "info", `CFO ${sign} to ${agent.name}: ${reason}`, { agentId: IDS.cfo });
    if (standing !== was) {
      const msg = {
        trusted: "now trusted: first pick of big tickets and more budget headroom",
        normal: "back to normal standing",
        watch: "on watch: smaller tickets, a tight spend cap and a warning in its next prompt",
        benched: `benched until ${BENCH_MERGES} more merges land; others take its work`,
      }[standing];
      this.board.log(standing === "trusted" || standing === "normal" ? "info" : "warn", `CFO: ${agent.name} is ${msg}`, {
        agentId: IDS.cfo,
      });
    }
  }

  /** Benched engineers come back on watch once enough merges have landed. */
  private liftBenches(): void {
    for (const agent of this.board.agents) {
      if (agent.standing === "benched" && (agent.benchedUntilMerges ?? 0) <= this.mergeCount) {
        const card = { ...(agent.score ?? emptyScorecard()), recent: [POINTS.sentBack * 2] };
        this.board.updateAgent(agent.id, { standing: "watch", score: card, benchedUntilMerges: undefined });
        this.board.log("info", `CFO: ${agent.name} is off the bench, on watch`, { agentId: IDS.cfo });
      }
    }
  }

  /** What the CFO tells an engineer about its recent record, in its prompt. */
  private trackRecordNote(agent: Agent): string | undefined {
    const card = agent.score;
    if (!card || card.recent.length === 0) return undefined;
    const bad = card.recent.filter((p) => p < 0).length;
    if (agent.standing === "watch" || agent.standing === "benched") {
      return `ON WATCH. ${bad} of your last ${card.recent.length} scored tickets went over budget, were sent back or had bugs \
traced to them. Your spend cap is tight on this one. Make the smallest correct change and verify it before you finish.`;
    }
    if (agent.standing === "trusted") {
      return "TRUSTED. Strong recent record on cost and quality; you have extra budget headroom. Keep the same standard.";
    }
    return undefined;
  }

  /** Split the ticket budget pool by size, keeping a reserve for reviews, QA and retries. */
  /**
   * Budget tickets by size. The first plan sets the price of a budget unit
   * from the project budget (keeping a reserve for reviews, QA and retries);
   * tickets added later (QA bugs, change requests) are priced at the same
   * rate, so a small change can't claim the whole pot.
   */
  private allocateBudgets(): void {
    const p = this.board.project!;
    const unbudgeted = this.board.tickets.filter((t) => t.budgetUsd === undefined && !["done", "skipped"].includes(t.status));
    if (unbudgeted.length === 0) return;
    const first = this.unitUsd === 0;
    if (first) this.unitUsd = unitPrice(p.budgetUsd - p.spentUsd, unbudgeted.map((t) => t.size));
    for (const t of unbudgeted) this.board.updateTicket(t.id, { budgetUsd: unitsOf(t.size) * this.unitUsd });
    const total = unbudgeted.reduce((n, t) => n + unitsOf(t.size) * this.unitUsd, 0);
    const price = (sz: "S" | "M" | "L") => `${sz} $${(unitsOf(sz) * this.unitUsd).toFixed(2)}`;
    this.board.log(
      "info",
      first
        ? `CFO allocated $${total.toFixed(2)} across ${unbudgeted.length} tickets by size (${price("S")}, ${price("M")}, ${price("L")}), ` +
            `keeping $${(p.budgetUsd - p.spentUsd - total).toFixed(2)} for reviews, QA and retries`
        : `CFO budgeted ${unbudgeted.length} new ticket(s) at the plan's rates: $${total.toFixed(2)}`,
      { agentId: IDS.cfo },
    );
  }

  /** After a budget top-up, scale the rate and every open ticket's budget with it. */
  private rescaleBudgets(factor: number): void {
    this.unitUsd *= factor;
    for (const t of this.board.tickets) {
      if (t.budgetUsd !== undefined && !["done", "skipped"].includes(t.status)) {
        this.board.updateTicket(t.id, { budgetUsd: t.budgetUsd * factor });
      }
    }
    this.board.log("info", `CFO raised open ticket budgets by ${Math.round((factor - 1) * 100)}% with the new money`, { agentId: IDS.cfo });
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
    ticketIds: string[] = [],
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
    if (ticketIds.length === 0) this.board.addSpend(agentId, res.costUsd);
    for (const id of ticketIds) this.board.addSpend(agentId, res.costUsd / ticketIds.length, id);
    this.checkBudget();
    if (!opts.keepStatus && task.kind !== "build") {
      const finished = {
        prd: "Handed in the PRD",
        brand: "Proposed the brand",
        design: "Handed in the design",
        feasibility: "Reviewed the design for feasibility",
        architecture: "Handed in the architecture",
        tickets: "Filed the tickets",
        launch: "Wrote the launch copy",
        review: "",
        build: "",
        qa: "",
      }[task.kind];
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
          const before = p.budgetUsd;
          this.board.updateProject({ phase: "building", budgetUsd: before + this.cfg.budgetUsd });
          this.rescaleBudgets((before + this.cfg.budgetUsd) / before);
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

/** A product's name from its README's first heading, else its folder name. */
function productName(dir: string): string {
  const readme = existsSync(join(dir, "README.md")) ? readFileSync(join(dir, "README.md"), "utf8") : "";
  const heading = readme.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || basename(dir).replace(/-[a-z0-9]{6,9}$/, "");
}

/** The brand saved by an earlier run, if it parses and its logo is usable. */
function savedBrand(json: string): BrandPlan | undefined {
  if (!json.trim()) return undefined;
  try {
    const plan = BrandSchema.parse(JSON.parse(json));
    return { ...plan, logoSvg: safeSvg(plan.logoSvg) ?? monogramLogo(plan.name, plan.palette[0]?.hex) };
  } catch {
    return undefined;
  }
}

/** Fallback tokens when the designer gave none: the brand colors as custom properties. */
function tokensFromBrand(palette: { name: string; hex: string }[]): string {
  const colors = palette.map((c) => `  --color-${slugify(c.name)}: ${c.hex};`).join("\n");
  return `:root {\n${colors}${colors ? "\n" : ""}  --space-1: 4px;\n  --space-2: 8px;\n  --space-3: 16px;\n  --radius: 8px;\n  --font-body: system-ui, sans-serif;\n}`;
}

/** Ownership areas saved by an earlier run, if they parse. */
function savedAreas(json: string): Architecture | undefined {
  if (!json.trim()) return undefined;
  try {
    return ArchitectureSchema.parse(JSON.parse(json));
  } catch {
    return undefined;
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
