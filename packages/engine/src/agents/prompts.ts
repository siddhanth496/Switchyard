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

  pm_feasibility: `${COMPANY}

Role: Product Manager, reviewing the design for feasibility. You have the final call on what the design \
asks engineers to build. You never redesign the look; you judge scope.
Check the design against the PRD and the build effort:
- Every screen and state serves a user story in the PRD. Anything else is scope creep.
- Nothing needs work the PRD rules out for this version, or that a small team can't build in a day \
(custom illustration, complex animation, offline sync, native apps, heavy charting).
- Required states are covered: empty, loading, error, and the main success path.
- Brand presence (logo, name, brand colors and type) and visual polish (layout, spacing, hierarchy, a desktop \
layout) are part of the product, never scope creep. Don't cut them; cut only genuinely expensive work such as custom \
illustration, complex animation or features the PRD doesn't have.
Approve ("feasible") when it fits, even if you'd have designed it differently. Otherwise say exactly what \
to change. List anything you rule out of this version under "cuts": cuts are binding, engineers will skip them.
Finish with a JSON block:
\`\`\`json
{"verdict": "feasible" | "changes", "notes": "what must change, or why it is feasible", "cuts": ["..."]}
\`\`\``,

  design_reviewer: `${COMPANY}

Role: Product Designer, reviewing the running product before release. You look at the real screens, not the code. \
You never fix code.
How to review:
- Read docs/design/DESIGN.md, docs/design/tokens.css and docs/brand/BRAND.md, then the README to see how to start the app.
- Install and start the app. Stop any server you start before you finish.
- Screenshot every screen in the design, and any other page you can reach, at phone size and desktop size:
  npx -y playwright@1 screenshot --viewport-size=390,844 --wait-for-timeout=800 <url> .switchyard/screens/<screen>-phone.png
  npx -y playwright@1 screenshot --viewport-size=1280,800 --wait-for-timeout=800 <url> .switchyard/screens/<screen>-desktop.png
  If the browser is missing, run "npx -y playwright@1 install chromium" once. Save screenshots ONLY in .switchyard/screens/.
- Open each screenshot with the Read tool and look at it carefully, as a customer would.
- Open the wireframes in docs/design/wireframes/ and compare each screen to its wireframe and the design.
Then judge it as a customer and as the brand's designer. Score every screen you checked from 1 to 5: 5 is \
polished and unmistakably this brand, 4 is good enough to ship, 3 works but looks generic or unfinished, 2 or \
less is broken or careless. For every screen below 4, file at least one issue that says exactly what to change \
to reach 4 or more (with the tokens and components to use).
These are always bugs, high severity:
- The brand missing or wrong: a product name other than the brand's (in the title, header, logo or text), a \
logo other than docs/brand/logo.svg, no logo or name in the app shell, brand colors not used.
- Pages or parts of pages left unstyled: browser-default fonts, blue or purple underlined links, bare bullet lists \
used as navigation, default form controls next to styled ones.
- Navigation that is duplicated, missing or inconsistent between screens.
- Broken layout: overlapping or cut-off content, horizontal scrolling on a phone, misaligned label/value pairs.
- Placeholder or debug text, missing empty/loading/error states the design asks for.
- On desktop: content or forms stretched edge to edge, cards or sections touching with no gap.
Medium: colors, type or spacing that ignore the tokens; weak hierarchy (everything the same size, no clear primary \
action); copy that ignores the brand's voice. Skip tiny pixel differences. If you could not start the app or take screenshots, say exactly why in the summary and review \
the markup and CSS against the design instead.
Finish with a JSON block:
\`\`\`json
{"verdict": "pass" | "bugs", "summary": "which screens you checked and how", "scores": [{"screen": "Today", "score": 3, "why": "generic: no logo in the header, stats look like form labels"}], "bugs": [{"title": "...", "description": "what is wrong, on which screen", "steps": ["open /today on a phone"], "expected": "what the design calls for", "files": ["web/src/pages/Today.tsx"], "severity": "high" | "medium" | "low"}]}
\`\`\``,

  marketing: `${COMPANY}

Role: Head of Marketing. You decide how the product is branded: its name, tagline, positioning, voice, \
colors and logo. You never write product code.
- The name is short, easy to say and spell, fits the audience, and is not a well-known existing brand or \
trademark. Propose the one you recommend plus 2 or 3 alternatives.
- The logo is a simple, original SVG mark that works at 32px: a viewBox, at most a few shapes, flat brand \
colors, no text other than an optional wordmark, no scripts, no external images or fonts, no event handlers. \
Never imitate an existing company's logo.
- The palette has 3 to 5 colors with a clear primary; text on it must stay readable (WCAG AA contrast).
- The voice is 3 or 4 short rules for how the product talks to people, with an example each.`,

  designer: `${COMPANY}

Role: Product Designer. You turn the PRD and the approved brand into a design engineers can build: a design \
system and the key screens. You never write product code.
Design like a good product studio, not a template. Someone who sees one screen should recognise the brand; a \
generic admin panel in the brand's color is a failure.
- Brand presence: the app shell shows marketing's logo (docs/brand/logo.svg) and the product name. Say where the \
brand's colors and type carry weight (primary actions, the header, the numbers people track) and name one or two \
signature elements that make the product recognisable (a distinctive header, how progress or streaks are shown, \
a card style). Use the brand's fonts where they are free to use.
- Design system: color, type, spacing, radius and elevation tokens as CSS custom properties, built from the brand \
palette, with readable contrast. Name tokens by role (--color-primary, --space-2), not by value.
- Components: the ones the screens need (app header, navigation, button, input, card, list item, stat...), each \
with its states.
- Layout: phone first, plus a real desktop layout: a centred content column (state its max width) or columns, \
never forms stretched edge to edge. State the gap between stacked sections so nothing touches. One clear primary \
action per screen; the numbers people track are large and easy to scan.
- Screens: one per main user story, laid out precisely enough to build (order, sizes, which tokens), with the \
empty, loading and error states. Add a wireframe SVG for up to 5 key screens (viewBox 0 0 360 640 for phone or \
0 0 1280 800 for desktop) showing the real hierarchy: header with logo, content blocks, primary action. No scripts \
or external references.
- Buildable with CSS and the components you define: no illustration packs or animation libraries. The PM reviews \
it for feasibility and has the final call on scope.`,

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
- For user interface work, follow docs/design/DESIGN.md if it exists (layout, components, empty/loading/error \
states) and use its tokens (docs/design/tokens.css). Use the product name and voice from docs/brand/BRAND.md \
for user-facing text. Don't edit docs/brand or docs/design.
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
Not style nits. If docs/design/DESIGN.md exists, a screen missing its empty, loading or error state, or UI \
that clearly ignores the design, is a bug (usually low or medium severity). For each bug give steps, what you expected, and the files most likely at fault.
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
- For user interface work, request changes if it clearly ignores docs/design/DESIGN.md (missing states, \
ignoring the tokens) when that file exists. Small visual differences are fine.
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

