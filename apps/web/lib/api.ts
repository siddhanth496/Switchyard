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
}

export interface StartOptions {
  idea: string;
  continueFrom?: string;
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

export interface ModelOption {
  id: string;
  label: string;
  hint: string;
}

export interface KeyStatus {
  hasKey: boolean;
  keySource: "ui" | "env" | null;
  keyHint: string | null;
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
  setKey: (key: string) => request<KeyStatus>("PUT", "/api/config/key", { key }),
  clearKey: () => request<KeyStatus>("DELETE", "/api/config/key"),
  start: (opts: StartOptions) => post("/api/projects", opts),
  approve: (gateId: string, feedback?: string) => post(`/api/gates/${gateId}/approve`, feedback ? { feedback } : {}),
  reject: (gateId: string, feedback?: string) => post(`/api/gates/${gateId}/reject`, feedback ? { feedback } : {}),
  retry: (ticketId: string, guidance?: string) => post(`/api/tickets/${ticketId}/retry`, guidance ? { guidance } : {}),
  skip: (ticketId: string) => post(`/api/tickets/${ticketId}/skip`),
  stop: () => post("/api/stop"),
  pause: () => post("/api/pause"),
  resume: () => post("/api/resume"),
  requestChange: (request: string) => post("/api/changes", { request }),
  setModels: (models: Record<string, string>) => request<{ models: Record<string, string> }>("PUT", "/api/models", { models }),
  prioritize: (ticketId: string) => post(`/api/tickets/${ticketId}/prioritize`),
  note: (ticketId: string, note: string, redo = false) => post(`/api/tickets/${ticketId}/note`, { note, redo }),
  cancel: (ticketId: string) => post(`/api/tickets/${ticketId}/cancel`),
};
