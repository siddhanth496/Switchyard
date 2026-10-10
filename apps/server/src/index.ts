import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  Board,
  ClaudeRunner,
  MockRunner,
  Orchestrator,
  ProjectRepo,
  readHistory,
  summarizeHistory,
  type AgentRunner,
  type BoardEvent,
  type Role,
} from "@agentco/engine";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);
// Product repos live outside the Switchyard checkout by default, in the home
// folder itself, which iCloud doesn't sync (Desktop and Documents can be).
const WORKSPACE = resolve(process.env.WORKSPACE ?? join(homedir(), "switchyard-workspace"));
const ICLOUD_HINT =
  WORKSPACE.includes("/Library/Mobile Documents/") ||
  WORKSPACE.startsWith(join(homedir(), "Desktop")) ||
  WORKSPACE.startsWith(join(homedir(), "Documents"));
const DEFAULT_RUNNER = (process.env.RUNNER ?? "mock") as "mock" | "claude";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";

const board = new Board();
let orch: Orchestrator | null = null;
let runnerName: string = DEFAULT_RUNNER;

/** Models offered in the UI, cheapest first. */
const MODELS = [
  { id: "claude-haiku-5-5", label: "Haiku 5.5", hint: "Cheapest. Good for testing the flow." },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "Balanced cost and quality." },
  { id: "claude-opus-5-5", label: "Opus 5.5", hint: "Most capable. Costs the most." },
] as const;
const DEFAULT_MODEL = process.env.MODEL ?? "claude-haiku-5-5";

/** Roles that run on a model, in the order the UI lists them. The CFO and dispatcher are plain code. */
const MODEL_ROLES = ["pm", "marketing", "designer", "tech_lead", "task_creator", "engineer", "qa"] as const satisfies readonly Role[];
const ModelsSchema = z
  .record(z.enum(MODEL_ROLES), z.string())
  .superRefine((m, ctx) => {
    for (const [role, id] of Object.entries(m)) {
      if (!MODELS.some((x) => x.id === id)) ctx.addIssue({ code: "custom", message: `Unknown model "${id}" for ${role}.` });
    }
  });
type Models = Partial<Record<Role, string>>;
const MODEL_ROLE_INFO: { role: (typeof MODEL_ROLES)[number]; label: string; hint: string }[] = [
  { role: "pm", label: "PM", hint: "PRD and the design feasibility call" },
  { role: "marketing", label: "Marketing", hint: "Name, logo, voice, launch copy" },
  { role: "designer", label: "Designer", hint: "Design system, screens, screen reviews" },
  { role: "tech_lead", label: "Tech lead", hint: "Architecture, code reviews, escalations" },
  { role: "task_creator", label: "Task creator", hint: "Turns the plan into tickets" },
  { role: "engineer", label: "Engineers", hint: "Build the tickets: most of the spend" },
  { role: "qa", label: "QA", hint: "Tests the build" },
];

/** Every role on its model: the per-role choice, else the default. */
function fillModels(model: string, models: Models = {}): Models {
  return Object.fromEntries(MODEL_ROLES.map((r) => [r, models[r] ?? model]));
}

/** Escalated tickets (after repeated failures) run one tier above the engineers, and never below the tech lead. */
function escalationFor(models: Models): string {
  const tier = (id?: string) => Math.max(0, MODELS.findIndex((m) => m.id === id));
  const t = Math.max(Math.min(tier(models.engineer) + 1, MODELS.length - 1), tier(models.tech_lead));
  return MODELS[t]!.id;
}

/**
 * The API key lives only in this process's memory: never written to disk,
 * never logged, never returned to the browser beyond its last 4 characters.
 * A key from the environment is used unless the UI sets one.
 */
let uiKey: string | undefined;
const envKey = process.env.ANTHROPIC_API_KEY || undefined;
const currentKey = () => uiKey ?? envKey;

function keyStatus() {
  const key = currentKey();
  return {
    hasKey: !!key,
    keySource: uiKey ? "ui" : envKey ? "env" : null,
    keyHint: key ? key.slice(-4) : null,
  };
}

const StartSchema = z.object({
  idea: z.string().trim().default(""),
  /** With continueFrom: pick up the last run's unfinished tickets instead of a new request. */
  resume: z.boolean().optional(),
  /** Folder of an existing product (from GET /api/products) to change instead of starting fresh. */
  continueFrom: z.string().optional(),
  name: z.string().optional(),
  runner: z.enum(["mock", "claude"]).optional(),
  model: z.string().optional(),
  engineersPerArea: z.number().int().min(1).max(6).optional(),
  floaters: z.number().int().min(0).max(6).optional(),
  budgetUsd: z.number().positive().max(1000).optional(),
  /** Marketing names and brands the product (default on). */
  marketing: z.boolean().optional(),
  /** The designer drafts the design and the PM checks feasibility (default on). */
  design: z.boolean().optional(),
  /** Model per role; roles left out use `model`. */
  models: ModelsSchema.optional(),
});

