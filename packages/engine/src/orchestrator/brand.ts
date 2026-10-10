import type { Brand } from "../core/types.js";
import type { BrandPlan, DesignPlan, Feasibility, Launch } from "../agents/schemas.js";

/** Largest SVG we keep from an agent, in characters. */
const MAX_SVG = 40_000;

/**
 * An agent's SVG, made safe to store and show: scripts, event handlers,
 * foreign objects and external references are removed. Returns undefined
 * if it isn't an SVG at all. The UI also renders these as <img>, where
 * scripts never run; this is the second layer.
 */
export function safeSvg(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let svg = raw.trim().replace(/^<\?xml[^>]*>\s*/i, "");
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg) || svg.length > MAX_SVG) return undefined;
  svg = svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[^>]*\/>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, "")
    .replace(/javascript:/gi, "");
  if (!/\sxmlns=/.test(svg.slice(0, svg.indexOf(">")))) {
    svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return svg;
}

/** A plain monogram, used when marketing's logo can't be used. */
export function monogramLogo(name: string, color = "#3346d3"): string {
  const letter = (name.trim()[0] ?? "A").toUpperCase().replace(/[<>&"']/g, "A");
  const fill = /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#3346d3";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${fill}"/><text x="32" y="43" font-family="system-ui, sans-serif" font-size="32" font-weight="700" text-anchor="middle" fill="#ffffff">${letter}</text></svg>`;
}

/** The palette as a strip of labelled swatches, for the brand card. */
export function paletteSvg(palette: { name: string; hex: string }[]): string {
  const w = 120;
  const esc = (s: string) => s.replace(/[<>&"']/g, "");
  const cells = palette
    .slice(0, 6)
    .map(
      (c, i) =>
        `<g transform="translate(${i * w} 0)"><rect width="${w - 8}" height="64" rx="8" fill="${c.hex}" stroke="#d5dae2"/>` +
        `<text x="0" y="84" font-family="system-ui, sans-serif" font-size="13" fill="#1c2533">${esc(c.name).slice(0, 16)}</text>` +
        `<text x="0" y="102" font-family="ui-monospace, monospace" font-size="12" fill="#5d6779">${esc(c.hex)}</text></g>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.max(1, Math.min(palette.length, 6)) * w} 108">${cells}</svg>`;
}

export function toBrand(plan: BrandPlan): Brand {
  return { name: plan.name, tagline: plan.tagline, logoSvg: plan.logoSvg, palette: plan.palette.map(({ name, hex }) => ({ name, hex })) };
}

export function renderBrand(b: BrandPlan): string {
  const alts = b.alternatives.length
    ? `\n**Other names considered:** ${b.alternatives.map((a) => `${a.name}${a.why ? ` (${a.why})` : ""}`).join("; ")}\n`
    : "";
  const palette = b.palette.map((c) => `| ${c.name} | \`${c.hex}\` | ${c.use} |`).join("\n");
  const type = [b.typography.heading && `Headings: ${b.typography.heading}`, b.typography.body && `Body: ${b.typography.body}`]
    .filter(Boolean)
    .join(". ");
  return `# ${b.name}

> ${b.tagline}
${alts}
## Positioning

${b.positioning || "_Not set._"}
${b.audience ? `\n**Audience:** ${b.audience}\n` : ""}
## Voice

${b.voice.map((v) => `- ${v}`).join("\n") || "- Plain, friendly and brief."}
${b.avoid.length ? `\n**Never say:** ${b.avoid.join("; ")}\n` : ""}
## Colors

| Color | Hex | Use |
| --- | --- | --- |
${palette}
${type ? `\n## Type\n\n${type}\n` : ""}
## Logo

The logo is in \`docs/brand/logo.svg\`.${b.logoNotes ? ` ${b.logoNotes}` : ""}
`;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "screen";
}

/** The design as markdown, with the PM's feasibility call. Wireframes are separate files. */
export function renderDesign(d: DesignPlan, review?: Feasibility & { rounds: number }): string {
  const screens = d.screens
    .map((s) => {
      const wire = s.wireframeSvg ? `\n\nWireframe: \`docs/design/wireframes/${slugify(s.name)}.svg\`` : "";
      const states = s.states.length ? `\n\n**States:** ${s.states.join(", ")}` : "";
      return `### ${s.name}\n\n${s.purpose}${s.layout ? `\n\n${s.layout}` : ""}${states}${wire}`;
    })
    .join("\n\n");
  const pm = review
    ? `\n## PM's call on feasibility\n\n${review.notes || "Feasible as designed."}\n${
        review.cuts.length
          ? `\n**Out of scope for this version (binding):**\n\n${review.cuts.map((c) => `- ${c}`).join("\n")}\n`
          : ""
      }\n_Signed off after ${review.rounds} review round${review.rounds === 1 ? "" : "s"}._\n`
    : "";
  return `# Design

${d.summary}
${d.principles.length ? `\n## Principles\n\n${d.principles.map((p) => `- ${p}`).join("\n")}\n` : ""}
## Tokens

Defined in \`docs/design/tokens.css\`.

## Components

${d.components.map((c) => `- **${c.name}**: ${c.description}`).join("\n") || "- None beyond plain HTML elements."}

## Screens

${screens}
${pm}`;
}

export function renderLaunch(name: string, l: Launch): string {
  return `# Launch: ${name}

## ${l.headline}

${l.description}
${l.highlights.length ? `\n${l.highlights.map((h) => `- ${h}`).join("\n")}\n` : ""}
## Announcement

${l.announcement}
`;
}
