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
  MockRunner,
  Orchestrator,
  ProjectRepo,
  GEMINI_PRICES,
  RoutedRunner,
  providerOf,
  readHistory,
  summarizeHistory,
  type AgentRunner,
  type BoardEvent,
  type Provider,
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

type ModelInfo = { id: string; label: string; hint: string; provider: Provider };
/**
 * Models offered in the UI: each provider's, cheapest first. The Gemini
 * entries are only a fallback: once a Gemini key is set, the list is
 * replaced by the models Google says that key can use (see loadGeminiModels).
 */
let MODELS: ModelInfo[] = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Claude's cheapest. Good for testing the flow.", provider: "anthropic" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Balanced cost and quality.", provider: "anthropic" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Claude's most capable. Costs the most.", provider: "anthropic" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", hint: "Gemini's cheapest: $0.25 in / $1.50 out per million tokens.", provider: "gemini" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Cheap and steady: $0.30 in / $2.50 out per million tokens.", provider: "gemini" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "Fast and strong: $1.50 in / $9 out per million tokens.", provider: "gemini" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", hint: "Gemini's most capable: $2 in / $12 out per million tokens.", provider: "gemini" },
];
const PROVIDERS: { id: Provider; label: string; keyLabel: string; placeholder: string; help: string }[] = [
  { id: "anthropic", label: "Claude", keyLabel: "Anthropic API key", placeholder: "sk-ant-...", help: "Create one at console.anthropic.com under API Keys." },
  {
    id: "gemini",
    label: "Gemini",
    keyLabel: "Gemini API key",
    placeholder: "AIza...",
    help: "Create one at aistudio.google.com/apikey. Free-tier keys work but have low rate limits; agents will wait and retry.",
  },
];
const DEFAULT_MODEL = process.env.MODEL ?? "claude-haiku-5-5";

/** Roles that run on a model, in the order the UI lists them. The CFO and dispatcher are plain code. */
const MODEL_ROLES = ["pm", "marketing", "designer", "tech_lead", "task_creator", "engineer", "qa"] as const satisfies readonly Role[];
const ModelsSchema = z
  .partialRecord(z.enum(MODEL_ROLES), z.string())
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

/**
 * Escalated tickets (after repeated failures) run one tier above the
 * engineers, within the engineers' provider, and never below the tech lead
 * when the tech lead is on that provider too.
 */
function escalationFor(models: Models): string {
  const provider = providerOf(models.engineer ?? DEFAULT_MODEL);
  const ladder = MODELS.filter((m) => m.provider === provider);
  const tier = (id?: string) => Math.max(0, ladder.findIndex((m) => m.id === id));
  const lead = models.tech_lead && providerOf(models.tech_lead) === provider ? tier(models.tech_lead) : 0;
  return ladder[Math.max(Math.min(tier(models.engineer) + 1, ladder.length - 1), lead)]!.id;
}

/** The providers a set of models needs keys for. */
function providersOf(models: Models): Provider[] {
  return [...new Set([...Object.values(models), escalationFor(models)].map((m) => providerOf(m!)))];
}

/**
 * The API key lives only in this process's memory: never written to disk,
 * never logged, never returned to the browser beyond its last 4 characters.
 * A key from the environment is used unless the UI sets one.
 */
const uiKeys: Partial<Record<Provider, string>> = {};
const envKeys: Partial<Record<Provider, string>> = {
  anthropic: process.env.ANTHROPIC_API_KEY || undefined,
  gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined,
};
const currentKey = (p: Provider) => uiKeys[p] ?? envKeys[p];
/** Tells a running company about a key added or replaced mid-run. */
let routed: RoutedRunner | null = null;

function keyStatus() {
  return {
    providers: PROVIDERS.map((p) => {
      const key = currentKey(p.id);
      return {
        ...p,
        hasKey: !!key,
        keySource: uiKeys[p.id] ? ("ui" as const) : envKeys[p.id] ? ("env" as const) : null,
        keyHint: key ? key.slice(-4) : null,
      };
    }),
  };
}

