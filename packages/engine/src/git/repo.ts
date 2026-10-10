import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Serializes async work. Merges and commits on main go through one of these. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface MergeResult {
  ok: boolean;
  error?: string;
}

/**
 * The product's git repo. `main` stays checked out in `dir`; every running
 * ticket gets its own worktree and branch beside it, so engineers never
 * share a working directory.
 */
export class ProjectRepo {
  private readonly mainLock = new Mutex();

  constructor(readonly dir: string) {}

  get worktreeRoot(): string {
    return `${this.dir}.worktrees`;
  }

  worktreePath(ticketId: string): string {
    return join(this.worktreeRoot, ticketId);
  }

  branch(ticketId: string): string {
    return `ticket/${ticketId}`;
  }

  private git(args: string[], cwd = this.dir) {
    return exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  }

  /** Create the repo with an initial commit of the given files. */
  async init(files: Record<string, string>): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    await this.git(["init", "-q", "-b", "main"]);
    await this.git(["config", "user.name", "Agent Company"]);
    await this.git(["config", "user.email", "agents@agent-company.local"]);
    for (const [path, content] of Object.entries(files)) {
      const abs = join(this.dir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    await this.git(["add", "-A"]);
    await this.git(["commit", "-q", "-m", "Initial commit"]);
  }

  /** Read a file from main. Returns "" if it doesn't exist. */
  readMain(path: string): string {
    const abs = join(this.dir, path);
    return existsSync(abs) ? readFileSync(abs, "utf8") : "";
  }

  /** Write files on main and commit them, serialized with merges. */
  commitToMain(files: Record<string, string | Buffer>, message: string): Promise<void> {
    return this.mainLock.run(async () => {
      for (const [path, content] of Object.entries(files)) {
        const abs = join(this.dir, path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
      await this.git(["add", "-A"]);
      if (await this.hasStaged(this.dir)) await this.git(["commit", "-q", "-m", message]);
    });
  }

  /**
   * A worktree for a ticket. First attempt branches from main; a retry
   * reuses the branch and merges main into it, so it picks up work that
   * landed meanwhile.
   */
  async openWorktree(ticketId: string): Promise<string> {
    const path = this.worktreePath(ticketId);
    const branch = this.branch(ticketId);
    mkdirSync(this.worktreeRoot, { recursive: true });
    if (existsSync(path)) await this.git(["worktree", "remove", "--force", path]).catch(() => undefined);
    await this.git(["worktree", "prune"]);
    const exists = await this.git(["rev-parse", "--verify", "--quiet", branch]).then(
      () => true,
      () => false,
    );
    if (exists) {
      await this.git(["worktree", "add", "-q", path, branch]);
      await this.git(["merge", "-q", "--no-edit", "main"], path).catch(async (err) => {
        await this.git(["merge", "--abort"], path).catch(() => undefined);
        throw new Error(`Could not refresh ${branch} from main: ${(err as Error).message}`);
      });
    } else {
      await this.git(["worktree", "add", "-q", "-b", branch, path, "main"]);
    }
    return path;
  }

  /** Commit everything in a worktree. Returns false if nothing changed. */
  async commitWorktree(ticketId: string, message: string): Promise<boolean> {
    const path = this.worktreePath(ticketId);
    await this.git(["add", "-A"], path);
    if (!(await this.hasStaged(path))) return false;
    await this.git(["commit", "-q", "-m", message], path);
    return true;
  }

  /** Files the ticket's branch changed relative to main. */
  async changedFiles(ticketId: string): Promise<string[]> {
    const { stdout } = await this.git(["diff", "--name-only", `main...${this.branch(ticketId)}`]);
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  async diff(ticketId: string): Promise<string> {
    const { stdout } = await this.git(["diff", `main...${this.branch(ticketId)}`]);
    return stdout;
  }

  /** Merge a ticket's branch into main. Aborts cleanly on conflict. */
  merge(ticketId: string, message: string): Promise<MergeResult> {
    return this.mainLock.run(async () => {
      try {
        await this.git(["merge", "-q", "--no-ff", "-m", message, this.branch(ticketId)]);
        return { ok: true };
      } catch (err) {
        await this.git(["merge", "--abort"]).catch(() => undefined);
        return { ok: false, error: (err as Error).message.split("\n").slice(0, 3).join(" ") };
      }
    });
  }

  async closeWorktree(ticketId: string, deleteBranch: boolean): Promise<void> {
    const path = this.worktreePath(ticketId);
    await this.git(["worktree", "remove", "--force", path]).catch(() => undefined);
    if (deleteBranch) await this.git(["branch", "-D", this.branch(ticketId)]).catch(() => undefined);
  }

  /** True if `dir` holds a git repo (not a worktree folder). */
  static isRepo(dir: string): boolean {
    return existsSync(join(dir, ".git")) && !dir.endsWith(".worktrees");
  }

  /** Tracked files on main, for giving agents a map of an existing product. */
  async listFiles(limit = 300): Promise<string[]> {
    const { stdout } = await this.git(["ls-files"]);
    return stdout.split("\n").filter(Boolean).slice(0, limit);
  }

  /** Earlier committed versions of a file on main, newest first. */
  async versions(path: string, limit = 20): Promise<string[]> {
    const { stdout } = await this.git(["log", "--format=%H", `-${limit}`, "--", path]);
    const out: string[] = [];
    for (const hash of stdout.split("\n").filter(Boolean)) {
      try {
        out.push((await this.git(["show", `${hash}:${path}`])).stdout);
      } catch {
        /* deleted in that commit */
      }
    }
    return out;
  }

  async log(n = 20): Promise<string[]> {
    const { stdout } = await this.git(["log", "--oneline", `-${n}`]);
    return stdout.split("\n").filter(Boolean);
  }

  private async hasStaged(cwd: string): Promise<boolean> {
    try {
      await this.git(["diff", "--cached", "--quiet"], cwd);
      return false;
    } catch {
      return true;
    }
  }
}
