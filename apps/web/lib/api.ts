export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export interface StartOptions {
  idea: string;
  runner: "mock" | "claude";
  engineersPerArea: number;
  floaters: number;
  budgetUsd: number;
  model?: string;
}

export const api = {
  start: (opts: StartOptions) => post("/api/projects", opts),
  approve: (gateId: string) => post(`/api/gates/${gateId}/approve`),
  reject: (gateId: string, feedback: string) => post(`/api/gates/${gateId}/reject`, { feedback }),
  retry: (ticketId: string) => post(`/api/tickets/${ticketId}/retry`),
  stop: () => post("/api/stop"),
};
