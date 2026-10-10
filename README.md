# Agent Company

An AI software company that builds a product from scratch. You are the CEO. A PM, tech lead, task creator, engineers, QA and a CFO work as agents, in parallel, coordinated through a job board.

```
idea → PRD (you approve) → architecture + ownership areas (you approve)
     → tagged tickets → parallel build in git worktrees → review → merge
     → QA tests the build, files bugs as tickets, re-tests → release (you approve)
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

### Changing a product

- **Hold the release with feedback** ("Request changes" on the release card): the task creator turns your note into change tickets, the team builds them, QA re-tests, and the release card comes back as round 2.
- **Continue a product later:** on the start screen choose *Continue a product*, pick one from your workspace and describe the change. The PM updates the PRD (you approve it), the team reuses the product's saved ownership areas (`docs/areas.json`), builds only the change, QA tests it, and you approve the release. Products built before areas were saved get a quick architecture pass from the tech lead first.
- Change tickets are priced at the plan's rates, and small plans are priced as if they had 10 budget units, so one small change can't claim the whole budget.

### Where product repos go

Each product gets its own git repo in `~/switchyard-workspace` by default (set `WORKSPACE` to change it). Keep it out of iCloud-synced folders such as Desktop and Documents: iCloud makes `file 2` copies of fast-changing files, which corrupts the agents' git worktrees. The server warns if the workspace looks synced. New product repos start with a `.gitignore` for dependencies, builds and secrets.

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
  2. the ticket's area is under its parallel limit (one ticket per engineer in the area);
  3. no live **file lease** overlaps the ticket's files;
  4. an idle member of the area takes it, the area lead first. If the area's backlog reaches the lending threshold, an idle engineer is **lent**: a floater first, then one whose own area has nothing ready.
- **Ownership areas** are path prefixes defined by the tech lead and approved by you. Each area, including the small shared area for hotspots (manifests, schema), has its own engineers and a lead. The tech lead doesn't build: it reviews every PR and takes escalated tickets, so it never becomes a single lane everyone queues behind.
- **File leases** are held from start until merge. If an engineer touches files another ticket holds, the attempt is discarded and sent back.
- **Owner notes** (`docs/owners/<area>.md` in the product repo) carry context across sessions. Engineers read them before each ticket; after a merge, the engineer's notes are recorded under the area lead's name, so the lead is the single writer.
- **Failures don't block the build.** A rejected review, failed build or merge conflict sends the ticket back with feedback. The owner gets the first two attempts; the third is **escalated to the tech lead** with the full failure history (and, with Claude agents, the next model up: Haiku → Sonnet → Opus). If that fails too, a decision card asks you to **retry with guidance** or **skip** the ticket. Independent tickets keep building while you decide. Skipped tickets count as resolved: dependents start, told to stub around the missing work, and the release notes list what was skipped. In unattended runs (`--auto`), failed tickets are skipped rather than retried, so a broken ticket can't burn the budget.
- **QA** tests the merged build against the PRD in a throwaway worktree once the board is clear: it installs, runs tests and walks through the main flows, but never fixes code. Each bug becomes a ticket (tagged *Bug*) in the right area and goes through the normal flow ahead of other work, then QA re-tests. After 2 rounds (`qaRounds`), anything still broken is listed as a known issue on the release card instead of looping. Set `qaRounds: 0` to turn QA off.
- **Batching:** when no other engineer is free (including ones that could be lent), up to 3 related tickets in one area (same folder, or a chain) are built in one session: one branch, one review, one merge. A rejected batch splits back into single tickets for the retry. Set `maxBatch: 1` to turn it off.
- **CFO budgets:** the task creator sizes each ticket S/M/L; the CFO splits the project budget across tickets by size (1/2/4 units), keeping 25% for reviews, QA and retries. Engineers see their ticket budget in the prompt, and a run is cut off at the budget times a headroom (2x trusted, 1.5x normal, 1x on watch). At the project budget, dispatch pauses until you approve more.
- **Rewards and penalties:** the CFO scores every delivery and failure: +2 first pass, +1 on budget, +1 efficient (first pass at 60% of budget or less), -1 over budget, -1 sent back, -2 cut off for overspending, -2 when QA traces a bug to the ticket. Cost is never rewarded on its own. The last 5 events set an engineer's standing: *trusted* engineers get first pick of big tickets and more headroom; engineers *on watch* get small tickets, a tight cap and a warning in their prompt; *benched* engineers get no work until two more merges land. Penalties wear off after a few good tickets.

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
~/switchyard-workspace/  generated product repos (set WORKSPACE to change)
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
