import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ActivityListener, AgentResult, AgentRunner, AgentTask } from "./runner.js";

export interface MockRunnerOptions {
  /** Delay per activity step in ms, so the UI has something to watch. */
  stepMs?: number;
  /** Ticket titles (substring match) whose first review requests changes. */
  rejectFirstReviewOf?: string[];
  /** Ticket titles (substring match) whose builds always fail, to demo the failure flow. */
  failBuildsOf?: string[];
  /** QA reports one bug in its first round, to demo the bug-fix loop. */
  qaFindsBugOnce?: boolean;
  /** QA reports this bug every round, to test the round limit. */
  qaAlwaysFinds?: string;
  /** Ticket titles (substring match) whose first build blows its spend cap. */
  overspendFirstBuildOf?: string[];
  /** Cost of building one ticket, in USD (default 0.02). */
  buildCostUsd?: number;
  /** The PM sends the first design back (and keeps cutting on later rounds when "always"). */
  pmPushesBackDesign?: "once" | "always";
  /** Marketing's logo is not a usable SVG, to test the fallback. */
  brokenLogo?: boolean;
  /** The designer's review of the running app finds one issue in its first round. */
  designFindsIssueOnce?: boolean;
  /** The designer can't take screenshots (no browser). */
  noScreenshots?: boolean;
}

/**
 * A scripted runner for demos and tests: no API key, no cost, deterministic.
 * It plans a small notes app, writes real files in the worktree so merges
 * are real, and can reject a review once to exercise the retry path.
 */
export class MockRunner implements AgentRunner {
  readonly name = "mock";
  private readonly stepMs: number;
  private readonly rejectOnce: string[];
  private readonly rejected = new Set<string>();
  private readonly alwaysFail: string[];
  private readonly qaFindsBugOnce: boolean;
  private readonly qaAlwaysFinds?: string;

  private readonly overspendOnce: string[];
  private readonly overspent = new Set<string>();
  private readonly buildCost: number;
  private readonly pmPushback?: "once" | "always";
  private readonly brokenLogo: boolean;
  private readonly designFindsIssueOnce: boolean;
  private readonly noScreenshots: boolean;

  constructor(options: MockRunnerOptions = {}) {
    this.designFindsIssueOnce = options.designFindsIssueOnce ?? false;
    this.noScreenshots = options.noScreenshots ?? false;
    this.pmPushback = options.pmPushesBackDesign;
    this.brokenLogo = options.brokenLogo ?? false;
    this.overspendOnce = options.overspendFirstBuildOf ?? [];
    this.buildCost = options.buildCostUsd ?? 0.02;
    this.qaFindsBugOnce = options.qaFindsBugOnce ?? false;
    this.qaAlwaysFinds = options.qaAlwaysFinds;
    this.stepMs = options.stepMs ?? 250;
    this.rejectOnce = options.rejectFirstReviewOf ?? [];
    this.alwaysFail = options.failBuildsOf ?? [];
  }

