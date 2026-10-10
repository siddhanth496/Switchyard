"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Gate } from "@agentco/engine";
import { api } from "@/lib/api";

const FROM: Record<Gate["kind"], string> = {
  prd: "From the PM",
  architecture: "From the tech lead",
  spend: "From the CFO",
  release: "From the tech lead",
  ticket_failed: "From the tech lead",
};

const APPROVE: Record<Gate["kind"], string> = {
  prd: "Approve the PRD",
  architecture: "Approve the architecture",
  spend: "Approve more budget",
  release: "Ship it",
  ticket_failed: "Retry with this guidance",
};

/** The CEO's inbox. Only the oldest pending decision is shown in full. */
export function Decision({ gates }: { gates: Gate[] }) {
  const pending = gates.filter((g) => g.status === "pending");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gate = pending[0];
  if (!gate) {
    return <div className="calm">Nothing needs your decision right now.</div>;
  }

  const failure = gate.kind === "ticket_failed";

  async function act(kind: "approve" | "reject") {
    if (!gate) return;
    if (kind === "reject" && !failure && !feedback.trim()) {
      setError("Say what should change before sending it back.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // For a failed ticket, the note travels with the retry as guidance.
      if (kind === "approve") await api.approve(gate.id, failure ? feedback.trim() || undefined : undefined);
      else await api.reject(gate.id, failure ? undefined : feedback.trim());
      setFeedback("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const actions = failure ? (
    <>
      <textarea
        aria-label="Guidance for the next attempt"
        placeholder="Guidance for the next attempt (optional), e.g. use plain CSS, skip the animation..."
        value={feedback}
        onChange={(e) => {
          setFeedback(e.target.value);
          setError(null);
        }}
      />
      <button className="btn-approve" disabled={busy} onClick={() => act("approve")}>
        {feedback.trim() ? "Retry with this guidance" : "Retry"}
      </button>
      <button className="btn-changes" disabled={busy} onClick={() => act("reject")}>
        Skip this ticket
      </button>
    </>
  ) : (
    <>
      <button className="btn-approve" disabled={busy} onClick={() => act("approve")}>
        {APPROVE[gate.kind]}
      </button>
      <textarea
        aria-label="What should change"
        placeholder="Or say what should change..."
        value={feedback}
        onChange={(e) => {
          setFeedback(e.target.value);
          setError(null);
        }}
      />
      <button className="btn-changes" disabled={busy} onClick={() => act("reject")}>
        {gate.kind === "spend" ? "Stop the build" : "Request changes"}
      </button>
    </>
  );

  return (
    <section className="decision" aria-labelledby="decision-title">
      <div>
        <h2 id="decision-title">{gate.title}</h2>
        <p className="who">{FROM[gate.kind]}</p>
        <div className="doc">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{gate.content}</ReactMarkdown>
        </div>
      </div>
      <div className="act">
        {actions}
        {error && <p className="error">{error}</p>}
        {pending.length > 1 && <p className="queue">{pending.length - 1} more waiting after this one.</p>}
      </div>
    </section>
  );
}
