import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";

/**
 * The tools a non-Claude agent works with: read, list, search, and (for
 * engineers) write, edit and run commands. File tools are confined to the
 * task's working directory. Commands are not sandboxed, exactly like the
 * Claude agents' shell: run the server in a container or VM.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  write: boolean;
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

export const TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a text file. Returns numbered lines. Use offset and limit for long files.",
    parameters: {
      type: "object",
      properties: { path: str("File path, relative to the working directory"), offset: int("First line to read, from 1"), limit: int("How many lines (default 800)") },
      required: ["path"],
    },
    write: false,
  },
  {
    name: "list_files",
    description: 'List files matching a glob, e.g. "src/**/*.ts" or "**/*". Skips node_modules, .git and build output.',
    parameters: { type: "object", properties: { pattern: str("Glob pattern, relative to the working directory") }, required: ["pattern"] },
    write: false,
  },
  {
    name: "search",
    description: "Search file contents with a regular expression. Returns matching lines as path:line: text.",
    parameters: {
      type: "object",
      properties: { pattern: str("JavaScript regular expression"), glob: str('Only search files matching this glob, e.g. "**/*.ts"') },
      required: ["pattern"],
    },
    write: false,
  },
  {
    name: "write_file",
    description: "Create a file or replace its whole content. Parent folders are created.",
    parameters: { type: "object", properties: { path: str("File path"), content: str("The full new content") }, required: ["path", "content"] },
    write: true,
  },
  {
    name: "edit_file",
    description: "Replace one exact piece of text in a file. old_text must appear exactly once; include surrounding lines to make it unique.",
    parameters: {
      type: "object",
      properties: { path: str("File path"), old_text: str("Exact text to replace"), new_text: str("Replacement text") },
      required: ["path", "old_text", "new_text"],
    },
    write: true,
  },
  {
    name: "run_command",
    description: "Run a shell command in the working directory (install packages, run tests, git). Returns the exit code and output.",
    parameters: {
      type: "object",
      properties: { command: str("The bash command"), timeout_seconds: int("Give up after this long (default 120, max 600)") },
      required: ["command"],
    },
    write: true,
  },
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo", ".venv", "__pycache__"]);
const MAX_OUTPUT = 20_000;
const MAX_FILE_BYTES = 400_000;

/** Environment variables a command run by an agent never sees. */
const SECRET_VARS = /^(ANTHROPIC_|GEMINI_|GOOGLE_API_KEY$|GOOGLE_GENAI_|CLAUDE_CODE_OAUTH)/;

export function commandEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !SECRET_VARS.test(k)) env[k] = v;
  return env;
}

/** A path inside the working directory, or an error: no escaping through ".." or symlinks. */
export function confine(cwd: string, path: string): string {
  if (typeof path !== "string" || !path.trim()) throw new Error("path is required");
  const root = realpathSync(cwd);
  const full = resolve(root, path);
  // Resolve symlinks on the nearest part of the path that exists.
  let probe = full;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const real = join(realpathSync(probe), relative(probe, full));
  if (real !== root && !real.startsWith(root + sep)) throw new Error(`${path} is outside the working directory`);
  return real;
}

function walk(root: string, limit: number): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(full);
      } else if (e.isFile()) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  visit(root);
  return out;
}

function clip(s: string, max = MAX_OUTPUT): string {
  return s.length > max ? `${s.slice(0, max)}\n... (${s.length - max} more characters cut off)` : s;
}

type Args = Record<string, unknown>;

