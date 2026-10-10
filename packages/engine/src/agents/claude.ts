import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ActivityListener, AgentResult, AgentRunner, AgentTask } from "./runner.js";

export interface ClaudeRunnerOptions {
  /** Model id, e.g. "claude-sonnet-5-5". Defaults to the SDK's default. */
  model?: string;
  /** Per-task spend cap in USD. */
  maxBudgetUsdPerTask?: number;
}

const READ_TOOLS = ["Read", "Glob", "Grep"];
// Engineers need a shell to install packages and run tests. Run the server
// inside a container or VM: these agents execute real commands.
const WRITE_TOOLS = [...READ_TOOLS, "Write", "Edit", "Bash"];

/**
 * Runs agent tasks through the Claude Agent SDK. Each task is a fresh,
 * headless session scoped to its working directory, with a fixed tool list
 * and no prompts: anything not on the list is denied.
 */
export class ClaudeRunner implements AgentRunner {
  readonly name = "claude";

  constructor(private readonly options: ClaudeRunnerOptions = {}) {}

  async run(task: AgentTask, onActivity: ActivityListener, signal?: AbortSignal): Promise<AgentResult> {
    const tools = task.canWrite ? WRITE_TOOLS : READ_TOOLS;
    const abortController = new AbortController();
    signal?.addEventListener("abort", () => abortController.abort(), { once: true });

    let text = "";
    let costUsd = 0;
    try {
      const session = query({
        prompt: task.prompt,
        options: {
          cwd: task.cwd,
          systemPrompt: task.systemPrompt,
          model: this.options.model,
          maxTurns: task.maxTurns ?? (task.canWrite ? 40 : 12),
          maxBudgetUsd: this.options.maxBudgetUsdPerTask,
          tools,
          allowedTools: tools,
          permissionMode: "dontAsk",
          settingSources: [],
          abortController,
        },
      });

      for await (const message of session) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) {
              onActivity(firstLine(block.text));
            } else if (block.type === "tool_use") {
              onActivity(describeToolUse(block.name, block.input));
            }
          }
        } else if (message.type === "result") {
          costUsd = message.total_cost_usd ?? 0;
          if (message.subtype === "success" && !message.is_error) {
            text = message.result;
          } else {
            const detail =
              message.subtype === "success" ? message.result : message.errors?.join("; ") || message.subtype;
            return { ok: false, text, costUsd, error: detail };
          }
        }
      }
      return { ok: true, text, costUsd };
    } catch (err) {
      return { ok: false, text, costUsd, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function firstLine(s: string): string {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 137)}...` : line;
}

function describeToolUse(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const target = (i.file_path ?? i.path ?? i.pattern ?? i.command ?? "") as string;
  return `${name}${target ? `: ${firstLine(String(target))}` : ""}`;
}
