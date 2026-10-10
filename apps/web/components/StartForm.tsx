"use client";

import { useEffect, useState } from "react";
import { api, type ServerConfig } from "@/lib/api";

export function StartForm({ onCancel }: { onCancel?: () => void }) {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [idea, setIdea] = useState("");
  const [runner, setRunner] = useState<"mock" | "claude">("mock");
  const [model, setModel] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [engineers, setEngineers] = useState(1);
  const [floaters, setFloaters] = useState(1);
  const [budget, setBudget] = useState(5);
  const [error, setError] = useState<{ field: "idea" | "key" | "budget" | "form"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .config()
      .then((c) => {
        setConfig(c);
        setModel(c.defaultModel);
        setRunner(c.defaultRunner);
      })
      .catch(() => setError({ field: "form", message: "Couldn't load settings from the server." }));
  }, []);

  const claude = runner === "claude";
  const showKeyInput = claude && (!config?.hasKey || replacingKey);
  const selectedModel = config?.models.find((m) => m.id === model);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (idea.trim().length < 3) return setError({ field: "idea", message: "Describe the product in a sentence or two first." });
    if (!(budget > 0)) return setError({ field: "budget", message: "Set a budget above $0." });
    if (showKeyInput && !keyInput.trim()) return setError({ field: "key", message: "Paste your Anthropic API key to use Claude agents." });

    setBusy(true);
    setError(null);
    try {
      if (showKeyInput) {
        try {
          const status = await api.setKey(keyInput.trim());
          setConfig((c) => (c ? { ...c, ...status } : c));
          setKeyInput("");
          setReplacingKey(false);
        } catch (err) {
          setError({ field: "key", message: (err as Error).message });
          return;
        }
      }
      await api.start({
        idea: idea.trim(),
        runner,
        model: claude ? model : undefined,
        engineersPerArea: engineers,
        floaters,
        budgetUsd: budget,
      });
      onCancel?.();
    } catch (err) {
      setError({ field: "form", message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function removeKey() {
    const status = await api.clearKey();
    setConfig((c) => (c ? { ...c, ...status } : c));
    setReplacingKey(false);
  }

  const fieldError = (field: "idea" | "key" | "budget") =>
    error?.field === field ? <span className="field-error">{error.message}</span> : null;

  return (
    <main className="start">
      <h1>What should your company build?</h1>
      <p className="lede">
        Describe the product. The PM writes a PRD, the tech lead splits the code into areas, and engineers build
        tickets in parallel. You approve each step.
      </p>
      <form onSubmit={submit} noValidate>
        <label>
          The idea
          <textarea
            value={idea}
            onChange={(e) => {
              setIdea(e.target.value);
              if (error?.field === "idea") setError(null);
            }}
            placeholder="A habit tracker for small teams, with streaks and a weekly email summary"
            autoFocus
          />
          {fieldError("idea")}
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
            <span className="hint">Real work in real code. Billed to your Anthropic API key.</span>
          </label>
        </div>

        {claude && (
          <fieldset className="claude-settings">
            <legend>Claude agents</legend>

            {showKeyInput ? (
              <label>
                Anthropic API key
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-ant-api..."
                  value={keyInput}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    if (error?.field === "key") setError(null);
                  }}
                />
                <span className="hint">
                  Create one at console.anthropic.com under API Keys. It stays in the server's memory only and is
                  cleared when the server stops.
                </span>
                {fieldError("key")}
                {replacingKey && (
                  <button type="button" className="btn btn-quiet link" onClick={() => setReplacingKey(false)}>
                    Keep the current key
                  </button>
                )}
              </label>
            ) : (
              <div className="key-status">
                <span>
                  Using your API key ending in <strong>{config?.keyHint}</strong>
                  {config?.keySource === "env" ? " from the server's environment" : ""}.
                </span>
                <span className="key-actions">
                  <button type="button" className="btn btn-quiet link" onClick={() => setReplacingKey(true)}>
                    Use a different key
                  </button>
                  {config?.keySource === "ui" && (
                    <button type="button" className="btn btn-quiet link" onClick={removeKey}>
                      Remove key
                    </button>
                  )}
                </span>
              </div>
            )}

            <label>
              Model
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {config?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              {selectedModel && <span className="hint">{selectedModel.hint}</span>}
            </label>
          </fieldset>
        )}

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
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={budget}
              onChange={(e) => {
                setBudget(Number(e.target.value));
                if (error?.field === "budget") setError(null);
              }}
            />
            {fieldError("budget")}
          </label>
        </div>
        <p className="hint form-note">
          Work pauses at the budget until you approve more, and no single agent task can spend more than a quarter of
          it.
        </p>

        {error?.field === "form" && <p className="error">{error.message}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-primary submit" disabled={busy || !config}>
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