  async run(task: AgentTask, onActivity: ActivityListener, signal?: AbortSignal): Promise<AgentResult> {
    const step = async (line: string) => {
      if (signal?.aborted) throw new Error("aborted");
      onActivity(line);
      if (this.stepMs > 0) await new Promise((r) => setTimeout(r, this.stepMs));
    };

    switch (task.kind) {
      case "prd": {
        await step("Reading the CEO's idea");
        await step("Drafting user stories");
        await step("Writing the PRD");
        return ok(mockPrd(task.context.idea ?? "", task.context.feedback), 0.01);
      }
      case "brand": {
        await step("Studying the audience");
        await step("Shortlisting names");
        await step("Drawing the logo");
        const plan = {
          ...MOCK_BRAND,
          tagline: task.context.feedback ? `${MOCK_BRAND.tagline} (revised)` : MOCK_BRAND.tagline,
          logoSvg: this.brokenLogo ? "a blue circle with a pen" : MOCK_BRAND.logoSvg,
        };
        return ok(`Here's the brand.\n\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, 0.01);
      }
      case "design": {
        const round = task.context.designRound ?? 1;
        await step("Reading the PRD and the brand");
        await step("Setting up tokens and components");
        await step("Wireframing the key screens");
        const design = {
          ...MOCK_DESIGN,
          summary: `${MOCK_DESIGN.summary}${task.context.pmNotes ? " Revised per the PM: offline mode removed." : ""}${
            task.context.feedback ? ` Revised per the CEO: ${task.context.feedback}` : ""
          }${task.context.changeRequest ? ` Updated for: ${task.context.changeRequest}` : ""}`,
          screens: round > 1 || !this.pmPushback ? MOCK_DESIGN.screens : [...MOCK_DESIGN.screens, MOCK_OFFLINE_SCREEN],
        };
        return ok(`\`\`\`json\n${JSON.stringify(design)}\n\`\`\``, 0.01);
      }
      case "feasibility": {
        const round = task.context.designRound ?? 1;
        await step(`Checking the design against the PRD (round ${round})`);
        const pushBack = this.pmPushback === "always" || (this.pmPushback === "once" && round === 1);
        const review = pushBack
          ? task.context.finalRound
            ? { verdict: "feasible", notes: "Final call: ship without offline mode.", cuts: ["Offline mode"] }
            : { verdict: "changes", notes: "Offline sync isn't in the PRD and won't fit in a day.", cuts: ["Offline mode"] }
          : { verdict: "feasible", notes: "Every screen maps to a user story and fits v1.", cuts: [] };
        return ok(`\`\`\`json\n${JSON.stringify(review)}\n\`\`\``, 0.005);
      }
      case "design_review": {
        const round = task.context.qaRound ?? 1;
        await step("Starting the app");
        if (!this.noScreenshots) {
          const dir = join(task.cwd, ".switchyard/screens");
          mkdirSync(dir, { recursive: true });
          for (const [name, title] of [["sign-in-phone", "Sign in"], ["notes-list-phone", "Notes"]] as const) {
            await step(`Screenshot: ${name}`);
            writeFileSync(join(dir, `${name}.svg`), MOCK_SCREENSHOT(title, round));
          }
          await step("Looking at the screenshots against the design");
        }
        const bugs =
          this.designFindsIssueOnce && round === 1
            ? [
                {
                  title: "Navigation links are unstyled",
                  description: "On the notes list, the nav shows browser-default purple underlined links instead of the tab bar.",
                  steps: ["Open the notes list on a phone"],
                  expected: "The tab bar from the design, using --color-primary for the active tab",
                  files: ["web/styles.css"],
                  severity: "high",
                },
              ]
            : [];
        const rough = this.designFindsIssueOnce && round === 1;
        const report = {
          verdict: bugs.length ? "bugs" : "pass",
          scores: [
            { screen: "Sign in", score: 4, why: "" },
            { screen: "Notes list", score: rough ? 2 : 4, why: rough ? "nav is unstyled default links" : "" },
          ],
          summary: this.noScreenshots
            ? "Couldn't start a browser to take screenshots; reviewed the markup and CSS against the design instead."
            : `Round ${round}: screenshotted sign-in and the notes list at phone size.`,
          bugs,
        };
        return ok(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``, 0.01);
      }
      case "launch": {
        await step("Writing the launch copy");
        const launch = {
          headline: "Notes that keep up with you",
          description: "Jotter is the quickest place to write something down and find it again.",
          highlights: ["Sign in with email", "Create, edit and delete notes", "Newest notes first"],
          announcement: "Jotter is live. Sign in, write a note, and it's there next time.",
        };
        return ok(`\`\`\`json\n${JSON.stringify(launch)}\n\`\`\``, 0.005);
      }
      case "architecture": {
        await step("Reviewing the PRD");
        await step("Choosing the stack");
        await step("Defining ownership areas");
        return ok(MOCK_ARCHITECTURE, 0.01);
      }
      case "tickets": {
        await step("Splitting stories into tickets");
        await step("Tagging files and dependencies");
        if (task.context.changeRequest) {
          const title = `Change: ${task.context.changeRequest.split(/[.\n]/)[0]!.slice(0, 60)}`;
          const plan = { tickets: [{ key: "change-1", title, area: "web", files: ["web/notes.html"], acceptance: [task.context.changeRequest], dependsOn: [], priority: 1, size: "S" }] };
          return ok(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, 0.01);
        }
        return ok(MOCK_TICKETS, 0.01);
      }
      case "build": {
        const t = task.context.ticket!;
        const batch = task.context.batch ?? [t];
        await step(`Reading owner notes for ${t.area}`);
        if (batch.some((b) => this.alwaysFail.some((s) => b.title.includes(s)))) {
          await step("Running checks");
          return { ok: false, text: "", costUsd: 0.01, error: "Build broke: 3 tests failing in the layout grid" };
        }
        // A wasteful first attempt: blows through whatever cap it was given.
        const waste = batch.find((b) => this.overspendOnce.some((s) => b.title.includes(s)) && !this.overspent.has(b.id));
        if (waste) {
          this.overspent.add(waste.id);
          await step("Reading the whole codebase, twice");
          const cap = task.budgetUsd ?? 1;
          return { ok: false, text: "", costUsd: cap, error: "cut off at its spend cap", overBudget: true };
        }
        for (const b of batch) {
          for (const f of b.files) {
            const file = f.endsWith("/") ? join(f, "index.ts") : f;
            await step(`Write: ${file}`);
            const abs = join(task.cwd, file);
            mkdirSync(dirname(abs), { recursive: true });
            const prior = existsSync(abs) ? readFileSync(abs, "utf8") : "";
            writeFileSync(abs, `${prior}${stub(file, b.id, b.title, b.attempts)}`);
          }
        }
        await step("Running checks");
        const cost = Math.min(this.buildCost * batch.length, task.budgetUsd ?? Infinity);
        return ok(
          `Implemented ${batch.map((b) => b.title).join(", ")}.\n\n\`\`\`json\n${JSON.stringify({
            summary: `Built ${batch.map((b) => b.title).join(", ")}`,
            notes: batch.map((b) => `${b.id}: ${b.title} lives in ${b.files.join(", ")}.`).join(" "),
          })}\n\`\`\``,
          cost,
        );
      }
      case "qa": {
        const round = task.context.qaRound ?? 1;
        await step("Reading the PRD and acceptance criteria");
        await step("Installing and starting the app");
        await step("Testing sign-in and the notes flows");
        const bugs = [];
        if (this.qaAlwaysFinds) {
          bugs.push({ title: this.qaAlwaysFinds, description: "Still broken.", files: ["web/notes.html"], severity: "high" });
        } else if (this.qaFindsBugOnce && round === 1) {
          bugs.push({
            title: "Empty notes list shows a blank page",
            description: "With no notes, the list page renders nothing at all.",
            steps: ["Sign in as a new user", "Open the notes page"],
            expected: "A friendly empty state with a button to create the first note",
            files: ["web/notes.html"],
            severity: "medium",
          });
        }
        const report = {
          verdict: bugs.length ? "bugs" : "pass",
          summary: `Round ${round}: ran the app and walked through sign-in, create, edit and delete.`,
          bugs,
        };
        return ok(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``, 0.01);
      }
      case "review": {
        const t = task.context.ticket!;
        const batch = task.context.batch ?? [t];
        await step(`Reviewing ${batch.map((b) => b.id).join(", ")} diff`);
        const target = batch.find((b) => this.rejectOnce.some((s) => b.title.includes(s)) && !this.rejected.has(b.id));
        if (target) {
          this.rejected.add(target.id);
          return ok(
            '```json\n{"verdict": "changes", "feedback": "Handle the empty state and validate input."}\n```',
            0.005,
          );
        }
        return ok('```json\n{"verdict": "approve", "feedback": ""}\n```', 0.005);
      }
    }
  }
}

