import type { LinePetEvent } from "./contracts.js";

export type LineKind = NonNullable<LinePetEvent["voice"]>["kind"];
export interface LineParts { prefix: string; content: string; suffix: string }
export type LineVariant = string | LineParts;
export interface RenderedLineParts { text: string; fullText: string; parts?: LineParts }
export function lineVariantText(variant: LineVariant): string {
  return typeof variant === "string" ? variant : [variant.prefix, variant.content, variant.suffix].filter(Boolean).join(" ");
}
export function fitLineParts(parts: LineParts, max = 120): LineParts | undefined {
  const full = lineVariantText(parts);
  if (Array.from(full).length <= max) return parts;
  const room = max - Array.from(parts.prefix).length - Array.from(parts.suffix).length -
    (parts.prefix ? 1 : 0) - (parts.suffix ? 1 : 0) - 1;
  if (room < 1) return undefined;
  return { ...parts, content: `${Array.from(parts.content).slice(0, room).join("")}…` };
}
export interface Line {
  id: string;
  label: string;
  kind: LineKind;
  variables: string[];
  variants: LineVariant[];
}
export interface LineCatalog { version: 1; lines: Line[] }

const kinds: readonly string[] = ["done", "waiting", "failed", "info", "deadline", "reminder", "alert"];
const localIdPattern = /^[a-z][a-z0-9-]*$/u;
const variablePattern = /^[a-z][a-z0-9]*$/u;
const placeholder = /\{([a-z][a-z0-9]*)\}/gu;
const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;
  return (code < 32 && code !== 10) || (code >= 127 && code <= 159);
};
const hasControl = (value: string): boolean => Array.from(value).some(isControl);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Returns all catalog issues so discovery can report a broken plugin once. */
export function parseLines(input: unknown, manifestId: string): { catalog: LineCatalog; problems: string[] } {
  const catalog: LineCatalog = { version: 1, lines: [] };
  const problems: string[] = [];
  if (!isObject(input)) return { catalog, problems: ["lines file must be an object"] };
  if (input.version !== 1) problems.push("lines file version must be 1");
  if (!Array.isArray(input.lines)) return { catalog, problems: [...problems, "lines must be an array"] };
  const seen = new Set<string>();
  input.lines.forEach((value: unknown, index: number) => {
    const where = `lines[${index}]`;
    if (!isObject(value)) { problems.push(`${where} must be an object`); return; }
    const start = problems.length;
    if (typeof value.id !== "string" || !value.id.startsWith(`${manifestId}.`) ||
        !localIdPattern.test(value.id.slice(manifestId.length + 1))) problems.push(`${where}.id has invalid format`);
    else if (seen.has(value.id)) problems.push(`${where}.id is duplicated`);
    else seen.add(value.id);
    if (typeof value.label !== "string" || !value.label.trim() || hasControl(value.label) || value.label.includes("\n"))
      problems.push(`${where}.label must be non-empty display text`);
    if (typeof value.kind !== "string" || !kinds.includes(value.kind)) problems.push(`${where}.kind is unknown`);
    const variables = value.variables;
    if (!Array.isArray(variables) || !variables.every((name: unknown) =>
      typeof name === "string" && variablePattern.test(name)) ||
        new Set(variables).size !== variables.length) problems.push(`${where}.variables has invalid names`);
    if (!Array.isArray(value.variants) || value.variants.length < 1 || value.variants.length > 8)
      problems.push(`${where}.variants must have 1 to 8 entries`);
    else value.variants.forEach((variant: unknown, variantIndex: number) => {
      const location = `${where}.variants[${variantIndex}]`;
      if (isObject(variant)) {
        if (Object.keys(variant).some((key) => !["prefix", "content", "suffix"].includes(key)) ||
          typeof variant.prefix !== "string" || typeof variant.content !== "string" || typeof variant.suffix !== "string" ||
          !variant.content.trim()) { problems.push(`${location} must have only string prefix, content and suffix with non-empty content`); return; }
        const fields = [variant.prefix, variant.content, variant.suffix];
        if (fields.reduce((length, field) => length + Array.from(field).length, 0) > 400 || fields.some(hasControl)) {
          problems.push(`${location} must be at most 400 code points without control characters`); return;
        }
        for (const [field, part] of [["prefix", variant.prefix], ["content", variant.content], ["suffix", variant.suffix]] as const) {
          const names = [...part.matchAll(placeholder)].map((match) => match[1] ?? "");
          if (/[{}]/u.test(part.replace(placeholder, ""))) problems.push(`${location}.${field} has invalid braces`);
          if (field !== "content" && names.length > 0) problems.push(`${location}.${field} cannot use variables`);
          if (Array.isArray(variables) && names.some((name) => !variables.includes(name)))
            problems.push(`${location}.${field} uses an undeclared variable`);
        }
        return;
      }
      if (typeof variant !== "string" || !variant.trim() || Array.from(variant).length > 400 || hasControl(variant)) {
        problems.push(`${location} must be 1 to 400 code points without control characters`); return;
      }
      const names = [...variant.matchAll(placeholder)].map((match) => match[1] ?? "");
      const remainder = variant.replace(placeholder, "");
      if (/[{}]/u.test(remainder)) problems.push(`${location} has invalid braces`);
      if (Array.isArray(variables) && names.some((name) => !variables.includes(name)))
        problems.push(`${location} uses an undeclared variable`);
    });
    if (problems.length === start) catalog.lines.push(value as unknown as Line);
  });
  return { catalog, problems };
}

