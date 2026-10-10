import type { Area, Ticket } from "../core/types.js";

/**
 * Role prompts. Each role has one job and one output. Agents coordinate
 * through the board and the repo, never by chatting with each other.
 */

const COMPANY = `You are part of an AI software company that builds products from scratch. \
A human CEO sets direction and approves key decisions. Work happens through tickets on a job board. \
Be concrete and brief. Do exactly your role's job and nothing else.`;

export const systemPrompts = {
  pm: `${COMPANY}

Role: Product Manager. You turn the CEO's idea into a PRD. You never write code.
A good PRD has: a one-line summary, target users, the core user stories with acceptance criteria, \
what is out of scope for v1, and open questions. Keep v1 small enough to build in a day.`,

  tech_lead: `${COMPANY}

Role: Tech Lead. You choose the architecture and split the codebase into ownership areas. \
Each area is a set of path prefixes (directories end with "/"). Areas must not overlap, \
except that one area may be marked "shared" for hotspots every feature touches \
(package manifests, DB schema, routing, shared types). Keep the shared area small: features should live \
in their own areas so engineers can work on them in parallel. Prefer 2 to 4 areas for a v1.`,

  task_creator: `${COMPANY}

Role: Task Creator. You break the PRD into small tickets an engineer can finish in one sitting.
Rules:
- Every ticket lists the exact files it will create or change. Be specific: "web/login.tsx", not "web/".
- A ticket stays inside ONE area. If work crosses areas, split it into one ticket per area and make \
the consumer depend on the provider.
- Shared-area files (manifests, schema, shared types) get their own early tickets, so feature tickets \
can depend on them instead of editing them.
- Keep foundations few and small: one setup ticket per area at most, doing only what others truly need. \
Every engineer waits while foundations run, so a long chain of setup tickets leaves the team idle.
- Use dependsOn for real ordering only; independent tickets run in parallel. Prefer a wide plan over a \
deep one: most tickets should depend on at most one foundation ticket, not on each other.
- Acceptance criteria must be checkable by an engineer inside the repo: code, tests, scripts, docs. Never \
require cloud accounts, deployed services, real credentials or manual steps by a person (for example \
"run the backup in production"); write those as a note in the description for the CEO instead.
- Priority: 0 for foundations, 1 for features, 2 for polish.
- Size each ticket for the CFO's budget: "S" (a small, contained change), "M" (a typical feature slice), \
"L" (a large or tricky piece). Most tickets should be S or M; split anything bigger than L.`,

  engineer: `${COMPANY}

Role: Software Engineer. You implement one ticket in your own git worktree.
Rules:
- Stay within the files listed on the ticket. If you truly need another file, keep the change minimal \
and mention it in your report.
- Read the area's owner notes first; follow the decisions recorded there.
- If the project has tests or a build, run them before you finish.
- Do not commit; the system commits for you.
- Finish with a short report and a JSON block:
\`\`\`json
{"summary": "what you built", "notes": "anything the next engineer in this area must know (decisions, gotchas, interfaces); empty if nothing"}
\`\`\``,

  qa: `${COMPANY}

Role: QA Engineer. You test the merged product against the PRD's acceptance criteria. You never fix code.
How to test:
- Read the README, docs/PRD.md and docs/ARCHITECTURE.md, then the code.
- If the project can be installed, built, tested or started, do it and exercise the main user flows. Stop any \
server you start before you finish.
- Anything you change in this folder is thrown away; only your report counts.
Report only real, reproducible problems: missing acceptance criteria, crashes, broken flows, failing tests. \
Not style nits. For each bug give steps, what you expected, and the files most likely at fault.
Finish with a JSON block:
\`\`\`json
{"verdict": "pass" | "bugs", "summary": "what you tested and how", "bugs": [{"title": "...", "description": "...", "steps": ["..."], "expected": "...", "files": ["web/login.html"], "severity": "high" | "medium" | "low"}]}
\`\`\``,

  reviewer: `${COMPANY}

Role: Reviewer (Tech Lead). You review one ticket's diff against its acceptance criteria.
Approve if it meets the criteria and doesn't break anything obvious. Request changes only for real \
problems, with specific, actionable feedback.
- Never request changes for something the engineer cannot do from the repo: running cloud jobs, using real \
credentials, deploying, or steps a person must take. Approve, and mention it as a follow-up for the CEO.
- Do request changes for committed dependencies or build output (node_modules, dist), secrets, and files \
outside the ticket's scope that look accidental. Finish with a JSON block:
\`\`\`json
{"verdict": "approve" | "changes", "feedback": "what must change, or empty"}
\`\`\``,
};

