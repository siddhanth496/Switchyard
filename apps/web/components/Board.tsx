"use client";

import { useState } from "react";
import type { Agent, Area, Ticket, TicketStatus } from "@agentco/engine";
import { api } from "@/lib/api";

const COLUMNS: { title: string; statuses: TicketStatus[]; empty: string }[] = [
  { title: "Ready", statuses: ["backlog", "ready"], empty: "No tickets waiting." },
  { title: "Building", statuses: ["in_progress"], empty: "Nobody is building yet." },
  { title: "In review", statuses: ["review"], empty: "Nothing to review." },
  { title: "Merged", statuses: ["done"], empty: "Nothing merged yet." },
];

const EXTRA_COLUMNS: { title: string; statuses: TicketStatus[]; empty: string }[] = [
  { title: "Needs you", statuses: ["failed"], empty: "" },
  { title: "Skipped", statuses: ["skipped"], empty: "" },
];

/** What the CEO can do to one ticket while the build runs. */
function TicketActions({ ticket }: { ticket: Ticket }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = ticket.status === "in_progress" || ticket.status === "review";
  const waiting = ticket.status === "ready" || ticket.status === "backlog";

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setNote("");
      setConfirmCancel(false);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="ticket-more" onClick={() => setOpen(true)} aria-label={`Actions for ${ticket.id}`}>
        Steer
      </button>
    );
  }
  return (
    <div className="ticket-actions">
      <textarea
        aria-label={`Note for ${ticket.id}`}
        placeholder={running ? "Note for the engineer, e.g. use the tab bar from the design" : "Note for whoever builds it"}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="row">
        {running ? (
          <button className="btn" disabled={busy} onClick={() => void act(() => api.note(ticket.id, note, true))}>
            {note.trim() ? "Redo with note" : "Redo"}
          </button>
        ) : (
          <button className="btn" disabled={busy || !note.trim()} onClick={() => void act(() => api.note(ticket.id, note))}>
            Add note
          </button>
        )}
        {waiting && (
          <button className="btn" disabled={busy} onClick={() => void act(() => api.prioritize(ticket.id))}>
            Do next
          </button>
        )}
        <button
          className={`btn ${confirmCancel ? "btn-danger" : "btn-quiet"}`}
          disabled={busy}
          onClick={() => (confirmCancel ? void act(() => api.cancel(ticket.id)) : setConfirmCancel(true))}
        >
          {confirmCancel ? "Confirm cancel" : "Cancel ticket"}
        </button>
        <button className="btn btn-quiet" disabled={busy} onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      {running && <p className="hint">Redo stops this attempt and starts it again with your note. It doesn't count against the engineer.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function TicketCard({
  ticket,
  tickets,
  agents,
  areas,
  active,
}: {
  ticket: Ticket;
  tickets: Ticket[];
  agents: Agent[];
  areas: Area[];
  active: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const area = areas.find((a) => a.id === ticket.area);
  const assignee = agents.find((a) => a.id === ticket.assignee);
  const waitingOn = ticket.dependsOn.filter((d) => {
    const s = tickets.find((t) => t.id === d)?.status;
    return s !== "done" && s !== "skipped";
  });
  const skippedDeps = ticket.dependsOn.filter((d) => tickets.find((t) => t.id === d)?.status === "skipped");
  const lent = assignee && assignee.area !== ticket.area && ticket.status !== "done";

  return (
    <article className={`ticket s-${ticket.status}`}>
      <div className="top">
        <span className="id">
          {ticket.id}
          {ticket.kind === "bug" && <span className="bug-tag">Bug</span>}
          {ticket.kind === "change" && <span className="change-tag">Change</span>}
          {ticket.kind === "design" && <span className="design-tag">Design</span>}
        </span>
        <span>{area?.name ?? ticket.area}</span>
      </div>
      <div className="title">{ticket.title.replace(/^(Bug|Change|Design): /, "")}</div>
      <ul className="files" aria-label="Files">
        {ticket.files.slice(0, 4).map((f) => (
          <li key={f}>{f}</li>
        ))}
        {ticket.files.length > 4 && <li>+{ticket.files.length - 4}</li>}
      </ul>
      {assignee && ticket.status !== "ready" && (
        <div className="line">
          {assignee.name}
          {lent ? " (on loan)" : ""}
        </div>
      )}
      {ticket.status === "ready" && waitingOn.length > 0 && (
        <div className="line wait">Waiting on {waitingOn.join(", ")}</div>
      )}
      {ticket.batchWith && ticket.batchWith.length > 1 && ["in_progress", "review"].includes(ticket.status) && (
        <div className="line batch">Batched with {ticket.batchWith.filter((id) => id !== ticket.id).join(", ")}</div>
      )}
      {ticket.budgetUsd !== undefined && ticket.budgetUsd > 0 && (
        <div className={`line budget${(ticket.buildSpendUsd ?? 0) > ticket.budgetUsd ? " over" : ""}`}>
          {ticket.size && <span className="size">{ticket.size}</span>}
          ${(ticket.buildSpendUsd ?? 0).toFixed(2)} of ${ticket.budgetUsd.toFixed(2)}
        </div>
      )}
      {ticket.escalated && ticket.status !== "done" && <div className="line escalated">Escalated to the tech lead</div>}
      {skippedDeps.length > 0 && ticket.status !== "done" && (
        <div className="line wait">Building without {skippedDeps.join(", ")} (skipped)</div>
      )}
      {ticket.attempts > 0 && !["done", "failed", "skipped"].includes(ticket.status) && (
        <div className="line">Attempt {ticket.attempts + 1}</div>
      )}
      {ticket.feedback && !["done", "skipped"].includes(ticket.status) && <div className="feedback">{ticket.feedback}</div>}
      {ticket.ceoNotes && ticket.ceoNotes.length > 0 && (
        <ul className="ceo-notes" aria-label="Your notes">
          {ticket.ceoNotes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {active && ["ready", "backlog", "in_progress", "review"].includes(ticket.status) && <TicketActions ticket={ticket} />}
      {ticket.status === "failed" && (
        <div className="actions">
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api.retry(ticket.id).catch(() => undefined);
              setBusy(false);
            }}
          >
            Retry
          </button>
          <button
            className="btn btn-quiet"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await api.skip(ticket.id).catch(() => undefined);
              setBusy(false);
            }}
          >
            Skip
          </button>
        </div>
      )}
    </article>
  );
}

