"use client";

import { useState } from "react";
import type { Project } from "@agentco/engine";
import { api } from "@/lib/api";

/** What changing the brief does right now, by phase. */
function effect(project: Project, releasePending: boolean): string {
  if (releasePending) return "This holds the release: the team builds what changed, QA re-tests, and the release card comes back.";
  if (["building", "testing", "paused"].includes(project.phase)) {
    return "The build keeps going. The task creator files tickets for whatever the new brief changes.";
  }
  return "The step in progress stops, and the PM rewrites the PRD from the new brief; the plan restarts from there. An approved brand is kept.";
}

/**
 * The brief the company is working from, always in view as a reference, and
 * editable at any point: no need to stop and start over.
 */
export function Brief({ project, releasePending }: { project: Project; releasePending: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.idea);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = !["shipped", "stopped", "failed"].includes(project.phase);

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await api.reviseBrief(draft.trim());
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <section className="brief" aria-label="The brief">
        <span className="label">Brief</span>
        <p title={project.idea}>{project.idea}</p>
        {live && (
          <button
            className="btn"
            onClick={() => {
              setDraft(project.idea);
              setEditing(true);
            }}
          >
            Edit brief
          </button>
        )}
      </section>
    );
  }
  return (
    <section className="brief editing" aria-label="Edit the brief">
      <label htmlFor="brief-edit" className="label">
        Brief
      </label>
      <textarea id="brief-edit" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
      <p className="hint">{effect(project, releasePending)}</p>
      <div className="row">
        <button className="btn btn-primary" disabled={busy || draft.trim().length < 3 || draft.trim() === project.idea.trim()} onClick={() => void apply()}>
          {busy ? "Applying..." : "Apply the new brief"}
        </button>
        <button className="btn btn-quiet" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
