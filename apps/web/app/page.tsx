"use client";

import { useState } from "react";
import { Activity } from "@/components/Activity";
import { Board } from "@/components/Board";
import { Decision } from "@/components/Decision";
import { Header } from "@/components/Header";
import { StartForm } from "@/components/StartForm";
import { Team } from "@/components/Team";
import { api } from "@/lib/api";
import { useBoard } from "@/lib/useBoard";

export default function Home() {
  const { state, connection } = useBoard();
  const [starting, setStarting] = useState(false);

  if (connection === "connecting" && !state.project) {
    return <main className="start"><p className="lede">Connecting to the server...</p></main>;
  }
  if (connection === "offline" && !state.project) {
    return (
      <main className="start">
        <h1>Can't reach the server</h1>
        <p className="lede">Start it with <code>pnpm api</code>, then reload this page.</p>
      </main>
    );
  }
  if (!state.project || starting) {
    return <StartForm onCancel={state.project ? () => setStarting(false) : undefined} />;
  }

  const total = state.tickets.length;
  const merged = state.tickets.filter((t) => t.status === "done").length;
  const waiting = state.gates.some((g) => g.status === "pending");
  const status = waiting
    ? "Waiting on your decision"
    : ({
        idle: "Starting up",
        planning: "PM is writing the PRD",
        architecture: "Tech lead is designing the architecture",
        ticketing: "Task creator is filing tickets",
        building: `${merged} of ${total} tickets merged`,
        paused: "Paused at the budget",
        releasing: "Ready to release",
        shipped: `Shipped with all ${total} tickets merged`,
        failed: "Stopped. Retry failed tickets to continue.",
      } as const)[state.project.phase];

  return (
    <>
      <Header
        project={state.project}
        status={status}
        connection={connection}
        running={state.project.phase !== "shipped" && state.project.phase !== "failed"}
        onNew={() => setStarting(true)}
        onStop={() => void api.stop()}
      />
      <Decision gates={state.gates} />
      <div className="floor">
        <Team agents={state.agents} areas={state.areas} />
        <div>
          <h2 className="panel-title">Job board</h2>
          <Board tickets={state.tickets} agents={state.agents} areas={state.areas} />
        </div>
        <Activity log={state.log} />
      </div>
    </>
  );
}
