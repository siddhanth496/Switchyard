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

function TicketCard({
  ticket,
  tickets,
  agents,
  areas,
}: {
  ticket: Ticket;
  tickets: Ticket[];
  agents: Agent[];
  areas: Area[];
}) {
  const [busy, setBusy] = useState(false);
  const area = areas.find((a) => a.id === ticket.area);
  const assignee = agents.find((a) => a.id === ticket.assignee);
  const waitingOn = ticket.dependsOn.filter((d) => tickets.find((t) => t.id === d)?.status !== "done");
  const lent = assignee && assignee.area !== ticket.area && ticket.status !== "done";

  return (
    <article className={`ticket s-${ticket.status}`}>
      <div className="top">
        <span className="id">{ticket.id}</span>
        <span>{area?.name ?? ticket.area}</span>
      </div>
      <div className="title">{ticket.title}</div>
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
      {ticket.attempts > 0 && ticket.status !== "done" && <div className="line">Attempt {ticket.attempts + 1}</div>}
      {ticket.feedback && ticket.status !== "done" && <div className="feedback">{ticket.feedback}</div>}
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
            Retry ticket
          </button>
        </div>
      )}
    </article>
  );
}

export function Board({ tickets, agents, areas }: { tickets: Ticket[]; agents: Agent[]; areas: Area[] }) {
  const failed = tickets.filter((t) => t.status === "failed");
  const columns = failed.length > 0 ? [...COLUMNS, { title: "Failed", statuses: ["failed"] as TicketStatus[], empty: "" }] : COLUMNS;

  if (tickets.length === 0) {
    return (
      <section className="board" aria-label="Job board">
        <div className="column">
          <p className="empty">Tickets appear here once the PRD and architecture are approved.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="board" aria-label="Job board" style={{ "--cols": columns.length } as React.CSSProperties}>
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
              <TicketCard key={t.id} ticket={t} tickets={tickets} agents={agents} areas={areas} />
            ))}
          </div>
        );
      })}
    </section>
  );
}
