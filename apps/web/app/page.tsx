"use client";

import { useState } from "react";
import { Activity } from "@/components/Activity";
import { Board } from "@/components/Board";
import { Controls } from "@/components/Controls";
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
  const phase = state.project.phase;
  const live = !["shipped", "failed", "stopped"].includes(phase);
  const steering = ["building", "testing", "paused"].includes(phase);
  const status = waiting
    ? "Waiting on your decision"
    : state.project.held && steering
      ? `Paused by you · ${merged} of ${total} tickets merged`
      : ({
        idle: "Starting up",
        planning: "PM is writing the PRD",
        branding: "Marketing is naming and branding the product",
        design: state.agents.find((a) => a.id === "pm")?.status === "working"
          ? "PM is checking the design for feasibility"
          : "Designer is drafting the design",
        architecture: "Tech lead is designing the architecture",
        ticketing: "Task creator is filing tickets",
        building: `${merged} of ${total} tickets merged`,
        testing:
          state.agents.find((a) => a.id === "designer")?.status === "working"
            ? "Designer is reviewing the running screens"
            : "QA is testing the build",
        paused: "Paused at the budget",
        stopped: "Stopped by you. Continue it later from the start screen.",
        releasing: "Ready to release",
        shipped: merged === total ? `Shipped with all ${total} tickets merged` : `Shipped with ${merged} of ${total} tickets merged`,
        failed: "Stopped. Retry failed tickets to continue.",
      } as const)[state.project.phase];

  return (
    <>
      <Header
        project={state.project}
        status={status}
        connection={connection}
        running={live}
        onNew={() => setStarting(true)}
        onStop={() => void api.stop()}
        onPause={() => void api.pause()}
        onResume={() => void api.resume()}
      />
      <Decision gates={state.gates} />
      {steering && <Controls project={state.project} />}
      <div className="floor">
        <Team agents={state.agents} areas={state.areas} project={state.project} />
        <div>
          <h2 className="panel-title">Job board</h2>
          <Board tickets={state.tickets} agents={state.agents} areas={state.areas} active={steering} />
        </div>
        <Activity log={state.log} />
      </div>
    </>
  );
}
