import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ActivityListener, AgentResult, AgentRunner, AgentTask } from "./runner.js";

export interface MockRunnerOptions {
  /** Delay per activity step in ms, so the UI has something to watch. */
  stepMs?: number;
  /** Ticket titles (substring match) whose first review requests changes. */
  rejectFirstReviewOf?: string[];
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

  constructor(options: MockRunnerOptions = {}) {
    this.stepMs = options.stepMs ?? 250;
    this.rejectOnce = options.rejectFirstReviewOf ?? [];
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
      case "architecture": {
        await step("Reviewing the PRD");
        await step("Choosing the stack");
        await step("Defining ownership areas");
        return ok(MOCK_ARCHITECTURE, 0.01);
      }
      case "tickets": {
        await step("Splitting stories into tickets");
        await step("Tagging files and dependencies");
        return ok(MOCK_TICKETS, 0.01);
      }
      case "build": {
        const t = task.context.ticket!;
        await step(`Reading owner notes for ${t.area}`);
        for (const f of t.files) {
          const file = f.endsWith("/") ? join(f, "index.ts") : f;
          await step(`Write: ${file}`);
          const abs = join(task.cwd, file);
          mkdirSync(dirname(abs), { recursive: true });
          const prior = existsSync(abs) ? readFileSync(abs, "utf8") : "";
          writeFileSync(abs, `${prior}${stub(file, t.id, t.title, t.attempts)}`);
        }
        await step("Running checks");
        return ok(
          `Implemented ${t.title}.\n\n\`\`\`json\n${JSON.stringify({
            summary: `Built ${t.title}`,
            notes: `${t.id}: ${t.title} lives in ${t.files.join(", ")}.`,
          })}\n\`\`\``,
          0.02,
        );
      }
      case "review": {
        const t = task.context.ticket!;
        await step(`Reviewing ${t.id} diff`);
        const shouldReject =
          this.rejectOnce.some((s) => t.title.includes(s)) && !this.rejected.has(t.id);
        if (shouldReject) {
          this.rejected.add(t.id);
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
      { key: "setup", title: "Project manifest and DB schema", area: "shared", files: ["package.json", "db/schema.sql"], acceptance: ["notes and users tables exist"], dependsOn: [], priority: 0 },
      { key: "shell", title: "App shell and styles", area: "web", files: ["web/index.html", "web/styles.css"], acceptance: ["Shared header and layout"], dependsOn: [], priority: 1 },
      { key: "api-auth", title: "Auth API", area: "api", files: ["api/auth.ts"], acceptance: ["POST /login returns a session"], dependsOn: ["setup"], priority: 1 },
      { key: "api-notes", title: "Notes CRUD API", area: "api", files: ["api/notes.ts"], acceptance: ["CRUD endpoints persist to SQLite"], dependsOn: ["setup"], priority: 1 },
      { key: "web-login", title: "Login page", area: "web", files: ["web/login.html"], acceptance: ["Shows an error on bad password"], dependsOn: ["api-auth", "shell"], priority: 1 },
      { key: "web-notes", title: "Notes list page", area: "web", files: ["web/notes.html"], acceptance: ["Newest first", "Create, edit, delete"], dependsOn: ["api-notes", "shell"], priority: 1 },
    ],
  },
  null,
  2,
)}
\`\`\``;