function ok(text: string, costUsd: number): AgentResult {
  return { ok: true, text, costUsd };
}

function stub(file: string, id: string, title: string, attempt: number): string {
  const tag = `${id} ${title}${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`;
  if (file.endsWith(".html")) return `<!-- ${tag} -->\n<section data-ticket="${id}"></section>\n`;
  if (file.endsWith(".css")) return `/* ${tag} */\n.${id.toLowerCase()} { display: block; }\n`;
  if (file.endsWith(".sql")) return `-- ${tag}\nCREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT);\n`;
  if (file.endsWith(".json")) return `{\n  "name": "notes-app",\n  "private": true\n}\n`;
  return `// ${tag}\nexport const ${id.replace(/-/g, "_").toLowerCase()} = true;\n`;
}

function mockPrd(idea: string, feedback?: string): string {
  return `# PRD: ${idea.slice(0, 80) || "Notes app"}

**Summary:** A minimal notes app: sign in, write notes, see them in a list.
${feedback ? `\n**Revised per CEO feedback:** ${feedback}\n` : ""}
## Users
Individuals who want a fast place to jot down notes.

## User stories
1. As a user I can sign in with email and password.
   - Acceptance: wrong password shows an error; success lands on the notes list.
2. As a user I can create, edit and delete notes.
   - Acceptance: changes persist after reload.
3. As a user I see my notes newest first.

## Out of scope for v1
Sharing, tags, rich text, mobile apps.

## Open questions
- Do we need password reset in v1?`;
}

