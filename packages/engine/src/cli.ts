#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { ClaudeRunner } from "./agents/claude.js";
import { MockRunner } from "./agents/mock.js";
import type { AgentRunner } from "./agents/runner.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";

const USAGE = `Usage:
  agentco demo                       Scripted run with mock agents (no API key)
  agentco run "<idea>" [options]     Build a product with Claude agents

Options:
  --auto              Approve every CEO gate automatically
  --engineers <n>     Engineers per area (default 1)
  --floaters <n>      Floating engineers (default 1)
  --budget <usd>      Spend before a budget gate (default 20)
  --model <id>        Model for all agents
  --workspace <dir>   Where product repos are created (default ./workspace)`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      auto: { type: "boolean", default: false },
      engineers: { type: "string" },
      floaters: { type: "string" },
      budget: { type: "string" },
      model: { type: "string" },
      workspace: { type: "string", default: "./workspace" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command || !["demo", "run"].includes(command)) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const demo = command === "demo";
  const idea = demo ? "A minimal notes app with login" : rest.join(" ");
  if (!idea) {
    console.error('Give the idea in quotes: agentco run "a habit tracker for teams"');
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!demo && !apiKey) {
    console.error("Set ANTHROPIC_API_KEY first: export ANTHROPIC_API_KEY=sk-ant-api...");
    process.exit(1);
  }
  const budget = Number(values.budget ?? 20);
  const runner: AgentRunner = demo
    ? new MockRunner({ stepMs: 40, rejectFirstReviewOf: ["Notes CRUD API"] })
    : new ClaudeRunner({ model: values.model, apiKey, maxBudgetUsdPerTask: Math.max(0.5, budget / 4) });

  const orch = new Orchestrator(runner, {
    workspaceDir: values.workspace!,
    engineersPerArea: Number(values.engineers ?? 1),
    floaters: Number(values.floaters ?? 1),
    budgetUsd: budget,
    autoApprove: demo || values.auto ? "all" : [],
    tickMs: demo ? 50 : 500,
  });

  const rl = demo || values.auto ? null : createInterface({ input: process.stdin, output: process.stdout });

  let phase = "";
  orch.board.on((e) => {
    if (e.type === "log") {
      const icon = e.entry.level === "error" ? "✖" : e.entry.level === "warn" ? "!" : "·";
      console.log(`${icon} ${e.entry.message}`);
    } else if (e.type === "project") {
      if (e.project && e.project.phase !== phase) {
        phase = e.project.phase;
        console.log(`\n== ${phase.toUpperCase()} ==`);
      }
    } else if (e.type === "gate" && e.gate.status === "pending" && rl) {
      void (async () => {
        console.log(`\n--- ${e.gate.title} ---\n${e.gate.content}\n`);
        const answer = (await rl.question("Approve? [y / or type feedback to reject] ")).trim();
        if (answer === "" || /^y(es)?$/i.test(answer)) orch.approve(e.gate.id);
        else orch.reject(e.gate.id, answer);
      })();
    }
  });

  const project = await orch.run(idea);
  rl?.close();
  const done = orch.board.tickets.filter((t) => t.status === "done").length;
  console.log(`\nPhase: ${project.phase}`);
  console.log(`Tickets done: ${done}/${orch.board.tickets.length}`);
  console.log(`Spend: $${project.spentUsd.toFixed(2)}`);
  console.log(`Repo: ${project.dir}`);
  process.exit(project.phase === "shipped" ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
