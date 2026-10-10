"use client";

import { useEffect, useState } from "react";
import { api, type Product, type ServerConfig } from "@/lib/api";

export function StartForm({ onCancel }: { onCancel?: () => void }) {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [mode, setMode] = useState<"new" | "continue">("new");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [product, setProduct] = useState<string>("");
  const [idea, setIdea] = useState("");
  const [runner, setRunner] = useState<"mock" | "claude">("mock");
  const [model, setModel] = useState("");
  /** Per-role overrides; a role left out uses the default model. */
  const [roleModels, setRoleModels] = useState<Record<string, string>>({});
  const [keyInput, setKeyInput] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [engineers, setEngineers] = useState(1);
  const [floaters, setFloaters] = useState(1);
  const [budget, setBudget] = useState(5);
  const [marketing, setMarketing] = useState(true);
  const [design, setDesign] = useState(true);
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
    api
      .products()
      .then((r) => {
        setProducts(r.products);
        setWorkspace(r.workspace);
        if (r.products[0]) setProduct(r.products[0].dir);
      })
      .catch(() => setProducts([]));
  }, []);

  const continuing = mode === "continue";

  const claude = runner === "claude";
  const showKeyInput = claude && (!config?.hasKey || replacingKey);
  const selectedModel = config?.models.find((m) => m.id === model);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (continuing && !product) return setError({ field: "form", message: "Pick the product to continue." });
    if (idea.trim().length < 3)
      return setError({
        field: "idea",
        message: continuing ? "Describe what should change first." : "Describe the product in a sentence or two first.",
      });
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
        continueFrom: continuing ? product : undefined,
        runner,
        model: claude ? model : undefined,
        models: claude ? roleModels : undefined,
        engineersPerArea: engineers,
        floaters,
        budgetUsd: budget,
        marketing,
        design,
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
      <h1>{continuing ? "What should change?" : "What should your company build?"}</h1>
      <p className="lede">
        {continuing
          ? "Pick a product the team built before and describe the change. The PM updates the PRD, the team builds only what changed, and QA tests it before you release."
          : "Describe the product. The PM writes a PRD, marketing names and brands it, the designer designs it, the tech lead splits the code into areas, and engineers build tickets in parallel. You approve each step."}
      </p>
      <form onSubmit={submit} noValidate>
        <div className="mode" role="tablist" aria-label="What to do">
          <button type="button" role="tab" aria-selected={!continuing} className={!continuing ? "on" : ""} onClick={() => setMode("new")}>
            New product
          </button>
          <button type="button" role="tab" aria-selected={continuing} className={continuing ? "on" : ""} onClick={() => setMode("continue")}>
            Continue a product
          </button>
        </div>

        {continuing && (
          <fieldset className="products">
            <legend>Product</legend>
            {products === null ? (
              <p className="hint">Loading products...</p>
            ) : products.length === 0 ? (
              <p className="hint">No products yet in {workspace || "the workspace"}. Build one first.</p>
            ) : (
              products.map((p) => (
                <label key={p.dir} className="product">
                  <input type="radio" name="product" checked={product === p.dir} onChange={() => setProduct(p.dir)} />
                  <span className="pname">{p.name}</span>
                  <span className="hint">
                    {p.folder}, {p.commits} commits{p.updatedAt ? `, last change ${new Date(p.updatedAt).toLocaleString()}` : ""}
                  </span>
                </label>
              ))
            )}
          </fieldset>
        )}

        <label>
          {continuing ? "The change" : "The idea"}
          <textarea
            value={idea}
            onChange={(e) => {
              setIdea(e.target.value);
              if (error?.field === "idea") setError(null);
            }}
            placeholder={
              continuing
                ? "Add a search box to the notes page, and let users pin notes to the top"
                : "A habit tracker for small teams, with streaks and a weekly email summary"
            }
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
              Default model
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {config?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              {selectedModel && <span className="hint">{selectedModel.hint}</span>}
            </label>

            <details className="role-models" open={Object.keys(roleModels).length > 0}>
              <summary>
                Model for each agent
                {Object.keys(roleModels).length > 0 && <span className="hint"> · {Object.keys(roleModels).length} changed</span>}
              </summary>
              <p className="hint">
                Design, branding and reviews need taste; engineers are most of the spend. A common setup: Sonnet or Opus
                for the designer and marketing, Haiku for engineers. You can change these during the run too.
              </p>
              <div className="role-grid">
                {config?.modelRoles.map((r) => (
                  <label key={r.role}>
                    {r.label}
                    <select
                      value={roleModels[r.role] ?? ""}
                      onChange={(e) =>
                        setRoleModels((m) => {
                          const next = { ...m };
                          if (e.target.value) next[r.role] = e.target.value;
                          else delete next[r.role];
                          return next;
                        })
                      }
                    >
                      <option value="">Default ({config.models.find((m) => m.id === model)?.label ?? "default"})</option>
                      {config.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <span className="hint">{r.hint}</span>
                  </label>
                ))}
              </div>
            </details>
          </fieldset>
        )}

        <fieldset className="teams">
          <legend>Teams</legend>
          <label className="check">
            <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />
            <span>
              Marketing
              <span className="hint">
                {continuing
                  ? "Keeps the product's brand and writes the launch copy for the update."
                  : "Picks the name, tagline, voice, colors and logo for you to approve, then writes the launch copy."}
              </span>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={design} onChange={(e) => setDesign(e.target.checked)} />
            <span>
              Design
              <span className="hint">
                {continuing
                  ? "Updates the product's design for the change, if it has one. The PM checks it's feasible."
                  : "Drafts the design system and key screens. The PM checks it's feasible before it reaches you."}
              </span>
            </span>
          </label>
        </fieldset>

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
            {busy ? "Starting..." : continuing ? "Start the change" : "Start the company"}
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