function makeRunner(kind: "mock" | "claude", models: Models, budgetUsd: number): AgentRunner {
  if (kind === "mock") {
    // MOCK_FAIL="App shell" makes that demo ticket always fail, to try the failure flow.
    const failBuildsOf = process.env.MOCK_FAIL ? process.env.MOCK_FAIL.split(",") : [];
    return new MockRunner({ stepMs: 400, rejectFirstReviewOf: ["Notes CRUD API"], failBuildsOf, qaFindsBugOnce: true, pmPushesBackDesign: "once", designFindsIssueOnce: true });
  }
  // Cap any single task at a quarter of the budget (min $0.50), so one
  // runaway agent can't blow through it before the CFO gate trips.
  return new ClaudeRunner({
    model: models.engineer,
    models,
    escalationModel: escalationFor(models),
    apiKey: currentKey(),
    maxBudgetUsdPerTask: Math.max(0.5, budgetUsd / 4),
  });
}

const app = new Hono();
app.use("/api/*", cors({ origin: WEB_ORIGIN, allowMethods: ["GET", "POST", "PUT", "DELETE"] }));

app.onError((err, c) => {
  const message = err instanceof z.ZodError ? (err.issues[0]?.message ?? "Invalid request") : err.message;
  return c.json({ error: message }, 400);
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/config", (c) =>
  c.json({ ...keyStatus(), models: MODELS, modelRoles: MODEL_ROLE_INFO, defaultModel: DEFAULT_MODEL, defaultRunner: DEFAULT_RUNNER }),
);

app.put("/api/config/key", async (c) => {
  const { key } = z
    .object({ key: z.string().trim().regex(/^sk-ant-[A-Za-z0-9_-]{20,}$/, "That doesn't look like an Anthropic API key (sk-ant-...).") })
    .parse(await c.req.json());
  uiKey = key;
  return c.json(keyStatus());
});

app.delete("/api/config/key", (c) => {
  uiKey = undefined;
  return c.json(keyStatus());
});

app.get("/api/state", (c) =>
  c.json({ ...board.snapshot(), running: orch?.isRunning ?? false, runner: runnerName }),
);

app.get("/api/events", (c) =>
  streamSSE(c, async (stream) => {
    const queue: BoardEvent[] = [];
    let notify: (() => void) | null = null;
    const off = board.on((e) => {
      queue.push(e);
      notify?.();
    });
    stream.onAbort(() => {
      off();
      notify?.();
    });

    await stream.writeSSE({
      event: "snapshot",
      data: JSON.stringify({ ...board.snapshot(), running: orch?.isRunning ?? false, runner: runnerName }),
    });

    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15_000);
    try {
      while (!stream.aborted) {
        while (queue.length > 0) {
          const e = queue.shift()!;
          await stream.writeSSE({ event: "board", data: JSON.stringify(e) });
        }
        await new Promise<void>((r) => (notify = r));
        notify = null;
      }
    } finally {
      clearInterval(ping);
      off();
    }
  }),
);

/** Products built earlier, newest first, so the CEO can continue one. */
app.get("/api/products", (c) => {
  if (!existsSync(WORKSPACE)) return c.json({ products: [] });
  const products = readdirSync(WORKSPACE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.endsWith(".worktrees"))
    .map((d) => join(WORKSPACE, d.name))
    .filter((dir) => ProjectRepo.isRepo(dir))
    .map((dir) => {
      const readme = existsSync(join(dir, "README.md")) ? readFileSync(join(dir, "README.md"), "utf8") : "";
      const name = readme.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? dir.split("/").pop()!;
      let updatedAt = 0;
      let commits = 0;
      try {
        updatedAt = Number(execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: dir, encoding: "utf8" }).trim()) * 1000;
        commits = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir, encoding: "utf8" }).trim());
      } catch {
        /* an empty repo */
      }
      const history = readHistory(dir);
      return {
        dir,
        folder: dir.split("/").pop()!,
        name,
        updatedAt: Math.max(updatedAt, history?.savedAt ?? 0),
        commits,
        hasPrd: existsSync(join(dir, "docs/PRD.md")),
        // Where the last run left off, for the start screen.
        last: history ? summarizeHistory(history) : undefined,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return c.json({ products, workspace: WORKSPACE });
});

