"use client";

import type { LogEntry } from "@agentco/engine";

export function Activity({ log }: { log: LogEntry[] }) {
  const items = [...log].reverse().slice(0, 150);
  return (
    <aside className="activity" aria-label="Activity">
      <h2 className="panel-title">Activity</h2>
      {items.length === 0 ? (
        <p className="panel-title" style={{ fontWeight: 400 }}>
          Nothing yet.
        </p>
      ) : (
        <ol>
          {items.map((e, i) => (
            <li key={`${e.at}-${i}`} className={e.level}>
              <time dateTime={new Date(e.at).toISOString()}>
                {new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
              </time>
              <span>{e.message}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