const MOCK_BRAND = {
  name: "Jotter",
  alternatives: [
    { name: "Notably", why: "friendly, but close to existing apps" },
    { name: "Scribbly", why: "playful, harder to take seriously at work" },
  ],
  tagline: "Write it down. Find it fast.",
  positioning: "For people who think faster than their notes app. Jotter opens straight to a blank note, with nothing to set up.",
  audience: "Busy individuals who jot down ideas, lists and reminders through the day.",
  voice: ["Short and plain: 'Note saved', not 'Your note has been successfully persisted'", "Warm, never cute"],
  avoid: ["synergy", "revolutionary"],
  palette: [
    { name: "Ink", hex: "#1f3a5f", use: "primary buttons and links" },
    { name: "Paper", hex: "#f7f4ed", use: "page background" },
    { name: "Marker", hex: "#f2b134", use: "highlights, sparingly" },
  ],
  typography: { heading: "Georgia, serif", body: "system-ui, sans-serif" },
  logoSvg:
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#1f3a5f'/><rect x='16' y='14' width='32' height='38' rx='4' fill='#f7f4ed'/><rect x='22' y='24' width='20' height='3' rx='1.5' fill='#1f3a5f'/><rect x='22' y='32' width='14' height='3' rx='1.5' fill='#1f3a5f'/><circle cx='46' cy='46' r='8' fill='#f2b134'/></svg>",
  logoNotes: "A page with two lines, and a marker dot for the idea you just had.",
};

const wire = (title: string, rows: string) =>
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 360 640'><rect width='360' height='640' fill='#f7f4ed'/><rect x='0' y='0' width='360' height='56' fill='#1f3a5f'/><text x='20' y='35' font-family='sans-serif' font-size='18' fill='#fff'>${title}</text>${rows}</svg>`;

/** A stand-in "screenshot": a phone-sized SVG, styled once the design issue is fixed. */
const MOCK_SCREENSHOT = (title: string, round: number) =>
  wire(
    title,
    round === 1
      ? "<text x='20' y='100' font-family='serif' font-size='16' fill='#551a8b' text-decoration='underline'>Today  Notes  Settings</text><rect x='20' y='130' width='320' height='72' rx='8' fill='#fff' stroke='#ddd'/>"
      : "<rect x='0' y='584' width='360' height='56' fill='#fff' stroke='#ddd'/><rect x='20' y='76' width='320' height='72' rx='8' fill='#fff' stroke='#ddd'/><rect x='20' y='160' width='320' height='72' rx='8' fill='#fff' stroke='#ddd'/><circle cx='60' cy='612' r='6' fill='#1f3a5f'/>",
  );