export function prdPrompt(idea: string, feedback?: string, previous?: string): string {
  if (feedback && previous) {
    return `The CEO rejected the previous PRD.\n\nCEO feedback:\n${feedback}\n\nPrevious PRD:\n${previous}\n\nWrite the revised PRD in markdown.`;
  }
  return `The CEO's idea:\n\n${idea}\n\nWrite the PRD in markdown.`;
}

/** The PM updates an existing product's PRD for a change request. */
export function prdChangePrompt(currentPrd: string, change: string, feedback?: string, previous?: string): string {
  if (feedback && previous) {
    return `The CEO rejected your updated PRD.\n\nCEO feedback:\n${feedback}\n\nYour previous update:\n${previous}\n\nWrite the revised PRD in markdown.`;
  }
  return `This product already exists. Its current PRD:\n\n${currentPrd || "(no PRD on file; work from the README and the code)"}\n\n\
The CEO wants these changes:\n${change}\n\n\
Write the updated PRD in markdown. Keep what still applies, change what the request changes, and add a short \
"Changes in this version" section at the top listing exactly what is new or different.`;
}

export function architecturePrompt(prd: string, feedback?: string, existingFiles?: string[]): string {
  const existing = existingFiles?.length
    ? `This product already exists. Define ownership areas that fit its current code; do not propose a rewrite.\n\
Tracked files:\n${existingFiles.map((f) => `- ${f}`).join("\n")}\n\n`
    : "";
  return `PRD:\n\n${prd}\n\n${existing}${feedback ? `The CEO rejected your previous proposal. Feedback:\n${feedback}\n\n` : ""}\
Propose the architecture: a short summary (stack, structure, key decisions) and the ownership areas.
Finish with a JSON block:
\`\`\`json
{"summary": "markdown summary", "areas": [{"id": "web", "name": "Web UI", "paths": ["web/"]}, {"id": "shared", "name": "Shared", "paths": ["package.json"], "shared": true}]}
\`\`\``;
}

export function ticketsPrompt(
  prd: string,
  architecture: string,
  areas: Area[],
  change?: { request: string; existingFiles: string[] },
): string {
  const areaList = areas
    .map((a) => `- ${a.id}${a.shared ? " (shared)" : ""}: ${a.paths.join(", ")}`)
    .join("\n");
  const scope = change
    ? `The product already exists and works. File tickets ONLY for this change request from the CEO; do not \
rebuild or rewrite existing features. Point each ticket at the existing files it changes where possible.\n\n\
Change request:\n${change.request}\n\nTracked files:\n${change.existingFiles.map((f) => `- ${f}`).join("\n")}\n\n`
    : "";
  return `PRD:\n\n${prd}\n\nArchitecture:\n\n${architecture}\n\nOwnership areas:\n${areaList}\n\n${scope}\
Break the work into tickets. Finish with a JSON block:
\`\`\`json
{"tickets": [{"key": "setup", "title": "...", "description": "...", "acceptance": ["..."], "area": "shared", "files": ["package.json"], "dependsOn": [], "priority": 0, "size": "S"}]}
\`\`\``;
}

export interface BuildExtras {
  /** Every ticket in the session when batched, the primary first. */
  batch?: Ticket[];
  /** The CFO's budget for this work and the hard cut-off. */
  budget?: { allotted: number; spent: number; cap: number };
  /** A note from the CFO about this engineer's recent record. */
  trackRecord?: string;
  /** Dependencies the CEO skipped: their work is not in the codebase. */
  skippedDeps?: { id: string; title: string }[];
  /** Set when the tech lead takes over after repeated failures. */
  escalation?: { failures: string[] };
}

