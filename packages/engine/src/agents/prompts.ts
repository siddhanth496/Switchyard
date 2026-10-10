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
(package manifests, DB schema, routing, shared types). Shared files are worked on one ticket at a time, \
so keep the shared area small. Prefer 2 to 4 areas for a v1.`,

  task_creator: `${COMPANY}

Role: Task Creator. You break the PRD into small tickets an engineer can finish in one sitting.
Rules:
- Every ticket lists the exact files it will create or change. Be specific: "web/login.tsx", not "web/".
- A ticket stays inside ONE area. If work crosses areas, split it into one ticket per area and make \
the consumer depend on the provider.
- Shared-area files (manifests, schema, shared types) get their own early tickets, so feature tickets \
can depend on them instead of editing them.
- Use dependsOn for real ordering only; independent tickets run in parallel.
- Priority: 0 for foundations, 1 for features, 2 for polish.`,

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
problems, with specific, actionable feedback. Finish with a JSON block:
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

export function architecturePrompt(prd: string, feedback?: string): string {
  return `PRD:\n\n${prd}\n\n${feedback ? `The CEO rejected your previous proposal. Feedback:\n${feedback}\n\n` : ""}\
Propose the architecture for v1: a short summary (stack, structure, key decisions) and the ownership areas.
Finish with a JSON block:
\`\`\`json
{"summary": "markdown summary", "areas": [{"id": "web", "name": "Web UI", "paths": ["web/"]}, {"id": "shared", "name": "Shared", "paths": ["package.json"], "shared": true}]}
\`\`\``;
}

export function ticketsPrompt(prd: string, architecture: string, areas: Area[]): string {
  const areaList = areas
    .map((a) => `- ${a.id}${a.shared ? " (shared)" : ""}: ${a.paths.join(", ")}`)
    .join("\n");
  return `PRD:\n\n${prd}\n\nArchitecture:\n\n${architecture}\n\nOwnership areas:\n${areaList}\n\n\
Break the work into tickets. Finish with a JSON block:
\`\`\`json
{"tickets": [{"key": "setup", "title": "...", "description": "...", "acceptance": ["..."], "area": "shared", "files": ["package.json"], "dependsOn": [], "priority": 0}]}
\`\`\``;
}

export interface BuildExtras {
  /** Dependencies the CEO skipped: their work is not in the codebase. */
  skippedDeps?: { id: string; title: string }[];
  /** Set when the tech lead takes over after repeated failures. */
  escalation?: { failures: string[] };
}

export function buildPrompt(ticket: Ticket, ownerNotes: string, prd: string, extras: BuildExtras = {}): string {
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
  return `Ticket ${ticket.id}: ${ticket.title}${escalation}${skipped}

${ticket.description}

Acceptance criteria:
${ticket.acceptance.map((a) => `- ${a}`).join("\n") || "- (none listed)"}

Files you own for this ticket:
${ticket.files.map((f) => `- ${f}`).join("\n")}
${ticket.feedback ? `\nThe reviewer requested changes on your last attempt:\n${ticket.feedback}\n` : ""}
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

export function reviewPrompt(ticket: Ticket, diff: string): string {
  const clipped = diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n... (diff truncated)` : diff;
  return `Review ticket ${ticket.id}: ${ticket.title}

Acceptance criteria:
${ticket.acceptance.map((a) => `- ${a}`).join("\n") || "- (none listed)"}

Diff against main:
\`\`\`diff
${clipped}
\`\`\``;
}
