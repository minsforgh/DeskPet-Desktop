import type { PetEvent } from "./contracts.js";
import { fitLineParts, lineVariantText, type LineParts, type LineVariant, type RenderedLineParts } from "./lines.js";

export type VoiceKind = NonNullable<PetEvent["voice"]>["kind"];
export type VoiceSlotName = "task" | "result" | "folder" | "message";
/** Variants per kind; a kind without usable variants is absent. */
export type VoiceTemplates = Partial<Record<VoiceKind, LineVariant[]>>;
export type VoiceLines = Record<string, LineVariant[]>;

export const VOICE_MAX_VARIANTS = 8;
export const VOICE_MAX_VARIANT_CODE_POINTS = 400;
const TEXT_MAX_CODE_POINTS = 120;
const kinds: readonly VoiceKind[] = ["done", "waiting", "failed", "info", "deadline", "reminder", "alert"];
const slotNames: readonly string[] = ["task", "result", "folder", "message"];
const placeholder = /\{([^{}]*)\}/gu;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Names of the `{name}` placeholders in a variant, in order. */
function referencedNames(variant: string): string[] {
  return [...variant.matchAll(placeholder)].map((match) => match[1] ?? "");
}
const hasControl = (value: string): boolean => Array.from(value).some((character) => {
  const code = character.codePointAt(0) ?? 0;
  return (code < 32 && code !== 10) || (code >= 127 && code <= 159);
});

function structuredProblem(value: Record<string, unknown>, path: string, allowed?: readonly string[]): string | undefined {
  if (Object.keys(value).some((key) => !["prefix", "content", "suffix"].includes(key)) ||
    typeof value.prefix !== "string" || typeof value.content !== "string" || typeof value.suffix !== "string" ||
    !value.content.trim()) return `${path} must have only string prefix, content and suffix with non-empty content`;
  const fields = [value.prefix, value.content, value.suffix];
  if (fields.reduce((length, field) => length + Array.from(field).length, 0) > VOICE_MAX_VARIANT_CODE_POINTS)
    return `${path} is longer than ${VOICE_MAX_VARIANT_CODE_POINTS} code points`;
  if (fields.some(hasControl)) return `${path} has control characters`;
  for (const [field, text] of [["prefix", value.prefix], ["content", value.content], ["suffix", value.suffix]] as const) {
    const names = referencedNames(text);
    if (/[{}]/u.test(text.replace(placeholder, ""))) return `${path}.${field} has invalid braces`;
    if (field !== "content" && names.length > 0) return `${path}.${field} cannot use variables`;
    const unknown = names.find((name) => !/^[a-z][a-z0-9]*$/u.test(name) || (allowed && !allowed.includes(name)));
    if (unknown !== undefined) return `${path}.${field} uses unknown slot {${unknown}}`;
  }
  return undefined;
}

/**
 * Reads a voice.json value. Bad variants are dropped and described in `problems`;
 * a file that is broken as a whole yields empty templates. Never throws.
 */
