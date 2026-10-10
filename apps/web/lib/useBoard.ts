"use client";

import { useEffect, useReducer, useState } from "react";
import type { BoardEvent, BoardSnapshot } from "@agentco/engine";
import { API_URL } from "./api";

export type ServerState = BoardSnapshot & { running: boolean; runner: string };

const EMPTY: ServerState = {
  project: null,
  tickets: [],
  areas: [],
  agents: [],
  leases: [],
  gates: [],
  log: [],
  running: false,
  runner: "mock",
};

type Action = { kind: "snapshot"; state: ServerState } | { kind: "event"; event: BoardEvent };

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function reducer(state: ServerState, action: Action): ServerState {
  if (action.kind === "snapshot") return action.state;
  const e = action.event;
  switch (e.type) {
    case "reset":
      return { ...state, ...e.snapshot };
    case "project":
      return { ...state, project: e.project };
    case "ticket":
      return { ...state, tickets: upsert(state.tickets, e.ticket) };
    case "agent":
      return { ...state, agents: upsert(state.agents, e.agent) };
    case "areas":
      return { ...state, areas: e.areas };
    case "leases":
      return { ...state, leases: e.leases };
    case "gate":
      return { ...state, gates: upsert(state.gates, e.gate) };
    case "log":
      return { ...state, log: [...state.log.slice(-299), e.entry] };
  }
}

export type Connection = "connecting" | "live" | "offline";

/** Live board state: a snapshot, then every board event over SSE. */
export function useBoard(): { state: ServerState; connection: Connection } {
  const [state, dispatch] = useReducer(reducer, EMPTY);
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    const source = new EventSource(`${API_URL}/api/events`);
    source.addEventListener("snapshot", (m) => {
      dispatch({ kind: "snapshot", state: JSON.parse((m as MessageEvent).data) });
      setConnection("live");
    });
    source.addEventListener("board", (m) => {
      dispatch({ kind: "event", event: JSON.parse((m as MessageEvent).data) });
    });
    source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? "offline" : "connecting");
    return () => source.close();
  }, []);

  return { state, connection };
}
