"use client";

import type { Project, ProjectPhase } from "@agentco/engine";
import type { Connection } from "@/lib/useBoard";

const PHASES: { label: string; phases: ProjectPhase[] }[] = [
  { label: "PRD", phases: ["planning"] },
  { label: "Architecture", phases: ["architecture"] },
  { label: "Tickets", phases: ["ticketing"] },
  { label: "Build", phases: ["building", "paused"] },
  { label: "QA", phases: ["testing"] },
  { label: "Release", phases: ["releasing", "shipped"] },
];

export function Header({
  project,
  status,
  connection,
  running,
  onNew,
  onStop,
}: {
  project: Project;
  status: string;
  connection: Connection;
  running: boolean;
  onNew: () => void;
  onStop: () => void;
}) {
  const current = PHASES.findIndex((p) => p.phases.includes(project.phase));
  const pct = Math.min(100, (project.spentUsd / project.budgetUsd) * 100);

  return (
    <header className="topbar">
      <div className="product">
        <h1 title={project.idea}>{project.name}</h1>
        <p>{status}</p>
      </div>

      <ol className="phases" aria-label="Progress">
        {PHASES.map((p, i) => {
          const done = project.phase === "shipped" || i < current;
          const now = i === current && project.phase !== "shipped";
          return (
            <li key={p.label} className={now ? "now" : done ? "past" : ""} aria-current={now ? "step" : undefined}>
              <span className="n">{i + 1}</span>
              {p.label}
              {now && project.phase === "paused" ? " (paused)" : ""}
            </li>
          );
        })}
      </ol>

      <div className="right">
        <div className="spend" aria-label="Spend">
          <div className="figures">
            <strong>${project.spentUsd.toFixed(2)}</strong> of ${project.budgetUsd.toFixed(2)}
          </div>
          <div className="bar">
            <span className={pct >= 100 ? "over" : ""} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <span className={`conn ${connection}`}>{connection === "live" ? "Live" : connection === "offline" ? "Offline" : "Connecting"}</span>
        {running ? (
          <button className="btn" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="btn" onClick={onNew}>
            New product
          </button>
        )}
      </div>
    </header>
  );
}
