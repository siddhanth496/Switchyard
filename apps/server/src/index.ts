import { resolve, dirname } from "node:path";
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
const WORKSPACE = resolve(process.env.WORKSPACE ?? resolve(here, "../../../workspace"));
const DEFAULT_RUNNER = (process.env.RUNNER ?? "mock") as "mock" | "claude";
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";

const board = new Board();
let orch: Orchestrator | null = null;
let runnerName: string = DEFAULT_RUNNER;

const StartSchema = z.object({
  idea: z.string().min(3),
  name: z.string().optional(),
  runner: z.enum(["mock", "claude"]).optional(),
  model: z.string().optional(),
  engineersPerArea: z.number().int().min(1).max(6).optional(),
  floaters: z.number().int().min(0).max(6).optional(),
  budgetUsd: z.number().positive().optional(),
});

function makeRunner(kind: "mock" | "claude", model?: string): AgentRunner {
  return kind === "claude"
    ? new ClaudeRunner({ model })
    : new MockRunner({ stepMs: 400, rejectFirstReviewOf: ["Notes CRUD API"] });
}

const app = new Hono();
app.use("/api/*", cors({ origin: WEB_ORIGIN }));

app.onError((err, c) => c.json({ error: err.message }, 400));

app.get("/api/health", (c) => c.json({ ok: true }));

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
  runnerName = body.runner ?? DEFAULT_RUNNER;
  orch = new Orchestrator(
    makeRunner(runnerName as "mock" | "claude", body.model),
    {
      workspaceDir: WORKSPACE,
      engineersPerArea: body.engineersPerArea ?? 1,
      floaters: body.floaters ?? 1,
      budgetUsd: body.budgetUsd ?? 20,
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
  const { feedback } = z.object({ feedback: z.string().min(1) }).parse(await c.req.json());
  return c.json(requireOrch().reject(c.req.param("id"), feedback));
});

app.post("/api/tickets/:id/retry", (c) => c.json(requireOrch().retry(c.req.param("id"))));

app.post("/api/stop", (c) => {
  requireOrch().stop();
  return c.json({ ok: true });
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Agent Company server on http://localhost:${PORT}`);
  console.log(`  runner: ${DEFAULT_RUNNER} (set RUNNER=claude for real agents)`);
  console.log(`  workspace: ${WORKSPACE}`);
});