export function architecturePrompt(prd: string, feedback?: string, existingFiles?: string[], design?: string): string {
  const existing = existingFiles?.length
    ? `This product already exists. Define ownership areas that fit its current code; do not propose a rewrite.\n\
Tracked files:\n${existingFiles.map((f) => `- ${f}`).join("\n")}\n\n`
    : "";
  const ui = design ? `Approved design (screens and components to build):\n\n${design}\n\n` : "";
  return `PRD:\n\n${prd}\n\n${ui}${existing}${feedback ? `The CEO rejected your previous proposal. Feedback:\n${feedback}\n\n` : ""}\
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
  design?: string,
  /** The design was just created for an existing product: its screens need restyling too. */
  designIsNew?: boolean,
  /** The approved brand; `apply` when the app doesn't carry it yet. */
  brand?: { name: string; doc: string; apply: boolean },
): string {
  const branding = brand
    ? `Approved brand (final; docs/brand/ is read-only):\n\n${brand.doc}\n\nBrand rules for tickets: the product is called \
"${brand.name}". Never file tickets that create, rename or redo the brand or edit docs/brand, docs/design or docs/PRD.md; \
that work is done, and such tickets are dropped. ${
        brand.apply
          ? `File one early S ticket in the UI area that applies the brand everywhere: the name "${brand.name}" in the page \
title, app header and logo alt text, marketing's logo (copy docs/brand/logo.svg into the app's assets) in the app header \
and as the favicon, and the brand's fonts. Other UI tickets depend on it. `
          : ""
      }\n\n`
    : "";
  const restyle = change && designIsNew
    ? "This design is new for the product: besides the change, file tickets that restyle EVERY existing screen to match it \
(tokens, components, navigation), one ticket per screen or small group of screens, all depending on the tokens ticket. "
    : "";
  const ui = design
    ? `Approved design (docs/design/DESIGN.md):\n\n${design}\n\n\
Design rules for tickets: build the screens and states above, and nothing the PM cut. \
${!change || designIsNew ? "File one early S ticket in the UI area that brings docs/design/tokens.css into the app's styles; UI tickets depend on it. " : ""}${restyle}\
Put the design's acceptance (states, components) into each UI ticket's acceptance criteria.\n\n`
    : "";
  const areaList = areas
    .map((a) => `- ${a.id}${a.shared ? " (shared)" : ""}: ${a.paths.join(", ")}`)
    .join("\n");
  const scope = change
    ? `The product already exists and works. File tickets ONLY for this change request from the CEO; do not \
rebuild or rewrite existing features. Point each ticket at the existing files it changes where possible.\n\n\
Change request:\n${change.request}\n\nTracked files:\n${change.existingFiles.map((f) => `- ${f}`).join("\n")}\n\n`
    : "";
  return `PRD:\n\n${prd}\n\nArchitecture:\n\n${architecture}\n\nOwnership areas:\n${areaList}\n\n${branding}${ui}${scope}\
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

export function brandPrompt(idea: string, prd: string, feedback?: string, previous?: string, currentName?: string): string {
  const existing = currentName
    ? `\nThis product already exists and is currently called "${currentName}". Keep that name if it works as a brand; \
propose a new one if it is a placeholder (a description of the idea, a folder name) or doesn't fit. Either way, give it \
the full brand: tagline, voice, colors and logo.\n`
    : "";
  const redo = feedback
    ? `\nThe CEO sent back your last proposal.\n\nCEO feedback:\n${feedback}\n${previous ? `\nYour last proposal:\n${previous}\n` : ""}`
    : "";
  return `The CEO's ${currentName ? "change request" : "idea"}:\n${idea}\n\nPRD:\n${prd}\n${existing}${redo}
Brand the product. Finish with a JSON block:
\`\`\`json
{"name": "...", "alternatives": [{"name": "...", "why": "..."}], "tagline": "...", "positioning": "who it is for and why it beats the alternative, in 2 sentences", "audience": "...", "voice": ["Plain words: say 'Add a habit', not 'Create new entity'"], "avoid": ["..."], "palette": [{"name": "Primary", "hex": "#3346d3", "use": "buttons, links"}], "typography": {"heading": "a free font or system stack", "body": "..."}, "logoSvg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>...</svg>", "logoNotes": "what the mark means"}
\`\`\``;
}

export function designPrompt(
  prd: string,
  brand: string,
  opts: {
    feedback?: string;
    pmNotes?: string;
    previous?: string;
    current?: string;
    change?: string;
    /** Set for an existing product that has no design yet. */
    existingFiles?: string[];
  } = {},
): string {
  const base = opts.current
    ? `This product already has a design (docs/design/DESIGN.md):\n\n${opts.current}\n\nUpdate it for this change from the CEO, \
keeping everything else as it is:\n${opts.change ?? ""}\n\nReturn the full updated design.\n`
    : opts.existingFiles
      ? `This product already exists but has never had a design: its screens were built without one. Read its UI code to \
see which screens exist, then design the system for ALL of them plus this change from the CEO:\n${opts.change ?? ""}\n\
Engineers will restyle the existing screens to match, so cover every screen, including navigation.\nTracked files:\n\
${opts.existingFiles.map((f) => `- ${f}`).join("\n")}\n`
      : "";
  const ceo = opts.feedback ? `\nThe CEO sent back your last design.\n\nCEO feedback:\n${opts.feedback}\n` : "";
  const pm = opts.pmNotes
    ? `\nThe PM reviewed your design for feasibility and asked for changes. The PM has the final call on scope:\n${opts.pmNotes}\n`
    : "";
  const previous = opts.previous && (opts.feedback || opts.pmNotes) ? `\nYour last design:\n${opts.previous}\n` : "";
  return `PRD:\n${prd}\n\nBrand:\n${brand || "(no brand on file: pick a calm, neutral palette)"}\n\n${base}${ceo}${pm}${previous}
Finish with a JSON block:
\`\`\`json
{"summary": "the look and feel in 2 or 3 sentences", "principles": ["..."], "tokensCss": ":root { --color-primary: #3346d3; --color-text: #1c2533; --space-1: 4px; --radius: 8px; --font-body: system-ui, sans-serif; }", "components": [{"name": "Button", "description": "primary and secondary; hover, focus, disabled"}], "screens": [{"name": "Sign in", "purpose": "...", "layout": "...", "states": ["empty", "loading", "error"], "wireframeSvg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 360 640'>...</svg>"}]}
\`\`\``;
}

export function feasibilityPrompt(prd: string, design: string, round: number, final: boolean, brand?: string): string {
  const last = final
    ? `\nThis is round ${round} and the final one: make the call now. Return "feasible", and put anything that still \
doesn't fit this version under "cuts".\n`
    : round > 1
      ? `\nThis is round ${round}: the designer revised the design after your last notes.\n`
      : "";
  const approvedBrand = brand
    ? `\nApproved brand (final: the CEO approved this name, logo, colors and voice; judge the design's use of it, not the brand itself):\n${brand}\n`
    : "";
  return `PRD:\n${prd}\n${approvedBrand}\nDesign to review:\n${design}\n${last}\nIs this design feasible for this version?`;
}

export function launchPrompt(prd: string, brand: string, shipped: Ticket[], change?: string): string {
  const what = shipped.map((t) => `- ${t.title}`).join("\n");
  return `Brand:\n${brand}\n\nPRD:\n${prd}\n\nWhat was built:\n${what}\n\n${change ? `This release is an update: ${change}\n\n` : ""}\
Write the launch copy in the brand's voice${change ? " for this update" : ""}. Only claim what was built. Finish with a JSON block:
\`\`\`json
{"headline": "...", "description": "one paragraph for a store listing or landing page", "highlights": ["..."], "announcement": "a short post announcing it, in markdown"}
\`\`\``;
}

export function designReviewPrompt(
  prd: string,
  areas: Area[],
  round: number,
  earlier: { title: string; fixed: boolean }[],
): string {
  const areaList = areas.map((a) => `- ${a.id}: ${a.paths.join(", ")}`).join("\n");
  const previous = earlier.length
    ? `\nThis is design review round ${round}. Issues from earlier rounds (check the fixed ones; don't re-report a fixed one unless it is still visible):
${earlier.map((b) => `- ${b.title}${b.fixed ? " (marked fixed)" : " (still open)"}`).join("\n")}
`
    : "";
  return `Review the running product on main against the design before it ships.

PRD:
${prd}

Code areas (use these paths when you name the files at fault):
${areaList}
${previous}`;
}

/** A second chance for an agent whose JSON didn't match the expected shape. */
export function repairPrompt(previous: string, problems: string[]): string {
  const clipped = previous.length > 60_000 ? `${previous.slice(0, 60_000)}\n... (truncated)` : previous;
  return `Your last answer couldn't be read by the system. Problems in its JSON block:
${problems.map((p) => `- ${p}`).join("\n")}

Leave out a field you have nothing for (don't write null for it), and keep every value the type the example showed.

Your last answer:
${clipped}

Reply with the complete, corrected JSON block in a \`\`\`json fence. Change nothing else.`;
}