app.post("/api/projects", async (c) => {
  const body = StartSchema.parse(await c.req.json());
  if (!(body.resume && body.continueFrom) && body.idea.length < 3) {
    return c.json({ error: body.continueFrom ? "Describe what should change." : "Describe the product in a sentence or two." }, 400);
  }
  if (orch?.isRunning) {
    const stopping = board.project?.phase === "stopped";
    return c.json({ error: stopping ? "The last project is still stopping. Try again in a few seconds." : "A project is already running. Stop it first." }, 409);
  }
  const kind = body.runner ?? DEFAULT_RUNNER;
  if (kind === "claude" && !currentKey()) {
    return c.json({ error: "Add your Anthropic API key to use Claude agents." }, 400);
  }
  const model = body.model ?? DEFAULT_MODEL;
  if (kind === "claude" && !MODELS.some((m) => m.id === model)) {
    return c.json({ error: `Unknown model "${model}".` }, 400);
  }
  let existingDir: string | undefined;
  if (body.continueFrom) {
    existingDir = resolve(body.continueFrom);
    if (!existingDir.startsWith(WORKSPACE + "/") || !ProjectRepo.isRepo(existingDir)) {
      return c.json({ error: "That product isn't in the workspace." }, 400);
    }
  }
  const models = fillModels(model, body.models);
  const budgetUsd = body.budgetUsd ?? 20;
  runnerName = kind === "claude" ? "claude" : "mock";
  orch = new Orchestrator(
    makeRunner(kind, models, budgetUsd),
    {
      workspaceDir: WORKSPACE,
      engineersPerArea: body.engineersPerArea ?? 1,
      floaters: body.floaters ?? 1,
      budgetUsd,
      marketing: body.marketing ?? true,
      design: body.design ?? true,
      ...(kind === "claude" ? { models } : {}),
    },
    board,
  );
  const project = orch.start(body.idea, body.name, { existingDir, resume: body.resume });
  return c.json({ project, runner: runnerName }, 201);
});

function requireOrch(): Orchestrator {
  if (!orch) throw new Error("No project has been started");
  return orch;
}

app.post("/api/gates/:id/approve", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { feedback?: string };
  return c.json(requireOrch().approve(c.req.param("id"), body.feedback));
});

app.post("/api/gates/:id/reject", async (c) => {
  const id = c.req.param("id");
  const gate = board.gate(id);
  // Skipping a failed ticket needs no explanation; sending other work back does.
  const schema = z.object({ feedback: gate.kind === "ticket_failed" ? z.string().default("Skipped") : z.string().min(1, "Say what should change.") });
  const { feedback } = schema.parse(await c.req.json().catch(() => ({})));
  return c.json(requireOrch().reject(id, feedback));
});

app.post("/api/tickets/:id/retry", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { guidance?: string };
  return c.json(requireOrch().retry(c.req.param("id"), body.guidance));
});

app.post("/api/tickets/:id/skip", (c) => c.json(requireOrch().skip(c.req.param("id"))));

// ---- CEO controls during the build ----------------------------------------

app.post("/api/pause", (c) => {
  requireOrch().pause();
  return c.json({ ok: true });
});

app.post("/api/resume", (c) => {
  requireOrch().resume();
  return c.json({ ok: true });
});

app.post("/api/brief", async (c) => {
  const { idea } = z.object({ idea: z.string().trim().min(3, "Write the new brief.") }).parse(await c.req.json());
  // Checks throw at once; replanning carries on in the background.
  requireOrch().reviseBrief(idea).catch((err: Error) => board.log("warn", `Couldn't apply the new brief: ${err.message}`));
  return c.json({ ok: true }, 202);
});

app.post("/api/changes", async (c) => {
  const { request } = z.object({ request: z.string().trim().min(3, "Say what should change.") }).parse(await c.req.json());
  const o = requireOrch();
  // Answer at once; the task creator files the tickets in the background.
  o.requestChange(request).catch((err: Error) => board.log("warn", `Couldn't file the change: ${err.message}`));
  return c.json({ ok: true }, 202);
});

app.put("/api/models", async (c) => {
  const { models } = z.object({ models: ModelsSchema }).parse(await c.req.json());
  if (runnerName !== "claude") return c.json({ error: "Demo agents don't use models." }, 400);
  const all = fillModels(DEFAULT_MODEL, { ...board.project?.models, ...models });
  requireOrch().setModels(all, escalationFor(all));
  return c.json({ models: all });
});

app.post("/api/tickets/:id/prioritize", (c) => c.json(requireOrch().prioritize(c.req.param("id"))));

app.post("/api/tickets/:id/note", async (c) => {
  const { note, redo } = z
    .object({ note: z.string().trim().default(""), redo: z.boolean().default(false) })
    .parse(await c.req.json().catch(() => ({})));
  if (!note && !redo) return c.json({ error: "Write a note first." }, 400);
  return c.json(requireOrch().addNote(c.req.param("id"), note, { redo }));
});

app.post("/api/tickets/:id/cancel", (c) => c.json(requireOrch().cancel(c.req.param("id"))));

app.post("/api/stop", (c) => {
  requireOrch().stop();
  return c.json({ ok: true });
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Agent Company server on http://localhost:${PORT}`);
  console.log(`  runner: ${DEFAULT_RUNNER} (set RUNNER=claude for real agents)`);
  console.log(`  API key: ${envKey ? "from ANTHROPIC_API_KEY" : "not set (add it in the UI)"}`);
  console.log(`  workspace: ${WORKSPACE}`);
  if (ICLOUD_HINT) {
    console.warn(
      "  warning: the workspace may be synced by iCloud Drive. Syncing a folder that agents change fast\n" +
        '  creates "file 2" duplicates and corrupts git. Set WORKSPACE to a folder outside Desktop/Documents.',
    );
  }
});