export function Board({
  tickets,
  agents,
  areas,
  active = false,
}: {
  tickets: Ticket[];
  agents: Agent[];
  areas: Area[];
  /** The build is live, so the CEO can steer tickets. */
  active?: boolean;
}) {
  const shown = (c: { statuses: TicketStatus[] }) => tickets.some((t) => c.statuses.includes(t.status));
  const [needsYou, skipped] = EXTRA_COLUMNS as [(typeof EXTRA_COLUMNS)[number], (typeof EXTRA_COLUMNS)[number]];
  // Failures come first: they are waiting on you.
  const columns = [...(shown(needsYou) ? [needsYou] : []), ...COLUMNS, ...(shown(skipped) ? [skipped] : [])];

  if (tickets.length === 0) {
    return (
      <section className="board" aria-label="Job board">
        <div className="column">
          <p className="empty">Tickets appear here once you approve the plan.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="board" aria-label="Job board">
      {columns.map((col) => {
        const items = tickets
          .filter((t) => col.statuses.includes(t.status))
          .sort((a, b) => (col.title === "Merged" ? b.updatedAt - a.updatedAt : a.priority - b.priority || a.createdAt - b.createdAt));
        return (
          <div className="column" key={col.title}>
            <header>
              <h3>{col.title}</h3>
              <span>{items.length}</span>
            </header>
            {items.length === 0 && <p className="empty">{col.empty}</p>}
            {items.map((t) => (
              <TicketCard key={t.id} ticket={t} tickets={tickets} agents={agents} areas={areas} active={active} />
            ))}
          </div>
        );
      })}
    </section>
  );
}
