import { z } from "zod";

/**
 * Agents often write null for a field they have nothing for. Treat null
 * like a missing field, so it gets its default instead of failing the
 * whole answer.
 */
function lenient<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === null ? undefined : v), schema);
}

/** What the tech lead returns when defining the architecture. */
export const ArchitectureSchema = z.object({
  summary: z.string().min(1),
  areas: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/, "area ids are lowercase slugs"),
        name: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        shared: lenient(z.boolean().optional()),
      }),
    )
    .min(1),
});
export type Architecture = z.infer<typeof ArchitectureSchema>;

/** What the task creator returns. `key` is local; the board assigns real ids. */
export const TicketPlanSchema = z.object({
  tickets: z
    .array(
      z.object({
        key: z.string().min(1),
        title: z.string().min(1),
        description: lenient(z.string().default("")),
        acceptance: lenient(z.array(z.string()).default([])),
        area: lenient(z.string().optional()),
        files: z.array(z.string()).min(1),
        dependsOn: lenient(z.array(z.string()).default([])),
        priority: lenient(z.number().int().default(1)),
        size: lenient(z.enum(["S", "M", "L"]).default("M")),
      }),
    )
    .min(1),
});
export type TicketPlan = z.infer<typeof TicketPlanSchema>;

/** Optional structured tail of an engineer's final message. */
export const BuildReportSchema = z.object({
  summary: lenient(z.string().default("")),
  notes: lenient(z.string().default("")),
});
export type BuildReport = z.infer<typeof BuildReportSchema>;

/** What QA returns after testing the merged build. */
export const QaReportSchema = z.object({
  verdict: z.enum(["pass", "bugs"]),
  summary: lenient(z.string().default("")),
  bugs: z
    .array(
      z.object({
        title: z.string().min(1),
        description: lenient(z.string().default("")),
        steps: lenient(z.array(z.string()).default([])),
        expected: lenient(z.string().default("")),
        files: lenient(z.array(z.string()).default([])),
        severity: lenient(z.enum(["high", "medium", "low"]).catch("medium")),
      }),
    )
    .nullish()
    .transform((v) => v ?? []),
});
export type QaReport = z.infer<typeof QaReportSchema>;

const HEX = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "colors are hex, like #3346d3");

/** What marketing returns: the name, the logo and how the product talks. */
export const BrandSchema = z.object({
  name: z.string().min(1).max(40),
  alternatives: lenient(z.array(z.object({ name: z.string().min(1), why: z.string().default("") })).default([])),
  tagline: z.string().min(1),
  positioning: lenient(z.string().default("")),
  audience: lenient(z.string().default("")),
  voice: lenient(z.array(z.string()).default([])),
  /** Words and claims the product never uses. */
  avoid: lenient(z.array(z.string()).default([])),
  palette: lenient(z.array(z.object({ name: z.string().min(1), hex: HEX, use: z.string().default("") })).min(1)),
  typography: lenient(
    z
      .object({ heading: lenient(z.string().default("")), body: lenient(z.string().default("")) })
      .default({ heading: "", body: "" }),
  ),
  logoSvg: z.string().min(1),
  logoNotes: lenient(z.string().default("")),
});
export type BrandPlan = z.infer<typeof BrandSchema>;

/** What the designer returns: the design system and the key screens. */
export const DesignSchema = z.object({
  summary: z.string().min(1),
  principles: lenient(z.array(z.string()).default([])),
  /** CSS custom properties engineers import, e.g. ":root { --color-primary: #3346d3; }". */
  tokensCss: lenient(z.string().default("")),
  components: lenient(z.array(z.object({ name: z.string().min(1), description: z.string().default("") })).default([])),
  screens: z
    .array(
      z.object({
        name: z.string().min(1),
        purpose: lenient(z.string().default("")),
        layout: lenient(z.string().default("")),
        states: lenient(z.array(z.string()).default([])),
        wireframeSvg: lenient(z.string().optional()),
      }),
    )
    .min(1),
});
export type DesignPlan = z.infer<typeof DesignSchema>;

/** The PM's feasibility call on a design. Its cuts are binding. */
export const FeasibilitySchema = z.object({
  verdict: z.enum(["feasible", "changes"]),
  notes: lenient(z.string().default("")),
  /** Parts of the design that are out of scope for this version. */
  cuts: lenient(z.array(z.string()).default([])),
});
export type Feasibility = z.infer<typeof FeasibilitySchema>;

/** Marketing's launch copy for the release. */
export const LaunchSchema = z.object({
  headline: z.string().min(1),
  description: lenient(z.string().default("")),
  highlights: lenient(z.array(z.string()).default([])),
  announcement: lenient(z.string().default("")),
});
export type Launch = z.infer<typeof LaunchSchema>;

export const ReviewSchema = z.object({
  verdict: z.enum(["approve", "changes"]),
  feedback: lenient(z.string().default("")),
});
export type Review = z.infer<typeof ReviewSchema>;

/**
 * Pull the last JSON object out of an agent's message: a ```json fence if
 * present, otherwise the last balanced {...} block.
 */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i]?.[1]?.trim();
    if (body?.startsWith("{")) {
      try {
        return JSON.parse(body);
      } catch {
        /* try the next candidate */
      }
    }
  }
  const end = text.lastIndexOf("}");
  if (end === -1) throw new Error("No JSON object in agent output");
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") depth--;
    if (depth === 0) return JSON.parse(text.slice(i, end + 1));
  }
  throw new Error("Unbalanced JSON in agent output");
}

export function parseWith<T>(schema: z.ZodType<T>, text: string): T {
  return schema.parse(extractJson(text));
}
