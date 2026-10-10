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
pnpm api           # API + live events on http://localhost:4000
pnpm web           # UI on http://localhost:3000
```

Pick **Demo agents** in the UI to watch the flow for free, or **Claude agents** for real work. To try the failure flow with demo agents, start the API with `MOCK_FAIL="App shell" pnpm api`: that ticket always fails.

### Using real Claude agents

Claude agents run through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) and are billed to an Anthropic API key from [console.anthropic.com](https://console.anthropic.com).

On the start screen, choose **Claude agents**, paste your API key, pick a model and set a budget:

- **API key**: held only in the server's memory, never written to disk or logged, and cleared when the server stops. The UI only ever shows its last 4 characters. You can also set `ANTHROPIC_API_KEY` before `pnpm api` instead.
- **Model**: Haiku 5.5 (cheapest, good for testing), Sonnet 5.5 or Opus 5.5.
- **Budget**: work pauses at the budget until you approve more, and no single agent task can spend more than a quarter of it.

When a key is set, agents always authenticate with it. Other credential settings in the environment (OAuth tokens, cloud providers) are ignored, so a Claude subscription login on the same machine is never used.

From the terminal, with gates prompted in the shell:

```bash
export ANTHROPIC_API_KEY=sk-ant-api...
pnpm --filter @agentco/engine agentco run "a habit tracker for small teams" --model claude-haiku-5-5 --budget 3
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
- **Failures don't block the build.** A rejected review, failed build or merge conflict sends the ticket back with feedback. The owner gets the first two attempts; the third is **escalated to the tech lead** with the full failure history (and, with Claude agents, the next model up: Haiku → Sonnet → Opus). If that fails too, a decision card asks you to **retry with guidance** or **skip** the ticket. Independent tickets keep building while you decide. Skipped tickets count as resolved: dependents start, told to stub around the missing work, and the release notes list what was skipped. In unattended runs (`--auto`), failed tickets are skipped rather than retried, so a broken ticket can't burn the budget.
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
| GET | `/api/config` | key status (last 4 only), models |
| PUT | `/api/config/key` | `{ key }` |
| DELETE | `/api/config/key` | |
| POST | `/api/projects` | `{ idea, runner?, engineersPerArea?, floaters?, budgetUsd?, model? }` |
| POST | `/api/gates/:id/approve` | `{ feedback? }` |
| POST | `/api/gates/:id/reject` | `{ feedback }` |
| POST | `/api/tickets/:id/retry` | `{ guidance? }` |
| POST | `/api/tickets/:id/skip` | |
| POST | `/api/stop` | |

## What's next

- Designer and QA agents
- Postgres-backed board so projects survive restarts
- Per-ticket sandboxes (containers) for engineers
- Scale agents per area automatically from queue length
- Lease violation detection during the build, not only at commit
