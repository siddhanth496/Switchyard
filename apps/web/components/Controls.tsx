"use client";

import { useState } from "react";
import type { Project } from "@agentco/engine";
import { api } from "@/lib/api";

/**
 * The CEO's controls while the team builds: ask for a change at any time,
 * and resume a paused build. Pause and Stop live in the header.
 */
export function Controls({ project }: { project: Project }) {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (request.trim().length < 3) {
      setNote({ kind: "error", text: "Say what should change first." });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await api.requestChange(request.trim());
      setRequest("");
      setNote({ kind: "ok", text: "Sent. The task creator is turning it into tickets; they'll appear on the board shortly." });
    } catch (err) {
      setNote({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="controls" aria-label="Your controls">
      {project.held && (
        <div className="held">
          <span>
            <strong>Paused by you.</strong> Running tickets finish; nothing new starts until you resume.
          </span>
          <button className="btn" onClick={() => void api.resume()}>
            Resume
          </button>
        </div>
      )}
      <form className="change" onSubmit={send}>
        <label htmlFor="change-request">Ask for a change</label>
        <input
          id="change-request"
          value={request}
          placeholder="e.g. Put the streak count on the Today screen, bigger"
          onChange={(e) => {
            setRequest(e.target.value);
            setNote(null);
          }}
        />
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Sending..." : "Send to the team"}
        </button>
        {note && <p className={note.kind === "error" ? "error" : "sent"}>{note.text}</p>}
      </form>
    </section>
  );
}