/** Run one tool call. Never throws: a failure comes back as text the model can act on. */
export async function runTool(cwd: string, name: string, args: Args, canWrite: boolean, signal?: AbortSignal): Promise<string> {
  const spec = TOOLS.find((t) => t.name === name);
  if (!spec) return `Error: there is no tool called ${name}`;
  if (spec.write && !canWrite) return `Error: ${name} is not available for this task; it is read-only`;
  try {
    switch (name) {
      case "read_file": {
        const full = confine(cwd, String(args.path ?? ""));
        if (!existsSync(full)) return `Error: ${args.path} does not exist`;
        if (statSync(full).isDirectory()) return `Error: ${args.path} is a folder; use list_files`;
        if (statSync(full).size > MAX_FILE_BYTES * 5) return `Error: ${args.path} is too large to read`;
        const buf = readFileSync(full);
        if (buf.subarray(0, 4000).includes(0)) return `Error: ${args.path} is a binary file`;
        const lines = buf.toString("utf8").split("\n");
        const from = Math.max(1, Number(args.offset) || 1);
        const count = Math.min(2000, Math.max(1, Number(args.limit) || 800));
        const shown = lines.slice(from - 1, from - 1 + count).map((l, i) => `${from + i}\t${l}`);
        const more = from - 1 + count < lines.length ? `\n... (${lines.length} lines in total; read on with offset ${from + count})` : "";
        return clip(shown.join("\n"), 60_000) + more;
      }
      case "list_files": {
        const pattern = String(args.pattern ?? "**/*");
        if (isAbsolute(pattern) || pattern.split("/").includes("..")) return "Error: the pattern must stay inside the working directory";
        const match = picomatch(pattern, { dot: true });
        const files = walk(realpathSync(cwd), 20_000).filter((f) => match(f));
        if (files.length === 0) return "No files match.";
        return files.slice(0, 400).join("\n") + (files.length > 400 ? `\n... (${files.length - 400} more)` : "");
      }
      case "search": {
        let re: RegExp;
        try {
          re = new RegExp(String(args.pattern ?? ""));
        } catch (err) {
          return `Error: bad regular expression: ${(err as Error).message}`;
        }
        const match = args.glob ? picomatch(String(args.glob), { dot: true }) : () => true;
        const root = realpathSync(cwd);
        const hits: string[] = [];
        for (const f of walk(root, 20_000)) {
          if (!match(f)) continue;
          const full = join(root, f);
          if (statSync(full).size > MAX_FILE_BYTES) continue;
          const buf = readFileSync(full);
          if (buf.subarray(0, 4000).includes(0)) continue;
          const lines = buf.toString("utf8").split("\n");
          for (let i = 0; i < lines.length && hits.length < 120; i++) {
            if (re.test(lines[i]!)) hits.push(`${f}:${i + 1}: ${lines[i]!.trim().slice(0, 220)}`);
          }
          if (hits.length >= 120) break;
        }
        return hits.length ? hits.join("\n") + (hits.length >= 120 ? "\n... (more matches; narrow the search)" : "") : "No matches.";
      }
      case "write_file": {
        const full = confine(cwd, String(args.path ?? ""));
        if (typeof args.content !== "string") return "Error: content is required";
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, args.content);
        return `Wrote ${args.path} (${args.content.split("\n").length} lines)`;
      }
      case "edit_file": {
        const full = confine(cwd, String(args.path ?? ""));
        if (!existsSync(full)) return `Error: ${args.path} does not exist; use write_file to create it`;
        const oldText = String(args.old_text ?? "");
        if (!oldText) return "Error: old_text is required";
        const before = readFileSync(full, "utf8");
        const count = before.split(oldText).length - 1;
        if (count === 0) return "Error: old_text was not found. Read the file again and copy the text exactly, including spaces.";
        if (count > 1) return `Error: old_text appears ${count} times. Include more surrounding lines so it matches once.`;
        writeFileSync(full, before.replace(oldText, () => String(args.new_text ?? "")));
        return `Edited ${args.path}`;
      }
      case "run_command":
        return await runCommand(cwd, String(args.command ?? ""), Number(args.timeout_seconds) || 120, signal);
    }
    return `Error: ${name} is not implemented`;
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

function runCommand(cwd: string, command: string, timeoutSeconds: number, signal?: AbortSignal): Promise<string> {
  if (!command.trim()) return Promise.resolve("Error: command is required");
  const seconds = Math.min(600, Math.max(1, timeoutSeconds));
  return new Promise((done) => {
    // Its own process group, so a timeout or Stop also ends what it started.
    const child = spawn("bash", ["-c", command], { cwd, env: commandEnv() as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let ended: string | null = null;
    const kill = (why: string) => {
      ended = why;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => kill(`timed out after ${seconds}s`), seconds * 1000);
    const onAbort = () => kill("stopped");
    signal?.addEventListener("abort", onAbort, { once: true });
    const take = (d: Buffer) => {
      if (out.length < MAX_OUTPUT * 4) out += d.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      clearTimeout(timer);
      done(`Error: ${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // Keep the end of long output: that's where test failures are.
      const text = out.length > MAX_OUTPUT ? `... (start cut off)\n${out.slice(-MAX_OUTPUT)}` : out;
      done(`${ended ? `Command ${ended}.` : `Exit code ${code ?? "?"}.`}\n${text.trim() || "(no output)"}`);
    });
  });
}