export function parseVoicePack(json: unknown): { templates: VoiceTemplates; lines: VoiceLines; problems: string[] } {
  const templates: VoiceTemplates = {};
  const lines: VoiceLines = {};
  const problems: string[] = [];
  if (!isObject(json)) return { templates, lines, problems: ["voice file must be an object"] };
  if (json.version !== 1) return { templates, lines, problems: ["voice file version must be 1"] };
  if (!isObject(json.templates)) return { templates, lines, problems: ["templates must be an object"] };
  for (const name of Object.keys(json.templates)) {
    if (!kinds.some((kind) => kind === name)) problems.push(`templates.${name} is not a known kind`);
  }
  for (const kind of kinds) {
    if (!Object.hasOwn(json.templates, kind)) continue;
    const variants = json.templates[kind];
    if (!Array.isArray(variants)) { problems.push(`templates.${kind} must be an array`); continue; }
    if (variants.length > VOICE_MAX_VARIANTS) problems.push(`templates.${kind} keeps only the first ${VOICE_MAX_VARIANTS} variants`);
    const kept: LineVariant[] = [];
    variants.slice(0, VOICE_MAX_VARIANTS).forEach((variant: unknown, index: number) => {
      const path = `templates.${kind}[${index}]`;
      if (isObject(variant)) {
        const problem = structuredProblem(variant, path, slotNames);
        if (problem) problems.push(problem);
        else kept.push(variant as unknown as LineParts);
        return;
      }
      if (typeof variant !== "string" || variant.trim() === "") problems.push(`${path} must be a non-empty string`);
      else if (Array.from(variant).length > VOICE_MAX_VARIANT_CODE_POINTS)
        problems.push(`${path} is longer than ${VOICE_MAX_VARIANT_CODE_POINTS} code points`);
      else {
        const unknown = referencedNames(variant).find((slot) => !slotNames.includes(slot));
        if (unknown !== undefined) problems.push(`${path} uses unknown slot {${unknown}}`);
        else kept.push(variant);
      }
    });
    if (kept.length > 0) templates[kind] = kept;
    else if (variants.length === 0) problems.push(`templates.${kind} has no variants`);
  }
  if (Object.hasOwn(json, "lines")) {
    if (!isObject(json.lines)) problems.push("lines must be an object");
    else for (const [id, variants] of Object.entries(json.lines)) {
      const path = `lines.${id}`;
      if (!Array.isArray(variants)) { problems.push(`${path} must be an array`); continue; }
      if (variants.length > VOICE_MAX_VARIANTS) problems.push(`${path} keeps only the first ${VOICE_MAX_VARIANTS} variants`);
      const kept: LineVariant[] = [];
      variants.slice(0, VOICE_MAX_VARIANTS).forEach((variant: unknown, index: number) => {
        const location = `${path}[${index}]`;
        if (isObject(variant)) {
          const problem = structuredProblem(variant, location);
          if (problem) problems.push(problem);
          else kept.push(variant as unknown as LineParts);
          return;
        }
        if (typeof variant !== "string" || !variant.trim()) problems.push(`${location} must be a non-empty string`);
        else if (Array.from(variant).length > VOICE_MAX_VARIANT_CODE_POINTS)
          problems.push(`${location} is longer than ${VOICE_MAX_VARIANT_CODE_POINTS} code points`);
        else if (/[{}]/u.test(variant.replace(/\{[a-z][a-z0-9]*\}/gu, "")))
          problems.push(`${location} has invalid braces`);
        else if (Array.from(variant).some((character) => {
          const code = character.codePointAt(0) ?? 0;
          return (code < 32 && code !== 10) || (code >= 127 && code <= 159);
        })) problems.push(`${location} has control characters`);
        else kept.push(variant);
      });
      if (kept.length > 0) Object.defineProperty(lines, id, { value: kept, enumerable: true, writable: true, configurable: true });
      else if (variants.length === 0) problems.push(`${path} has no variants`);
    }
  }
  return { templates, lines, problems };
}

/** Cut to at most `max` code points: max - 1 code points plus "…" (same as the hook message rule). */
function fit(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join("")}…`;
}

/**
 * Picks a variant of the event's kind by `variantSeed` (cycling) and fills its slots.
 * A variant whose slots are empty or missing is skipped for the next one; null when none is usable.
 * Slot values are inserted in one pass, so braces inside them are never substituted again.
 */
export function renderVoiceParts(templates: VoiceTemplates, voice: PetEvent["voice"], variantSeed: number): RenderedLineParts | null {
  const variants = voice === undefined ? undefined : templates[voice.kind];
  if (voice === undefined || variants === undefined || variants.length === 0) return null;
  const count = variants.length;
  const start = (((Math.trunc(variantSeed) || 0) % count) + count) % count;
  for (let offset = 0; offset < count; offset += 1) {
    const variant = variants[(start + offset) % count];
    if (variant === undefined) continue;
    let usable = true;
    const fill = (source: string): string => source.replace(placeholder, (_match, name: string) => {
      const value = (voice.slots as Record<string, string | undefined> | undefined)?.[name]?.trim() ?? "";
      if (value === "") usable = false;
      return value;
    });
    if (typeof variant === "string") {
      const fullText = fill(variant).replace(/\s+/gu, " ").trim();
      if (usable && fullText) return { text: fit(fullText, TEXT_MAX_CODE_POINTS), fullText };
    } else {
      const normalize = (value: string): string => value.replace(/\s+/gu, " ").trim();
      const parts = { prefix: normalize(variant.prefix), content: normalize(fill(variant.content)), suffix: normalize(variant.suffix) };
      if (!usable || !parts.content) continue;
      const fullText = lineVariantText(parts);
      const fitted = fitLineParts(parts, TEXT_MAX_CODE_POINTS);
      if (fitted) return { text: lineVariantText(fitted), fullText, parts: fitted };
    }
  }
  return null;
}
export function renderVoice(templates: VoiceTemplates, voice: PetEvent["voice"], variantSeed: number): string | null {
  return renderVoiceParts(templates, voice, variantSeed)?.text ?? null;
}
