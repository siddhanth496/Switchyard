import { z } from "zod";

/** What the tech lead returns when defining the architecture. */
export const ArchitectureSchema = z.object({
  summary: z.string().min(1),
  areas: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/, "area ids are lowercase slugs"),
        name: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        shared: z.boolean().optional(),
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
        description: z.string().default(""),
        acceptance: z.array(z.string()).default([]),
        area: z.string().optional(),
        files: z.array(z.string()).min(1),
        dependsOn: z.array(z.string()).default([]),
        priority: z.number().int().default(1),
      }),
    )
    .min(1),
});
export type TicketPlan = z.infer<typeof TicketPlanSchema>;

/** Optional structured tail of an engineer's final message. */
export const BuildReportSchema = z.object({
  summary: z.string().default(""),
  notes: z.string().default(""),
});
export type BuildReport = z.infer<typeof BuildReportSchema>;

export const ReviewSchema = z.object({
  verdict: z.enum(["approve", "changes"]),
  feedback: z.string().default(""),
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