const KEY_SHAPE: Record<Provider, { test: (k: string) => boolean; message: string }> = {
  anthropic: { test: (k) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k), message: "That doesn't look like an Anthropic API key (sk-ant-...)." },
  gemini: {
    test: (k) => /^[A-Za-z0-9._-]{30,}$/.test(k) && !k.startsWith("sk-"),
    message: "That doesn't look like a Gemini API key (they usually start with AIza). Create one at aistudio.google.com/apikey.",
  },
};

const GEMINI_API_BASE = process.env.GEMINI_API_BASE ?? "https://generativelanguage.googleapis.com";
const CLAUDE_MODELS = MODELS.filter((m) => m.provider === "anthropic");
const FALLBACK_GEMINI = MODELS.filter((m) => m.provider === "gemini");
/** True once the Gemini list came from Google for the current key. */
let geminiListed = false;

/** Gemini models that aren't for agent work: other media, live audio, special-purpose. */
const NOT_FOR_AGENTS = /image|tts|audio|live|embedding|robotics|computer-use|customtools|aqa|learnlm|imagen|veo|lyria|gemma/;

function geminiHint(id: string): string {
  const price = GEMINI_PRICES[id];
  return price
    ? `$${price.in} in / $${price.out} out per million tokens.`
    : "Price not in Switchyard's table yet, so spend is counted at a high rate ($4 in / $18 out per million). Check Google's pricing page.";
}

/**
 * Ask Google which models this key can use (a free call), and offer exactly
 * those: model ids change often and differ by account, so a fixed list goes
 * stale. "invalid" means Google rejected the key; "unverified" means Google
 * couldn't be reached, so the key is kept and the fallback list is shown.
 */
