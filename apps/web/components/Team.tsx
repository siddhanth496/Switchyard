"use client";

import type { Agent, Area } from "@agentco/engine";

const STANDING: Record<string, string> = { trusted: "Trusted", watch: "On watch", benched: "Benched" };

function AgentCard({ agent }: { agent: Agent }) {
  const working = agent.status === "working";
  const card = agent.score;
  const standing = agent.standing && agent.standing !== "normal" ? agent.standing : null;
  return (
    <div className={`agent ${working ? "working" : ""}`}>
      <div className="row">
        <span className="name">
          {agent.name}
          {standing && <span className={`standing s-${standing}`}>{STANDING[standing]}</span>}
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

export function Team({ agents, areas }: { agents: Agent[]; areas: Area[] }) {
  const leadership = agents.filter((a) => a.role !== "engineer");
  const floaters = agents.filter((a) => a.role === "engineer" && !a.area);
  return (
    <aside className="team" aria-label="Team">
      <div className="team-group">
        <h3>Leadership</h3>
        {leadership.map((a) => (
          <AgentCard key={a.id} agent={a} />
        ))}
      </div>
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
                <AgentCard key={a.id} agent={a} />
              ))}
          </div>
        ))}
      {floaters.length > 0 && (
        <div className="team-group">
          <h3>
            Floating<small>lent where the backlog builds</small>
          </h3>
          {floaters.map((a) => (
            <AgentCard key={a.id} agent={a} />
          ))}
        </div>
      )}
    </aside>
  );
}
