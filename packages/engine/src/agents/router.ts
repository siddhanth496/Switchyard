import type { Role } from "../core/types.js";
import { ClaudeRunner, type ClaudeRunnerOptions } from "./claude.js";
import { GeminiRunner, type GeminiRunnerOptions } from "./gemini.js";
import type { ActivityListener, AgentResult, AgentRunner, AgentTask } from "./runner.js";

export type Provider = "anthropic" | "gemini";

/** Which company's API a model id belongs to. */
export function providerOf(model: string): Provider {
  return model.startsWith("gemini") ? "gemini" : "anthropic";
}

export interface RoutedRunnerOptions {
  /** Model for roles not listed in `models`. */
  model: string;
  models?: Partial<Record<Role, string>>;
  /** Model for escalated attempts (after repeated failures). */
  escalationModel?: string;
  maxBudgetUsdPerTask?: number;
  anthropicKey?: string;
  geminiKey?: string;
  /** For tests: replace a provider's runner. */
  runners?: Partial<Record<Provider, Pick<ClaudeRunner, "runModel">>>;
}

/**
 * Real agents across providers: each task goes to Claude or Gemini by the
 * model its role is set to, so one company can mix them (say, the designer
 * on Claude and the engineers on Gemini).
 */
export class RoutedRunner implements AgentRunner {
  readonly name = "agents";
  private runners!: Record<Provider, Pick<ClaudeRunner, "runModel">>;

  constructor(private readonly options: RoutedRunnerOptions) {
    this.build();
  }

  private build(): void {
    const { options } = this;
    const shared = { maxBudgetUsdPerTask: options.maxBudgetUsdPerTask };
    this.runners = {
      anthropic: options.runners?.anthropic ?? new ClaudeRunner({ ...shared, apiKey: options.anthropicKey } satisfies ClaudeRunnerOptions),
      gemini: options.runners?.gemini ?? new GeminiRunner({ ...shared, apiKey: options.geminiKey } satisfies GeminiRunnerOptions),
    };
  }

  /** Use new keys for tasks that start from now on (a key added or replaced mid-run). */
  setKeys(keys: { anthropicKey?: string; geminiKey?: string }): void {
    Object.assign(this.options, keys);
    this.build();
  }

  setModels(models: Partial<Record<Role, string>>, escalationModel?: string): void {
    this.options.models = { ...models };
    if (escalationModel) this.options.escalationModel = escalationModel;
  }

  modelFor(task: Pick<AgentTask, "role" | "escalated">): string {
    const own = this.options.models?.[task.role] ?? this.options.model;
    return task.escalated ? (this.options.escalationModel ?? own) : own;
  }

  run(task: AgentTask, onActivity: ActivityListener, signal?: AbortSignal): Promise<AgentResult> {
    const model = this.modelFor(task);
    return this.runners[providerOf(model)].runModel(model, task, onActivity, signal);
  }
}
