"use client";

import type { Project, ProjectPhase } from "@agentco/engine";
import type { Connection } from "@/lib/useBoard";

const PHASES: { label: string; phases: ProjectPhase[]; team?: "marketing" | "design" }[] = [
  { label: "PRD", phases: ["planning"] },
  { label: "Brand", phases: ["branding"], team: "marketing" },
  { label: "Design", phases: ["design"], team: "design" },
  { label: "Architecture", phases: ["architecture"] },
  { label: "Tickets", phases: ["ticketing"] },
  { label: "Build", phases: ["building", "paused"] },
  { label: "QA", phases: ["testing"] },
  { label: "Release", phases: ["releasing", "shipped"] },
];

export function svgUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function Header({
  project,
  status,
  connection,
  running,
  onNew,
  onStop,
  onPause,
  onResume,
}: {
  project: Project;
  status: string;
  connection: Connection;
  running: boolean;
  onNew: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const pausable = ["building", "testing", "paused"].includes(project.phase);
  // Older runs have no teams field: they had neither team.
  const steps = PHASES.filter((p) => !p.team || project.teams?.[p.team]);
  const current = steps.findIndex((p) => p.phases.includes(project.phase));
  const pct = Math.min(100, (project.spentUsd / project.budgetUsd) * 100);

  return (
    <header className="topbar">
      <div className="product">
        {project.brand && (
          // An <img> never runs scripts inside an SVG.
          <img className="logo" src={svgUrl(project.brand.logoSvg)} alt="" width={36} height={36} />
        )}
        <div>
          <h1 title={project.brand ? `${project.brand.tagline}\n\n${project.idea}` : project.idea}>{project.name}</h1>
          <p>{status}</p>
        </div>
      </div>

      <ol className="phases" aria-label="Progress">
        {steps.map((p, i) => {
          const done = project.phase === "shipped" || i < current;
          const now = i === current && project.phase !== "shipped";
          return (
            <li key={p.label} className={now ? "now" : done ? "past" : ""} aria-current={now ? "step" : undefined}>
              <span className="n">{i + 1}</span>
              {p.label}
              {now && (project.phase === "paused" || project.held) ? " (paused)" : ""}
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
        {running && pausable && (
          <button className="btn" onClick={project.held ? onResume : onPause}>
            {project.held ? "Resume" : "Pause"}
          </button>
        )}
        {running ? (
          <button className="btn btn-stop" onClick={onStop}>
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
