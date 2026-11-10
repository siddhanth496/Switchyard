import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GeminiRunner, geminiCost, type GeminiGenerate, type GeminiPart, type GeminiRequest } from "../src/agents/gemini.js";
import { RoutedRunner, providerOf } from "../src/agents/router.js";
import type { AgentTask } from "../src/agents/runner.js";
import { commandEnv, confine, runTool } from "../src/agents/tools.js";

const dir = () => mkdtempSync(join(tmpdir(), "gem-"));
const task = (cwd: string, over: Partial<AgentTask> = {}): AgentTask => ({
  kind: "build",
  agentId: "eng-1",
  role: "engineer",
  systemPrompt: "You are an engineer.",
  prompt: "Do the work.",
  cwd,
  canWrite: true,
  context: {},
  ...over,
});
const call = (name: string, args: Record<string, unknown>): GeminiPart => ({ functionCall: { name, args }, thoughtSignature: "sig" });
const usage = { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 100 };

/** A fake model that plays back scripted turns and records what it was sent. */
function script(turns: GeminiPart[][]) {
  const seen: GeminiRequest[] = [];
  const generate: GeminiGenerate = async (req) => {
    seen.push(structuredClone({ ...req, signal: undefined }));
    const parts = turns[seen.length - 1] ?? [{ text: "done" }];
    return { content: { role: "model", parts }, usage, finishReason: "STOP" };
  };
  return { generate, seen };
}

