import { GoogleGenAI } from "@google/genai";
import type { Role } from "../core/types.js";
import type { ActivityListener, AgentResult, AgentRunner, AgentTask } from "./runner.js";
import { TOOLS, runTool } from "./tools.js";

/**
 * USD per million tokens (input, output), paid tier, from
 * ai.google.dev/gemini-api/docs/pricing as of November 2026. The Pro
 * models cost more above 200k prompt tokens; `long` is that rate. Thinking
 * tokens are billed as output. Update this table when Google's prices
 * change: the CFO's budgets are only as right as these numbers.
 */
export const GEMINI_PRICES: Record<string, { in: number; out: number; long?: { in: number; out: number } }> = {
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-3-flash-preview": { in: 0.5, out: 3 },
  "gemini-2.5-pro": { in: 1.25, out: 10, long: { in: 2.5, out: 15 } },
  "gemini-3.5-flash": { in: 1.5, out: 9 },
  "gemini-3.1-pro-preview": { in: 2, out: 12, long: { in: 4, out: 18 } },
};
/** A model not in the table is priced as the most expensive one, so spend is never under-counted. */
const UNKNOWN_PRICE = { in: 4, out: 18 };

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}

export function geminiCost(model: string, usage: GeminiUsage | undefined): number {
  if (!usage) return 0;
  const base: (typeof GEMINI_PRICES)[string] = GEMINI_PRICES[model] ?? UNKNOWN_PRICE;
  const input = usage.promptTokenCount ?? 0;
  const price = base.long && input > 200_000 ? base.long : base;
  const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  return (input * price.in + output * price.out) / 1_000_000;
}

/** One part of a message: text, a tool call, or a tool's result. */
export interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  [k: string]: unknown;
}
export interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}
export interface GeminiRequest {
  model: string;
  system: string;
  contents: GeminiContent[];
  tools: { name: string; description: string; parametersJsonSchema: unknown }[];
  signal?: AbortSignal;
}
export interface GeminiReply {
  /** The model's message, passed back unchanged on the next turn (it carries thought signatures). */
  content?: GeminiContent;
  usage?: GeminiUsage;
  finishReason?: string;
}
/** One call to the model. Injectable, so tests run without the network. */
export type GeminiGenerate = (req: GeminiRequest) => Promise<GeminiReply>;

export interface GeminiRunnerOptions {
  /** Gemini API key. Falls back to GEMINI_API_KEY in the environment. */
  apiKey?: string;
  model?: string;
  models?: Partial<Record<Role, string>>;
  escalationModel?: string;
  /** Per-task spend cap in USD. */
  maxBudgetUsdPerTask?: number;
  generate?: GeminiGenerate;
  /** Wait before retrying a rate-limited call, in ms (first retry; doubles after). */
  retryMs?: number;
}

/**
 * Runs agent tasks on Gemini models through the Gemini API. There is no
 * agent SDK to lean on here, so this is the loop itself: call the model,
 * run the tools it asks for inside the task's working directory, hand the
 * results back, and repeat until it answers in text. Spend is counted from
 * the token usage of every call and the task is cut off at its cap.
 */
export class GeminiRunner implements AgentRunner {
  readonly name = "gemini";
  private readonly generate: GeminiGenerate;

