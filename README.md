# Agent Company

An AI software company that builds a product from scratch. You are the CEO. A PM, tech lead, task creator, engineers and a CFO work as agents, in parallel, coordinated through a job board.

```
idea → PRD (you approve) → architecture + ownership areas (you approve)
     → tagged tickets → parallel build in git worktrees → review → merge
     → release (you approve)
```

## Quick start

Requires Node 20+, pnpm and git.

```bash
pnpm install
pnpm test          # engine tests: dispatcher rules + full runs with real git
pnpm demo          # scripted end-to-end run in the terminal, no API key
```

Run the dashboard (two processes):

```bash
pnpm server        # API + live events on http://localhost:4000
pnpm web           # UI on http://localhost:3000
```

Pick **Demo agents** in the UI to watch the flow for free, or **Claude agents** for real work.

### Using real Claude agents

Claude agents run through the [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview) and need an Anthropic API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
RUNNER=claude pnpm server        # makes Claude the default in the UI
# or from the terminal, with gates prompted in the shell:
pnpm --filter @agentco/engine agentco run "a habit tracker for small teams"
```

Engineers can edit files and run shell commands inside their worktrees. **Run the server in a container or VM** when using real agents.

## How the job board works

This is the core of the design.

- **Task creator (LLM)** breaks the PRD into tickets, each tagged with the files it will touch and its dependencies. Work that crosses areas is split into one ticket per area.
- **Dispatcher (plain code, no LLM)** assigns ready tickets each tick:
  1. all dependencies are done;
  2. the ticket's area is under its parallel limit (shared areas run one ticket at a time);
  3. no live **file lease** overlaps the ticket's files;
  4. an idle member of the area takes it, the area lead first. If the area's backlog reaches the lending threshold, an idle engineer is **lent**: a floater first, then one whose own area has nothing ready.
- **Ownership areas** are path prefixes defined by the tech lead and approved by you. Each area has a lead; hotspots (manifests, schema) go in a small shared area owned by the tech lead.
- **File leases** are held from start until merge. If an engineer touches files another ticket holds, the attempt is discarded and sent back.
- **Owner notes** (`docs/owners/<area>.md` in the product repo) carry context across sessions. Engineers read them before each ticket; after a merge, the engineer's notes are recorded under the area lead's name, so the lead is the single writer.
- **Retries**: rejected reviews and failed builds go back to *ready* with feedback. After 3 attempts a ticket fails; you can retry it from the board.
- **CFO** tracks spend per ticket and agent. At the budget, dispatch pauses until you approve more.

## Layout

```
packages/engine/       the company: board, dispatcher, agents, git, orchestrator
  src/core/            types, board store, paths + ownership, dispatcher
  src/agents/          role prompts, output schemas, Claude + mock runners
  src/git/             product repo with one worktree per running ticket
  src/orchestrator/    the pipeline and build loop
  test/                unit tests + end-to-end runs with real git
apps/server/           Hono API + server-sent events
apps/web/              Next.js dashboard
workspace/             generated product repos (gitignored)
```

## API

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/state` | |
| GET | `/api/events` | SSE: `snapshot`, then `board` events |
| POST | `/api/projects` | `{ idea, runner?, engineersPerArea?, floaters?, budgetUsd?, model? }` |
| POST | `/api/gates/:id/approve` | `{ feedback? }` |
| POST | `/api/gates/:id/reject` | `{ feedback }` |
| POST | `/api/tickets/:id/retry` | |
| POST | `/api/stop` | |

## What's next

- Designer and QA agents
- Postgres-backed board so projects survive restarts
- Per-ticket sandboxes (containers) for engineers
- Scale agents per area automatically from queue length
- Lease violation detection during the build, not only at commit
