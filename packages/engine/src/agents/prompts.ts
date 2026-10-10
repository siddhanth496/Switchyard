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

export function buildPrompt(ticket: Ticket, ownerNotes: string, prd: string): string {
  return `Ticket ${ticket.id}: ${ticket.title}

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
