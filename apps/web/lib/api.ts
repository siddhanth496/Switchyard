import type { HistorySummary } from "@agentco/engine";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);

export interface Product {
  dir: string;
  folder: string;
  name: string;
  updatedAt: number;
  commits: number;
  hasPrd: boolean;
  /** Where the last run left off, if it was saved. */
  last?: HistorySummary;
}

export interface StartOptions {
  idea: string;
  continueFrom?: string;
  /** Pick up the last run's unfinished tickets; no new request needed. */
  resume?: boolean;
  /** "claude" means real agents: Claude or Gemini, by each role's model. */
  runner: "mock" | "claude";
  engineersPerArea: number;
  floaters: number;
  budgetUsd: number;
  model?: string;
  /** Model per role; roles left out use `model`. */
  models?: Record<string, string>;
  marketing: boolean;
  design: boolean;
}

export interface ModelRole {
  role: string;
  label: string;
  hint: string;
}

export type ProviderId = "anthropic" | "gemini";

export interface ModelOption {
  id: string;
  label: string;
  hint: string;
  provider: ProviderId;
}

/** One model provider and the state of its API key (never the key itself). */
export interface ProviderStatus {
  id: ProviderId;
  label: string;
  keyLabel: string;
  placeholder: string;
  help: string;
  hasKey: boolean;
  keySource: "ui" | "env" | null;
  keyHint: string | null;
}

export interface KeyStatus {
  providers: ProviderStatus[];
  /** Gemini only: false when Google couldn't be reached to check the key. */
  verified?: boolean;
}

export interface ServerConfig extends KeyStatus {
  models: ModelOption[];
  modelRoles: ModelRole[];
  defaultModel: string;
  defaultRunner: "mock" | "claude";
}

export const api = {
  config: () => request<ServerConfig>("GET", "/api/config"),
  products: () => request<{ products: Product[]; workspace: string }>("GET", "/api/products"),
  setKey: (provider: ProviderId, key: string) => request<KeyStatus>("PUT", "/api/config/key", { provider, key }),
  clearKey: (provider: ProviderId) => request<KeyStatus>("DELETE", `/api/config/key?provider=${provider}`),
  start: (opts: StartOptions) => post("/api/projects", opts),
  approve: (gateId: string, feedback?: string) => post(`/api/gates/${gateId}/approve`, feedback ? { feedback } : {}),
  reject: (gateId: string, feedback?: string) => post(`/api/gates/${gateId}/reject`, feedback ? { feedback } : {}),
  retry: (ticketId: string, guidance?: string) => post(`/api/tickets/${ticketId}/retry`, guidance ? { guidance } : {}),
  skip: (ticketId: string) => post(`/api/tickets/${ticketId}/skip`),
  stop: () => post("/api/stop"),
  pause: () => post("/api/pause"),
  resume: () => post("/api/resume"),
  requestChange: (request: string) => post("/api/changes", { request }),
  reviseBrief: (idea: string) => post("/api/brief", { idea }),
  setModels: (models: Record<string, string>) => request<{ models: Record<string, string> }>("PUT", "/api/models", { models }),
  prioritize: (ticketId: string) => post(`/api/tickets/${ticketId}/prioritize`),
  note: (ticketId: string, note: string, redo = false) => post(`/api/tickets/${ticketId}/note`, { note, redo }),
  cancel: (ticketId: string) => post(`/api/tickets/${ticketId}/cancel`),
};
