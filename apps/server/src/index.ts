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
  type AgentRunner,
  type BoardEvent,
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
  idea: z.string().min(3),
  name: z.string().optional(),
  runner: z.enum(["mock", "claude"]).optional(),
  model: z.string().optional(),
  engineersPerArea: z.number().int().min(1).max(6).optional(),
  floaters: z.number().int().min(0).max(6).optional(),
  budgetUsd: z.number().positive().max(1000).optional(),
});

function makeRunner(kind: "mock" | "claude", model: string, budgetUsd: number): AgentRunner {
  if (kind === "mock") {
    // MOCK_FAIL="App shell" makes that demo ticket always fail, to try the failure flow.
    const failBuildsOf = process.env.MOCK_FAIL ? process.env.MOCK_FAIL.split(",") : [];
    return new MockRunner({ stepMs: 400, rejectFirstReviewOf: ["Notes CRUD API"], failBuildsOf, qaFindsBugOnce: true });
  }
  // Cap any single task at a quarter of the budget (min $0.50), so one
  // runaway agent can't blow through it before the CFO gate trips.
  // Escalated attempts (after repeated failures) use the next model up.
  const i = MODELS.findIndex((m) => m.id === model);
  const escalationModel = MODELS[Math.min(i + 1, MODELS.length - 1)]?.id ?? model;
  return new ClaudeRunner({
    model,
    escalationModel,
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
  c.json({ ...keyStatus(), models: MODELS, defaultModel: DEFAULT_MODEL, defaultRunner: DEFAULT_RUNNER }),
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

app.post("/api/projects", async (c) => {
  const body = StartSchema.parse(await c.req.json());
  if (orch?.isRunning) return c.json({ error: "A project is already running. Stop it first." }, 409);
  const kind = body.runner ?? DEFAULT_RUNNER;
  if (kind === "claude" && !currentKey()) {
    return c.json({ error: "Add your Anthropic API key to use Claude agents." }, 400);
  }
  const model = body.model ?? DEFAULT_MODEL;
  if (kind === "claude" && !MODELS.some((m) => m.id === model)) {
    return c.json({ error: `Unknown model "${model}".` }, 400);
  }
  const budgetUsd = body.budgetUsd ?? 20;
  runnerName = kind === "claude" ? `claude (${model})` : "mock";
  orch = new Orchestrator(
    makeRunner(kind, model, budgetUsd),
    {
      workspaceDir: WORKSPACE,
      engineersPerArea: body.engineersPerArea ?? 1,
      floaters: body.floaters ?? 1,
      budgetUsd,
    },
    board,
  );
  const project = orch.start(body.idea, body.name);
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
