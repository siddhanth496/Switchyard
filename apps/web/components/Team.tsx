"use client";

import { useEffect, useState } from "react";
import type { Agent, Area, Project } from "@agentco/engine";
import { api, type ModelOption, type ModelRole } from "@/lib/api";

const STANDING: Record<string, string> = { trusted: "Trusted", watch: "On watch", benched: "Benched" };

/** "claude-sonnet-5-5" → "Sonnet". */
function modelLabel(id?: string): string | null {
  const word = id?.replace(/^claude-/, "").split("-")[0];
  return word ? word[0]!.toUpperCase() + word.slice(1) : null;
}

/** Switch any role's model mid-run; tasks already running finish on their current model. */
function ModelsEditor({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ models: ModelOption[]; roles: ModelRole[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || options) return;
    api
      .config()
      .then((c) => setOptions({ models: c.models, roles: c.modelRoles }))
      .catch(() => setError("Couldn't load the models."));
  }, [open, options]);

  return (
    <details className="models-editor" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Models</summary>
      {options?.roles.map((r) => (
        <label key={r.role}>
          <span>{r.label}</span>
          <select
            value={project.models?.[r.role as keyof typeof project.models] ?? ""}
            onChange={(e) => {
              setError(null);
              api.setModels({ [r.role]: e.target.value }).catch((err: Error) => setError(err.message));
            }}
          >
            {options.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <p className="hint">Takes effect on each agent's next task.</p>
      {error && <p className="error">{error}</p>}
    </details>
  );
}

function AgentCard({ agent, model }: { agent: Agent; model?: string | null }) {
  const working = agent.status === "working";
  const card = agent.score;
  const standing = agent.standing && agent.standing !== "normal" ? agent.standing : null;
  return (
    <div className={`agent ${working ? "working" : ""}`}>
      <div className="row">
        <span className="name">
          {agent.name}
          {standing && <span className={`standing s-${standing}`}>{STANDING[standing]}</span>}
          {model && <span className="model-tag">{model}</span>}
        </span>
        {agent.currentTicket ? (
          <span className="ticket-tag">{agent.currentTicket}</span>
        ) : (
          <span className="meta">{working ? "Working" : "Idle"}</span>
        )}
      </div>
      <div className="doing" title={agent.activity}>
        {agent.activity || "Waiting for work"}
      </div>
      {card && card.delivered + card.reworks > 0 && (
        <div className="scoreline" title="The CFO's scorecard for this engineer">
          {card.delivered} delivered, {card.firstPass} first pass
          {card.reworks > 0 && <>, {card.reworks} sent back</>}
          {card.overruns > 0 && <>, {card.overruns} over budget</>}
          {card.bugs > 0 && <>, {card.bugs} bug{card.bugs > 1 ? "s" : ""}</>}
        </div>
      )}
      {agent.spentUsd > 0 && <div className="meta">${agent.spentUsd.toFixed(2)} spent</div>}
    </div>
  );
}

const GROUPS: { title: string; note?: string; roles: Agent["role"][] }[] = [
  { title: "Leadership", roles: ["pm", "tech_lead", "task_creator", "cfo", "qa"] },
  { title: "Design", note: "the PM rules on feasibility", roles: ["designer"] },
  { title: "Marketing", note: "name, logo, voice, launch", roles: ["marketing"] },
];

export function Team({ agents, areas, project }: { agents: Agent[]; areas: Area[]; project: Project }) {
  const floaters = agents.filter((a) => a.role === "engineer" && !a.area);
  const modelOf = (a: Agent) => modelLabel(project.models?.[a.role]);
  const live = !["shipped", "failed", "stopped"].includes(project.phase);
  return (
    <aside className="team" aria-label="Team">
      {project.models && live && <ModelsEditor project={project} />}
      {GROUPS.map((g) => {
        const members = agents.filter((a) => g.roles.includes(a.role));
        if (members.length === 0) return null;
        return (
          <div className="team-group" key={g.title}>
            <h3>
              {g.title}
              {g.note && <small>{g.note}</small>}
            </h3>
            {members.map((a) => (
              <AgentCard key={a.id} agent={a} model={modelOf(a)} />
            ))}
          </div>
        );
      })}
      {areas
        .map((area) => (
          <div className="team-group" key={area.id}>
            <h3>
              {area.name}
              <small>{area.paths.join(", ")}</small>
            </h3>
            {agents
              .filter((a) => a.role === "engineer" && a.area === area.id)
              .map((a) => (
                <AgentCard key={a.id} agent={a} model={modelOf(a)} />
              ))}
          </div>
        ))}
      {floaters.length > 0 && (
        <div className="team-group">
          <h3>
            Floating<small>lent where the backlog builds</small>
          </h3>
          {floaters.map((a) => (
            <AgentCard key={a.id} agent={a} model={modelOf(a)} />
          ))}
        </div>
      )}
    </aside>
  );
}
