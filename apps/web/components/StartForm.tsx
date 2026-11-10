"use client";

import { useEffect, useState } from "react";
import { api, type ModelOption, type Product, type ProviderId, type ServerConfig } from "@/lib/api";
import { svgUrl } from "@/components/Header";

const LAST_PHASE: Record<string, string> = {
  shipped: "Shipped",
  stopped: "Stopped by you",
  failed: "Stopped on a failure",
  releasing: "Waiting on the release card",
};

/** Model choices grouped by provider, for a <select>. */
export function ModelOptions({ models, providers }: { models: ModelOption[]; providers: { id: ProviderId; label: string }[] }) {
  return (
    <>
      {providers.map((p) => (
        <optgroup key={p.id} label={p.label}>
          {models
            .filter((m) => m.provider === p.id)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
}

/** Where the product's last run left off: the reference while you write the next request. */
function LastRun({ product, onUseBrief }: { product: Product; onUseBrief: (brief: string) => void }) {
  const last = product.last;
  if (!last) {
    return (
      <div className="last-run">
        <p className="hint">No saved board for this product yet (it was built before boards were saved). Its code and docs are all there.</p>
      </div>
    );
  }
  return (
    <div className="last-run" aria-label="Where it left off">
      <div className="head">
        {last.brand && <img src={svgUrl(last.brand.logoSvg)} alt="" width={32} height={32} />}
        <div>
          <strong>{last.brand?.name ?? product.name}</strong>
          <span className="hint">
            {LAST_PHASE[last.phase] ?? `Was ${last.phase} when it stopped`} · {new Date(last.savedAt).toLocaleString()} · $
            {last.spentUsd.toFixed(2)} spent
          </span>
        </div>
      </div>
      <div className="brief-ref">
        <span className="label">Last brief</span>
        <p>{last.idea}</p>
        <button type="button" className="btn btn-quiet link" onClick={() => onUseBrief(last.idea)}>
          Edit from this brief
        </button>
      </div>
      <p className="counts">
        <strong>{last.counts.merged}</strong> merged · <strong>{last.counts.open}</strong> unfinished
        {last.counts.skipped > 0 && (
          <>
            {" "}
            · <strong>{last.counts.skipped}</strong> skipped
          </>
        )}
        {last.lastRelease && (
          <>
            {" "}
            · release {last.lastRelease.status === "approved" ? "approved" : last.lastRelease.status === "pending" ? "waiting" : "held"}
            {last.lastRelease.feedback && last.lastRelease.status === "rejected" ? `: "${last.lastRelease.feedback}"` : ""}
          </>
        )}
      </p>
      {last.open.length > 0 && (
        <div>
          <span className="label">Unfinished</span>
          <ul>
            {last.open.map((t) => (
              <li key={t.id}>
                <span className="id">{t.id}</span> {t.title}
              </li>
            ))}
          </ul>
        </div>
      )}
      {last.recent.length > 0 && (
        <div>
          <span className="label">Recently merged</span>
          <ul>
            {last.recent.map((t) => (
              <li key={t.id}>
                <span className="id">{t.id}</span> {t.title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

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
  const [keyInputs, setKeyInputs] = useState<Partial<Record<ProviderId, string>>>({});
  const [replacingKey, setReplacingKey] = useState<Partial<Record<ProviderId, boolean>>>({});
  const [keyNote, setKeyNote] = useState<string | null>(null);
  const [engineers, setEngineers] = useState(1);
  const [floaters, setFloaters] = useState(1);
  const [budget, setBudget] = useState(5);
  const [marketing, setMarketing] = useState(true);
  const [design, setDesign] = useState(true);
  const [error, setError] = useState<{ field: "idea" | "key" | "budget" | "form"; message: string; provider?: ProviderId } | null>(null);
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
  // Which providers the chosen models need: every role's model, or the default where a role has none.
  const providerOfModel = (id: string) => config?.models.find((m) => m.id === id)?.provider;
  const needed = new Set(
    (config?.modelRoles ?? []).map((r) => providerOfModel(roleModels[r.role] ?? model)).filter((x): x is ProviderId => !!x),
  );
  const providers = config?.providers ?? [];
  const showsInput = (id: ProviderId) => !providers.find((p) => p.id === id)?.hasKey || !!replacingKey[id];
  const selectedModel = config?.models.find((m) => m.id === model);
  const chosen = continuing ? products?.find((p) => p.dir === product) : undefined;
  const unfinishedCount = chosen?.last?.counts.open ?? 0;

  async function submit(e: React.FormEvent | null, resume = false) {
    e?.preventDefault();
    if (continuing && !product) return setError({ field: "form", message: "Pick the product to continue." });
    if (!resume && idea.trim().length < 3)
      return setError({
        field: "idea",
        message: continuing ? "Describe what should change first." : "Describe the product in a sentence or two first.",
      });
    if (!(budget > 0)) return setError({ field: "budget", message: "Set a budget above $0." });
    const toSave = claude ? providers.filter((p) => showsInput(p.id) && keyInputs[p.id]?.trim()) : [];
    if (claude) {
      const missing = providers.find((p) => needed.has(p.id) && showsInput(p.id) && !keyInputs[p.id]?.trim());
      if (missing) {
        return setError({ field: "key", provider: missing.id, message: `Paste your ${missing.keyLabel}: some agents are set to a ${missing.label} model.` });
      }
    }

    setBusy(true);
    setError(null);
    try {
      for (const p of toSave) {
        if (!(await saveKey(p.id))) return;
      }
      await api.start({
        idea: resume ? "" : idea.trim(),
        continueFrom: continuing ? product : undefined,
        resume: resume || undefined,
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

  /** Save one key now, so the model lists show what that key can really use. */
  async function saveKey(id: ProviderId): Promise<boolean> {
    const p = providers.find((x) => x.id === id)!;
    try {
      const status = await api.setKey(id, (keyInputs[id] ?? "").trim());
      const models = status.models;
      setConfig((c) => (c ? { ...c, providers: status.providers, models: models ?? c.models, geminiListed: id === "gemini" ? status.verified === true : c.geminiListed } : c));
      setKeyInputs((k) => ({ ...k, [id]: "" }));
      setReplacingKey((r) => ({ ...r, [id]: false }));
      setError(null);
      if (models) {
        // Drop choices the key can't use.
        const ok = (m: string) => models.some((x) => x.id === m);
        setRoleModels((r) => Object.fromEntries(Object.entries(r).filter(([, m]) => ok(m))));
        setModel((m) => (ok(m) ? m : (models.find((x) => x.provider === providerOfModel(m))?.id ?? models[0]!.id)));
      }
      setKeyNote(
        status.verified === false
          ? `Couldn't reach Google to check the ${p.label} key or load its models. It's saved; the models listed are a guess and the first agent call will tell.`
          : id === "gemini"
            ? `Gemini key checked. The model lists now show the ${models?.filter((m) => m.provider === "gemini").length ?? 0} Gemini models this key can use.`
            : null,
      );
      return true;
    } catch (err) {
      setError({ field: "key", provider: id, message: (err as Error).message });
      return false;
    }
  }

  async function removeKey(id: ProviderId) {
    const status = await api.clearKey(id);
    setConfig((c) => (c ? { ...c, providers: status.providers } : c));
    setReplacingKey((r) => ({ ...r, [id]: false }));
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

        {chosen && <LastRun product={chosen} onUseBrief={(b) => setIdea(b)} />}

        <label>
          {continuing ? "The change" : "The idea"}
          {continuing && unfinishedCount > 0 && (
            <span className="hint">The {unfinishedCount} unfinished ticket(s) carry into this run either way.</span>
          )}
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
            Real agents
            <span className="hint">Claude or Gemini models doing real work in real code. Billed to your own API keys.</span>
          </label>
        </div>

        {claude && (
          <fieldset className="claude-settings">
            <legend>Real agents</legend>

            {providers.map((p) => {
              const inUse = needed.has(p.id);
              const keyError = error?.field === "key" && error.provider === p.id ? <span className="field-error">{error.message}</span> : null;
              return showsInput(p.id) ? (
                <label key={p.id}>
                  {p.keyLabel}
                  {!inUse && <span className="hint"> · optional: no agent is set to a {p.label} model</span>}
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={p.placeholder}
                    value={keyInputs[p.id] ?? ""}
                    onChange={(e) => {
                      setKeyInputs((k) => ({ ...k, [p.id]: e.target.value }));
                      if (error?.field === "key") setError(null);
                    }}
                  />
                  <span className="hint">{p.help} It stays in the server's memory only and is cleared when the server stops.</span>
                  {keyError}
                  <button type="button" className="btn link" disabled={!keyInputs[p.id]?.trim()} onClick={() => void saveKey(p.id)}>
                    {p.id === "gemini" ? "Check key and load its models" : "Save key"}
                  </button>
                  {replacingKey[p.id] && (
                    <button type="button" className="btn btn-quiet link" onClick={() => setReplacingKey((r) => ({ ...r, [p.id]: false }))}>
                      Keep the current key
                    </button>
                  )}
                </label>
              ) : (
                <div className="key-status" key={p.id}>
                  <span>
                    {p.label}: using your key ending in <strong>{p.keyHint}</strong>
                    {p.keySource === "env" ? " from the server's environment" : ""}.
                  </span>
                  <span className="key-actions">
                    <button type="button" className="btn btn-quiet link" onClick={() => setReplacingKey((r) => ({ ...r, [p.id]: true }))}>
                      Use a different key
                    </button>
                    {p.keySource === "ui" && (
                      <button type="button" className="btn btn-quiet link" onClick={() => void removeKey(p.id)}>
                        Remove key
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
            {keyNote && <p className="hint">{keyNote}</p>}
            {needed.has("gemini") && config && !config.geminiListed && !keyNote && (
              <p className="hint">
                The Gemini models listed are a guess until your key is checked. Google offers different models to different
                accounts, so use "Check key and load its models" before you pick.
              </p>
            )}

            <label>
              Default model
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {config && <ModelOptions models={config.models} providers={config.providers} />}
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
                for the designer and marketing, Haiku or a Gemini Flash model for engineers. You can mix Claude and Gemini. You can change these during the run too.
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
                      <ModelOptions models={config.models} providers={config.providers} />
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
        <div className="actions">
          <button className="btn btn-primary submit" disabled={busy || !config}>
            {busy ? "Starting..." : continuing ? "Start the change" : "Start the company"}
          </button>
          {continuing && unfinishedCount > 0 && (
            <button type="button" className="btn submit" disabled={busy || !config} onClick={() => void submit(null, true)}>
              Resume the {unfinishedCount} unfinished ticket{unfinishedCount === 1 ? "" : "s"}
            </button>
          )}
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