async function loadGeminiModels(key: string): Promise<"ok" | "invalid" | "unverified"> {
  try {
    const found: ModelInfo[] = [];
    let pageToken = "";
    do {
      const res = await fetch(`${GEMINI_API_BASE}/v1beta/models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`, {
        headers: { "x-goog-api-key": key },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return res.status === 400 || res.status === 401 || res.status === 403 ? "invalid" : "unverified";
      const page = (await res.json()) as {
        models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
        nextPageToken?: string;
      };
      for (const m of page.models ?? []) {
        const id = m.name.replace(/^models\//, "");
        if (!id.startsWith("gemini-") || NOT_FOR_AGENTS.test(id)) continue;
        if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
        if (/-\d{3}$|-\d{2}-\d{2,4}$|-latest$/.test(id)) continue; // dated snapshots and aliases of models already listed
        found.push({ id, label: m.displayName ?? id, hint: geminiHint(id), provider: "gemini" });
      }
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    if (found.length === 0) return "unverified";
    // Cheapest first; models without a known price last, by name.
    const cost = (m: ModelInfo) => GEMINI_PRICES[m.id]?.out ?? Infinity;
    found.sort((a, b) => cost(a) - cost(b) || a.id.localeCompare(b.id));
    MODELS = [...CLAUDE_MODELS, ...found];
    geminiListed = true;
    return "ok";
  } catch {
    return "unverified";
  }
}

function forgetGeminiModels(): void {
  MODELS = [...CLAUDE_MODELS, ...FALLBACK_GEMINI];
  geminiListed = false;
}
if (envKeys.gemini) void loadGeminiModels(envKeys.gemini);

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
  routed = new RoutedRunner({
    model: models.engineer ?? DEFAULT_MODEL,
    models,
    escalationModel: escalationFor(models),
    anthropicKey: currentKey("anthropic"),
    geminiKey: currentKey("gemini"),
    maxBudgetUsdPerTask: Math.max(0.5, budgetUsd / 4),
  });
  return routed;
}

/** An error naming the first provider these models need a key for, if any is missing. */
function missingKey(models: Models): string | null {
  const p = providersOf(models).find((id) => !currentKey(id));
  if (!p) return null;
  const info = PROVIDERS.find((x) => x.id === p)!;
  const roles = MODEL_ROLE_INFO.filter((r) => models[r.role] && providerOf(models[r.role]!) === p).map((r) => r.label);
  return `Add your ${info.keyLabel}: ${roles.length ? `${roles.join(", ")} ${roles.length === 1 ? "is" : "are"} set to a ${info.label} model` : `escalated tickets use a ${info.label} model`}.`;
}

const app = new Hono();
app.use("/api/*", cors({ origin: WEB_ORIGIN, allowMethods: ["GET", "POST", "PUT", "DELETE"] }));

app.onError((err, c) => {
  const message = err instanceof z.ZodError ? (err.issues[0]?.message ?? "Invalid request") : err.message;
  return c.json({ error: message }, 400);
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/config", (c) =>
  c.json({
    ...keyStatus(),
    models: MODELS,
    /** False while the Gemini models shown are a guess, not what the key can really use. */
    geminiListed,
    modelRoles: MODEL_ROLE_INFO,
    defaultModel: DEFAULT_MODEL,
    defaultRunner: DEFAULT_RUNNER,
  }),
);

const ProviderSchema = z.enum(["anthropic", "gemini"]).default("anthropic");

app.put("/api/config/key", async (c) => {
  const { key, provider } = z.object({ key: z.string().trim(), provider: ProviderSchema }).parse(await c.req.json());
  if (!KEY_SHAPE[provider].test(key)) return c.json({ error: KEY_SHAPE[provider].message }, 400);
  let verified: boolean | undefined;
  if (provider === "gemini") {
    const check = await loadGeminiModels(key);
    if (check !== "ok") forgetGeminiModels();
    if (check === "invalid") return c.json({ error: "Google rejected that Gemini API key. Check it was copied in full and is enabled for the Gemini API." }, 400);
    verified = check === "ok";
  }
  uiKeys[provider] = key;
  routed?.setKeys({ anthropicKey: currentKey("anthropic"), geminiKey: currentKey("gemini") });
  return c.json({ ...keyStatus(), verified, models: MODELS });
});

app.delete("/api/config/key", async (c) => {
  const provider = ProviderSchema.parse(c.req.query("provider"));
  delete uiKeys[provider];
  if (provider === "gemini") {
    forgetGeminiModels();
    if (envKeys.gemini) await loadGeminiModels(envKeys.gemini);
  }
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
  const model = body.model ?? DEFAULT_MODEL;
  if (kind === "claude") {
    if (!MODELS.some((m) => m.id === model)) return c.json({ error: `Unknown model "${model}".` }, 400);
    const missing = missingKey(fillModels(model, body.models));
    if (missing) return c.json({ error: missing }, 400);
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
  const missing = missingKey(all);
  if (missing) return c.json({ error: missing }, 400);
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

app.post("/api/retry", (c) => {
  requireOrch().retryPlan();
  return c.json({ ok: true });
});

app.post("/api/stop", (c) => {
  requireOrch().stop();
  return c.json({ ok: true });
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Agent Company server on http://localhost:${PORT}`);
  console.log(`  runner: ${DEFAULT_RUNNER} (set RUNNER=claude for real agents)`);
  console.log(`  Anthropic key: ${envKeys.anthropic ? "from ANTHROPIC_API_KEY" : "not set (add it in the UI)"}`);
  console.log(`  Gemini key: ${envKeys.gemini ? "from GEMINI_API_KEY" : "not set (add it in the UI)"}`);
  console.log(`  workspace: ${WORKSPACE}`);
  if (ICLOUD_HINT) {
    console.warn(
      "  warning: the workspace may be synced by iCloud Drive. Syncing a folder that agents change fast\n" +
        '  creates "file 2" duplicates and corrupts git. Set WORKSPACE to a folder outside Desktop/Documents.',
    );
  }
});
