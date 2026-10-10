"use client";

import { useState } from "react";
import { api } from "@/lib/api";

export function StartForm({ onCancel }: { onCancel?: () => void }) {
  const [idea, setIdea] = useState("");
  const [runner, setRunner] = useState<"mock" | "claude">("mock");
  const [engineers, setEngineers] = useState(1);
  const [floaters, setFloaters] = useState(1);
  const [budget, setBudget] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (idea.trim().length < 3) {
      setError("Describe the product in a sentence or two first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.start({ idea: idea.trim(), runner, engineersPerArea: engineers, floaters, budgetUsd: budget });
      onCancel?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="start">
      <h1>What should your company build?</h1>
      <p className="lede">
        Describe the product. The PM writes a PRD, the tech lead splits the code into areas, and engineers build
        tickets in parallel. You approve each step.
      </p>
      <form onSubmit={submit}>
        <label>
          The idea
          <textarea
            value={idea}
            onChange={(e) => {
              setIdea(e.target.value);
              setError(null);
            }}
            placeholder="A habit tracker for small teams, with streaks and a weekly email summary"
            autoFocus
          />
        </label>

        <div className="runner" role="radiogroup" aria-label="Agents">
          <label>
            <input type="radio" name="runner" checked={runner === "mock"} onChange={() => setRunner("mock")} />
            Demo agents
            <span className="hint">Scripted, free, no API key. Good for seeing the flow.</span>
          </label>
          <label>
            <input type="radio" name="runner" checked={runner === "claude"} onChange={() => setRunner("claude")} />
            Claude agents
            <span className="hint">Real work in real code. Uses your Anthropic API key and costs money.</span>
          </label>
        </div>

        <div className="grid">
          <label>
            Engineers per area
            <input type="number" min={1} max={6} value={engineers} onChange={(e) => setEngineers(Number(e.target.value))} />
          </label>
          <label>
            Floating engineers
            <input type="number" min={0} max={6} value={floaters} onChange={(e) => setFloaters(Number(e.target.value))} />
          </label>
          <label>
            Budget (USD)
            <input type="number" min={1} step={1} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
          </label>
        </div>

        {error && <p className="error">{error}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-primary submit" disabled={busy}>
            {busy ? "Starting..." : "Start the company"}
          </button>
          {onCancel && (
            <button type="button" className="btn btn-quiet" onClick={onCancel}>
              Back to the board
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