describe("GeminiRunner", () => {
  it("loops model → tools → model, edits real files, and counts spend from token usage", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "hello\n");
    const { generate, seen } = script([
      [call("read_file", { path: "a.txt" })],
      [call("edit_file", { path: "a.txt", old_text: "hello", new_text: "goodbye" }), call("run_command", { command: "cat a.txt && echo ok" })],
      [{ text: "thinking...", thought: true }, { text: '```json\n{"summary": "changed it"}\n```' }],
    ]);
    const activity: string[] = [];
    const res = await new GeminiRunner({ generate, model: "gemini-2.5-flash" }).run(task(cwd), (l) => activity.push(l));

    expect(res.ok).toBe(true);
    expect(res.text).toContain('"summary": "changed it"');
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("goodbye\n");
    // 3 calls x (1000 in @ $0.30 + 200 out incl. thinking @ $2.50) per million.
    expect(res.costUsd).toBeCloseTo(3 * (1000 * 0.3 + 200 * 2.5) / 1e6, 10);
    expect(activity).toEqual(["Read: a.txt", "Edit: a.txt", "Bash: cat a.txt && echo ok", '```json']);

    // Tool results go back to the model, and its own turn is echoed unchanged (thought signatures included).
    expect(seen[0]!.system).toBe("You are an engineer.");
    expect(seen[0]!.tools.map((t) => t.name)).toContain("run_command");
    expect(seen[1]!.contents[1]!.parts[0]!.thoughtSignature).toBe("sig");
    expect(String(seen[1]!.contents[2]!.parts[0]!.functionResponse!.response.output)).toContain("1\thello");
    expect(String(seen[2]!.contents[4]!.parts[1]!.functionResponse!.response.output)).toContain("Exit code 0.\ngoodbye\nok");
  });

  it("gives read-only tasks no write tools, and refuses them if the model tries anyway", async () => {
    const cwd = dir();
    const { generate, seen } = script([[call("write_file", { path: "x.txt", content: "nope" })], [{ text: "ok" }]]);
    const res = await new GeminiRunner({ generate }).run(task(cwd, { canWrite: false, role: "pm" }), () => {});
    expect(res.ok).toBe(true);
    expect(seen[0]!.tools.map((t) => t.name)).toEqual(["read_file", "list_files", "search"]);
    expect(String(seen[1]!.contents[2]!.parts[0]!.functionResponse!.response.output)).toContain("read-only");
    expect(() => readFileSync(join(cwd, "x.txt"))).toThrow();
  });

  it("cuts a task off at its spend cap and when it runs out of turns", async () => {
    const forever = () => script(Array.from({ length: 50 }, () => [call("list_files", { pattern: "**/*" })]));
    const capped = await new GeminiRunner({ generate: forever().generate, model: "gemini-3.1-pro-preview" }).run(
      task(dir(), { budgetUsd: 0.01 }),
      () => {},
    );
    expect(capped).toMatchObject({ ok: false, overBudget: true, error: "cut off at its spend cap" });
    expect(capped.costUsd).toBeGreaterThan(0.01);

    const tired = await new GeminiRunner({ generate: forever().generate }).run(task(dir(), { maxTurns: 3 }), () => {});
    expect(tired).toMatchObject({ ok: false, error: "ran out of turns (3)" });
  });

  it("waits and retries when rate limited, and explains a bad key plainly", async () => {
    let n = 0;
    const flaky: GeminiGenerate = async () => {
      if (++n < 3) throw Object.assign(new Error("Resource exhausted"), { status: 429 });
      return { content: { role: "model", parts: [{ text: "finally" }] }, usage };
    };
    expect(await new GeminiRunner({ generate: flaky, retryMs: 1 }).run(task(dir()), () => {})).toMatchObject({ ok: true, text: "finally" });

    const bad: GeminiGenerate = async () => {
      throw Object.assign(new Error("API key not valid. Please pass a valid API key."), { status: 400 });
    };
    const res = await new GeminiRunner({ generate: bad }).run(task(dir()), () => {});
    expect(res).toMatchObject({ ok: false, error: "Gemini rejected the API key. Check it in the start screen." });
  });

  it("stops when the run is aborted", async () => {
    const ctl = new AbortController();
    const { generate } = script([[call("run_command", { command: "sleep 30" })]]);
    setTimeout(() => ctl.abort(), 150);
    const started = Date.now();
    const res = await new GeminiRunner({ generate }).run(task(dir()), () => {}, ctl.signal);
    expect(res).toMatchObject({ ok: false, error: "stopped" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("prices long Pro prompts at the higher rate and unknown models at the top rate", () => {
    expect(geminiCost("gemini-3.1-pro-preview", { promptTokenCount: 100_000, candidatesTokenCount: 0 })).toBeCloseTo(0.2);
    expect(geminiCost("gemini-3.1-pro-preview", { promptTokenCount: 300_000, candidatesTokenCount: 0 })).toBeCloseTo(1.2);
    expect(geminiCost("gemini-9-ultra", { promptTokenCount: 1_000_000, candidatesTokenCount: 0 })).toBeCloseTo(4);
  });
});

describe("agent tools", () => {
  it("keeps file access inside the working directory, including through symlinks", async () => {
    const cwd = dir();
    const outside = dir();
    writeFileSync(join(outside, "secret.txt"), "s3cret");
    symlinkSync(outside, join(cwd, "link"));
    expect(() => confine(cwd, "../x")).toThrow("outside");
    expect(() => confine(cwd, "/etc/passwd")).toThrow("outside");
    expect(await runTool(cwd, "read_file", { path: "link/secret.txt" }, true)).toContain("outside the working directory");
    expect(await runTool(cwd, "write_file", { path: "link/new.txt", content: "x" }, true)).toContain("outside");
    expect(await runTool(cwd, "list_files", { pattern: "../**" }, true)).toContain("must stay inside");
  });

  it("lists, searches and edits", async () => {
    const cwd = dir();
    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, "node_modules/x"), { recursive: true });
    writeFileSync(join(cwd, "src/a.ts"), "const a = 1;\nconst b = 1;\n");
    writeFileSync(join(cwd, "node_modules/x/i.ts"), "const a = 1;");
    expect(await runTool(cwd, "list_files", { pattern: "**/*.ts" }, false)).toBe("src/a.ts");
    expect(await runTool(cwd, "search", { pattern: "const b" }, false)).toBe("src/a.ts:2: const b = 1;");
    expect(await runTool(cwd, "edit_file", { path: "src/a.ts", old_text: " = 1", new_text: " = 2" }, true)).toContain("appears 2 times");
    expect(await runTool(cwd, "edit_file", { path: "src/a.ts", old_text: "const b = 1", new_text: "const b = $1" }, true)).toBe("Edited src/a.ts");
    expect(readFileSync(join(cwd, "src/a.ts"), "utf8")).toContain("const b = $1;");
  });

  it("never passes API keys to commands", async () => {
    const env = commandEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", GOOGLE_API_KEY: "g2", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
    expect(await runTool(dir(), "run_command", { command: "sleep 5", timeout_seconds: 1 }, true)).toContain("timed out after 1s");
  });
});

describe("RoutedRunner", () => {
  it("sends each role to the provider of its model", async () => {
    const calls: string[] = [];
    const fake = (name: string) => ({
      runModel: async (model: string | undefined, t: AgentTask) => (calls.push(`${name}:${model}:${t.role}`), { ok: true, text: "", costUsd: 0 }),
    });
    const r = new RoutedRunner({
      model: "gemini-2.5-flash",
      models: { designer: "claude-opus-5-5" },
      escalationModel: "gemini-3.1-pro-preview",
      runners: { anthropic: fake("claude"), gemini: fake("gemini") },
    });
    await r.run(task("/tmp", { role: "designer" }), () => {});
    await r.run(task("/tmp"), () => {});
    await r.run(task("/tmp", { role: "tech_lead", escalated: true }), () => {});
    r.setModels({ engineer: "claude-haiku-5-5" });
    await r.run(task("/tmp"), () => {});
    expect(calls).toEqual([
      "claude:claude-opus-5-5:designer",
      "gemini:gemini-2.5-flash:engineer",
      "gemini:gemini-3.1-pro-preview:tech_lead",
      "claude:claude-haiku-5-5:engineer",
    ]);
    expect(providerOf("gemini-3.5-flash")).toBe("gemini");
  });
});