function normalize(text: string): string {
  return Array.from(text).filter((character) => !isControl(character)).join("")
    .replace(/[^\S\n]+/gu, " ").replace(/ *\n */gu, "\n").replace(/\n{2,}/gu, "\n").trim();
}

/** Counts variants independently for each id; seed overrides selection for previews and tests. */
export class LineRenderer {
  private readonly counts = new Map<string, number>();

  render(catalog: LineCatalog, id: string, vars: Readonly<Record<string, string>> = {}, seed?: number): string | undefined {
    return this.renderParts(catalog, id, vars, seed)?.text;
  }

  renderParts(catalog: LineCatalog, id: string, vars: Readonly<Record<string, string>> = {}, seed?: number): RenderedLineParts | undefined {
    const line = catalog.lines.find((item) => item.id === id);
    if (!line) return undefined;
    const count = line.variants.length;
    const next = seed === undefined ? (this.counts.get(id) ?? 0) : Math.trunc(seed);
    if (seed === undefined) this.counts.set(id, next + 1);
    const start = ((next % count) + count) % count;
    for (let offset = 0; offset < count; offset += 1) {
      const variant = line.variants[(start + offset) % count] ?? "";
      let missing = false;
      const fill = (source: string): string => source.replace(placeholder, (_match, name: string) => {
        const value = vars[name]?.trim();
        if (!value) { missing = true; return ""; }
        return value;
      });
      if (typeof variant === "string") {
        const result = normalize(fill(variant));
        if (!missing && result) return { text: Array.from(result).slice(0, 120).join(""), fullText: result };
      } else {
        const parts = { prefix: normalize(variant.prefix), content: normalize(fill(variant.content)), suffix: normalize(variant.suffix) };
        if (missing || !parts.content) continue;
        const fullText = lineVariantText(parts);
        const fitted = fitLineParts(parts);
        if (fitted) return { text: lineVariantText(fitted), fullText, parts: fitted };
      }
    }
    return undefined;
  }
}

export function renderLine(catalog: LineCatalog, id: string, vars: Readonly<Record<string, string>> = {}, seed = 0): string | undefined {
  return new LineRenderer().render(catalog, id, vars, seed);
}
export function renderLineParts(catalog: LineCatalog, id: string, vars: Readonly<Record<string, string>> = {}, seed = 0): RenderedLineParts | undefined {
  return new LineRenderer().renderParts(catalog, id, vars, seed);
}
