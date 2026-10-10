import type { Area } from "./types.js";

/**
 * Paths are repo-relative and use "/". A path ending in "/" is a directory
 * prefix and covers everything under it. "src/auth/**" is accepted and
 * treated as "src/auth/".
 */
/**
 * Files only their owning team changes: marketing's brand, the designer's
 * design and release screenshots, the PM's PRD and the tech lead's areas.
 * Engineers read them; a ticket that changes them is sent back.
 */
export const PROTECTED_PATHS = ["docs/brand/", "docs/design/", "docs/screens/", "docs/PRD.md", "docs/areas.json"];

export function isProtected(path: string): boolean {
  const p = normalizePath(path);
  return PROTECTED_PATHS.some((x) => (x.endsWith("/") ? p.startsWith(x) || `${p}/` === x : p === x));
}

export function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (s.endsWith("/**")) s = s.slice(0, -2);
  if (s.endsWith("/*")) s = s.slice(0, -1);
  if (s === "" || s === "**" || s === "*") return "";
  return s;
}

function isDir(p: string): boolean {
  return p === "" || p.endsWith("/");
}

/** True if a path or prefix `a` covers path or prefix `b`. */
export function covers(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na === nb) return true;
  return isDir(na) && nb.startsWith(na);
}

/** True if two paths or prefixes could touch the same file. */
export function pathsOverlap(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a);
}

/** True if any path in `as` overlaps any path in `bs`. */
export function anyOverlap(as: readonly string[], bs: readonly string[]): boolean {
  return as.some((a) => bs.some((b) => pathsOverlap(a, b)));
}

/** The overlapping pairs, for clear log messages. */
export function overlaps(as: readonly string[], bs: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const a of as) for (const b of bs) if (pathsOverlap(a, b)) out.push([a, b]);
  return out;
}

/**
 * The area that owns a file: the one with the longest matching prefix, so a
 * nested area (src/billing/invoices/) wins over its parent (src/billing/).
 */
export function owningArea(file: string, areas: readonly Area[]): Area | undefined {
  let best: Area | undefined;
  let bestLen = -1;
  for (const area of areas) {
    for (const prefix of area.paths) {
      if (covers(prefix, file) || covers(file, prefix)) {
        const len = normalizePath(prefix).length;
        if (len > bestLen) {
          best = area;
          bestLen = len;
        }
      }
    }
  }
  return best;
}

export type AreaResolution =
  | { kind: "single"; area: string }
  | { kind: "split"; areas: string[] }
  | { kind: "unowned"; files: string[] };

/**
 * Which area a set of files belongs to. Files in a shared area don't force a
 * split on their own; they ride with the ticket's main area, since the
 * dispatcher's leases already serialize work on them.
 */
export function resolveArea(files: readonly string[], areas: readonly Area[]): AreaResolution {
  const unowned: string[] = [];
  const owners = new Set<string>();
  const shared = new Set<string>();
  for (const f of files) {
    const a = owningArea(f, areas);
    if (!a) unowned.push(f);
    else if (a.shared) shared.add(a.id);
    else owners.add(a.id);
  }
  if (unowned.length > 0) return { kind: "unowned", files: unowned };
  if (owners.size === 1) return { kind: "single", area: [...owners][0]! };
  if (owners.size === 0 && shared.size === 1) return { kind: "single", area: [...shared][0]! };
  return { kind: "split", areas: [...owners, ...shared] };
}