  constructor(private readonly options: GeminiRunnerOptions = {}) {
    this.generate = options.generate ?? sdkGenerate(options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
  }

  setModels(models: Partial<Record<Role, string>>, escalationModel?: string): void {
    this.options.models = { ...models };
    if (escalationModel) this.options.escalationModel = escalationModel;
  }

  modelFor(task: Pick<AgentTask, "role" | "escalated">): string | undefined {
    const own = this.options.models?.[task.role] ?? this.options.model;
    return task.escalated ? (this.options.escalationModel ?? own) : own;
  }

  run(task: AgentTask, onActivity: ActivityListener, signal?: AbortSignal): Promise<AgentResult> {
    return this.runModel(this.modelFor(task) ?? "gemini-2.5-flash", task, onActivity, signal);
  }

  async runModel(model: string, task: AgentTask, onActivity: ActivityListener, signal?: AbortSignal): Promise<AgentResult> {
    const tools = TOOLS.filter((t) => task.canWrite || !t.write).map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.parameters,
    }));
    const cap = capOf(task.budgetUsd, this.options.maxBudgetUsdPerTask);
    const maxTurns = task.maxTurns ?? (task.canWrite ? 40 : 12);
    const contents: GeminiContent[] = [{ role: "user", parts: [{ text: task.prompt }] }];
    let costUsd = 0;
    let text = "";
    let nudges = 0;

    try {
      for (let turn = 1; turn <= maxTurns; turn++) {
        if (signal?.aborted) return { ok: false, text, costUsd, error: "stopped" };
        const reply = await this.call({ model, system: task.systemPrompt, contents, tools, signal });
        costUsd += geminiCost(model, reply.usage);

        const parts = reply.content?.parts ?? [];
        const calls = parts.filter((p) => p.functionCall?.name);
        const said = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
        if (said) {
          text = said;
          onActivity(firstLine(said));
        }
        if (cap !== undefined && costUsd > cap) {
          return { ok: false, text, costUsd, error: "cut off at its spend cap", overBudget: true };
        }

        if (calls.length === 0) {
          if (said) return { ok: true, text: said, costUsd };
          // No text and no tool call: a blocked or malformed turn. Ask again, twice at most.
          if (++nudges > 2) {
            return { ok: false, text, costUsd, error: `the model returned nothing (${reply.finishReason ?? "no reason given"})` };
          }
          if (parts.length > 0) contents.push({ role: "model", parts });
          contents.push({ role: "user", parts: [{ text: "Carry on. Use a tool, or give your final answer." }] });
          continue;
        }

        contents.push({ role: "model", parts });
        const results: GeminiPart[] = [];
        for (const part of calls) {
          const call = part.functionCall!;
          onActivity(describeCall(call.name!, call.args));
          const output = signal?.aborted ? "Stopped." : await runTool(task.cwd, call.name!, call.args ?? {}, task.canWrite, signal);
          results.push({ functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name!, response: { output } } });
        }
        contents.push({ role: "user", parts: results });
      }
      return { ok: false, text, costUsd, error: `ran out of turns (${maxTurns})` };
    } catch (err) {
      if (signal?.aborted) return { ok: false, text, costUsd, error: "stopped" };
      return { ok: false, text, costUsd, error: explain(err) };
    }
  }

  /** One model call, retried when Google says to slow down or is briefly unavailable. */
  private async call(req: GeminiRequest): Promise<GeminiReply> {
    const wait = this.options.retryMs ?? 4000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.generate(req);
      } catch (err) {
        const status = statusOf(err);
        const retryable = status === 429 || status === 500 || status === 503;
        if (!retryable || attempt >= 3 || req.signal?.aborted) throw err;
        await sleep(wait * 2 ** attempt, req.signal);
      }
    }
  }
}

function sdkGenerate(apiKey: string | undefined): GeminiGenerate {
  let client: GoogleGenAI | undefined;
  return async (req) => {
    if (!apiKey) throw new Error("No Gemini API key is set");
    client ??= new GoogleGenAI({ apiKey });
    const res = await client.models.generateContent({
      model: req.model,
      contents: req.contents as never,
      config: {
        systemInstruction: req.system,
        ...(req.tools.length ? { tools: [{ functionDeclarations: req.tools }] } : {}),
        abortSignal: req.signal,
      },
    });
    const candidate = res.candidates?.[0];
    return {
      content: candidate?.content as GeminiContent | undefined,
      usage: res.usageMetadata,
      finishReason: candidate?.finishReason ?? res.promptFeedback?.blockReason,
    };
  };
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number; message?: string };
  if (typeof e?.status === "number") return e.status;
  if (typeof e?.code === "number") return e.code;
  const m = /\b(4\d\d|5\d\d)\b/.exec(e?.message ?? "");
  return m ? Number(m[1]) : undefined;
}

/** Errors a CEO can act on, in plain words. */
function explain(err: unknown): string {
  const status = statusOf(err);
  const raw = err instanceof Error ? err.message : String(err);
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(raw)) return "Gemini rejected the API key. Check it in the start screen.";
  if (status === 401 || status === 403) return "Gemini refused the API key (no access to this model, or the key is restricted).";
  if (status === 404) return "Gemini doesn't know this model id. Pick another model.";
  if (status === 429) return "Gemini's rate limit or quota was hit, even after waiting. Free-tier keys have low limits; add billing or use a smaller model.";
  if (/fetch failed|ENOTFOUND|ECONNRE|ETIMEDOUT|network/i.test(raw)) {
    return "Couldn't reach the Gemini API (generativelanguage.googleapis.com). Check this machine's internet connection or proxy.";
  }
  return raw.length > 300 ? `${raw.slice(0, 300)}...` : raw;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
  });
}

function capOf(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function firstLine(s: string): string {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}

const TOOL_LABEL: Record<string, string> = {
  read_file: "Read",
  list_files: "Glob",
  search: "Grep",
  write_file: "Write",
  edit_file: "Edit",
  run_command: "Bash",
};

function describeCall(name: string, args: Record<string, unknown> | undefined): string {
  const target = (args?.path ?? args?.pattern ?? args?.command ?? "") as string;
  return `${TOOL_LABEL[name] ?? name}${target ? `: ${firstLine(String(target))}` : ""}`;
}