const MOCK_DESIGN = {
  summary: "Calm paper tones, one strong ink color, generous spacing. Every screen works one-handed on a phone.",
  principles: ["One primary action per screen", "Show the empty state as an invitation"],
  tokensCss:
    ":root {\n  --color-primary: #1f3a5f;\n  --color-bg: #f7f4ed;\n  --color-accent: #f2b134;\n  --color-text: #1c2533;\n  --space-1: 4px;\n  --space-2: 8px;\n  --space-3: 16px;\n  --radius: 8px;\n  --font-body: system-ui, sans-serif;\n  --font-heading: Georgia, serif;\n}",
  components: [
    { name: "Button", description: "Primary (ink) and secondary (outline); hover, focus ring, disabled" },
    { name: "Note card", description: "Title, first line, time; tap to edit" },
    { name: "Text field", description: "Label above, error text below in red" },
  ],
  screens: [
    {
      name: "Sign in",
      purpose: "Get people to their notes.",
      layout: "Logo, email and password fields, one Sign in button.",
      states: ["error: wrong password", "loading: button shows a spinner"],
      wireframeSvg: wire(
        "Sign in",
        "<rect x='40' y='160' width='280' height='44' rx='8' fill='#fff' stroke='#bbb'/><rect x='40' y='224' width='280' height='44' rx='8' fill='#fff' stroke='#bbb'/><rect x='40' y='300' width='280' height='48' rx='8' fill='#1f3a5f'/>",
      ),
    },
    {
      name: "Notes list",
      purpose: "See and open notes, newest first.",
      layout: "Header with a New note button, then note cards.",
      states: ["empty: 'No notes yet' with a New note button", "loading: three grey card placeholders", "error: retry banner"],
      wireframeSvg: wire(
        "Notes",
        "<rect x='20' y='76' width='320' height='72' rx='8' fill='#fff' stroke='#ddd'/><rect x='20' y='160' width='320' height='72' rx='8' fill='#fff' stroke='#ddd'/><rect x='20' y='244' width='320' height='72' rx='8' fill='#fff' stroke='#ddd'/><circle cx='310' cy='590' r='26' fill='#f2b134'/>",
      ),
    },
  ],
};

const MOCK_OFFLINE_SCREEN = {
  name: "Offline mode",
  purpose: "Keep writing without a connection and sync later.",
  layout: "Banner showing sync status; queued notes marked.",
  states: ["offline", "syncing", "conflict"],
};

const MOCK_ARCHITECTURE = `Plain HTML front end, a small TypeScript API and SQLite.

\`\`\`json
${JSON.stringify(
  {
    summary:
      "- **web/**: static HTML + CSS pages calling the API\n- **api/**: TypeScript HTTP handlers\n- **shared**: package.json and the DB schema, changed one ticket at a time",
    areas: [
      { id: "web", name: "Web UI", paths: ["web/"] },
      { id: "api", name: "API", paths: ["api/"] },
      { id: "shared", name: "Shared", paths: ["package.json", "db/"], shared: true },
    ],
  },
  null,
  2,
)}
\`\`\``;

const MOCK_TICKETS = `\`\`\`json
${JSON.stringify(
  {
    tickets: [
      { key: "setup", title: "Project manifest and DB schema", area: "shared", files: ["package.json", "db/schema.sql"], acceptance: ["notes and users tables exist"], dependsOn: [], priority: 0, size: "S" },
      { key: "shell", title: "App shell and styles", area: "web", files: ["web/index.html", "web/styles.css"], acceptance: ["Shared header and layout"], dependsOn: [], priority: 1, size: "M" },
      { key: "api-auth", title: "Auth API", area: "api", files: ["api/auth.ts"], acceptance: ["POST /login returns a session"], dependsOn: ["setup"], priority: 1, size: "M" },
      { key: "api-notes", title: "Notes CRUD API", area: "api", files: ["api/notes.ts"], acceptance: ["CRUD endpoints persist to SQLite"], dependsOn: ["setup"], priority: 1, size: "L" },
      { key: "web-login", title: "Login page", area: "web", files: ["web/login.html"], acceptance: ["Shows an error on bad password"], dependsOn: ["api-auth", "shell"], priority: 1, size: "S" },
      { key: "web-notes", title: "Notes list page", area: "web", files: ["web/notes.html"], acceptance: ["Newest first", "Create, edit, delete"], dependsOn: ["api-notes", "shell"], priority: 1, size: "M" },
    ],
  },
  null,
  2,
)}
\`\`\``;