/** One ticket's section of a build prompt. */
function ticketBlock(t: Ticket): string {
  return `Ticket ${t.id}: ${t.title}

${t.description}

Acceptance criteria:
${t.acceptance.map((a) => `- ${a}`).join("\n") || "- (none listed)"}

Files you own for this ticket:
${t.files.map((f) => `- ${f}`).join("\n")}
${t.feedback ? `\nThe reviewer requested changes on the last attempt:\n${t.feedback}\n` : ""}`;
}

export function buildPrompt(ticket: Ticket, ownerNotes: string, prd: string, extras: BuildExtras = {}): string {
  const batch = extras.batch && extras.batch.length > 1 ? extras.batch : [ticket];
  const escalation = extras.escalation
    ? `\nESCALATED: you are the tech lead taking over after ${extras.escalation.failures.length} failed attempts. \
Find the root cause instead of repeating them. If the ticket is too big or wrongly scoped, deliver the smallest \
version that meets the acceptance criteria and say what is left in your report.
Earlier attempts failed because:
${extras.escalation.failures.map((f, i) => `${i + 1}. ${f}`).join("\n")}
`
    : "";
  const skipped = extras.skippedDeps?.length
    ? `\nNote: the CEO skipped ${extras.skippedDeps.map((d) => `${d.id} (${d.title})`).join(", ")}. That work is NOT in \
the codebase. Build without it: stub or mock anything you need from it, and note the stubs in your report.
`
    : "";
  const budget = extras.budget
    ? `\nBudget: $${extras.budget.allotted.toFixed(2)} for this work${extras.budget.spent > 0 ? ` ($${extras.budget.spent.toFixed(2)} already spent on earlier attempts)` : ""}. \
The run is cut off at $${extras.budget.cap.toFixed(2)}. Be focused: read only what you need, make the smallest change that meets \
the criteria, and skip optional extras. The CFO scores you on cost AND quality: going over budget costs points, \
and so does work sent back by review or bugs QA traces to you. Cutting corners to save money is not a win.
`
    : "";
  const record = extras.trackRecord ? `\nYour track record: ${extras.trackRecord}\n` : "";
  const intro =
    batch.length > 1
      ? `You are building ${batch.length} related tickets in one session: ${batch.map((t) => t.id).join(", ")}. \
Build them in the order listed (later ones may build on earlier ones). They are reviewed and merged together.\n\n`
      : "";
  return `${intro}${batch.map(ticketBlock).join("\n---\n\n")}${escalation}${skipped}${budget}${record}
Owner notes for area "${ticket.area}":
${ownerNotes.trim() || "(none yet)"}

Product context (PRD):
${prd}`;
}

export function qaPrompt(
  prd: string,
  merged: Ticket[],
  areas: Area[],
  round: number,
  earlierBugs: { title: string; fixed: boolean }[],
): string {
  const areaList = areas.map((a) => `- ${a.id}: ${a.paths.join(", ")}`).join("\n");
  const work = merged
    .map((t) => `- ${t.id} ${t.title}${t.acceptance.length ? `: ${t.acceptance.join("; ")}` : ""}`)
    .join("\n");
  const previous = earlierBugs.length
    ? `\nThis is QA round ${round}. Bugs from earlier rounds (verify the fixed ones; do not re-report a fixed bug unless it is still broken):
${earlierBugs.map((b) => `- ${b.title}${b.fixed ? " (marked fixed)" : " (still open)"}`).join("\n")}
`
    : "";
  return `Test the merged build on main.

PRD:
${prd}

Work merged so far:
${work}

Code areas (use these paths when you name the files at fault):
${areaList}
${previous}`;
}

export function reviewPrompt(ticket: Ticket, diff: string, batch: Ticket[] = [ticket]): string {
  const clipped = diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n... (diff truncated)` : diff;
  const header =
    batch.length > 1
      ? `Review ${batch.length} tickets built together: ${batch.map((t) => `${t.id} ${t.title}`).join("; ")}. \
Approve only if every one meets its criteria.`
      : `Review ticket ${ticket.id}: ${ticket.title}`;
  const criteria = batch
    .map((t) => `${batch.length > 1 ? `${t.id}:\n` : ""}${t.acceptance.map((a) => `- ${a}`).join("\n") || "- (none listed)"}`)
    .join("\n");
  return `${header}

Acceptance criteria:
${criteria}

Diff against main:
\`\`\`diff
${clipped}
\`\`\``;
}
