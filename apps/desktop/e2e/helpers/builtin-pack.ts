import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lineVariantText, parseVoicePack, renderVoice, type VoiceKind, type VoiceTemplates } from "@deskpet/core";

/**
 * Reads the builtin packs' phrases at test time so assertions compare against what the pack file
 * actually says. The user may edit builtin packs in developer mode, so tests must never hardcode
 * these strings as expected values (M8 criterion 3).
 */
const charactersRoot = resolve(import.meta.dirname, "..", "..", "..", "..", "characters");

async function readPackFile(id: string, file: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(join(charactersRoot, id, file), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`characters/${id}/${file} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** The pack's manifest name, as the settings window header and 어투 tab show it. */
export async function builtinPackName(id: string): Promise<string> {
  const manifest = await readPackFile(id, "manifest.json");
  if (typeof manifest.name !== "string" || manifest.name === "")
    throw new Error(`characters/${id}/manifest.json has no name`);
  return manifest.name;
}

export interface BuiltinInteraction { id: string; label: string; lines: string[] }

/** The pack's interactions.json items in file order (the app shows them as written, no voice). */
export async function builtinInteractions(id: string): Promise<BuiltinInteraction[]> {
  const file = await readPackFile(id, "interactions.json");
  if (!Array.isArray(file.items)) throw new Error(`characters/${id}/interactions.json has no items`);
  return file.items.map((raw): BuiltinInteraction => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error(`characters/${id}/interactions.json has a non-object item`);
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.label !== "string" || !Array.isArray(item.lines) ||
      !item.lines.every((line): line is string => typeof line === "string"))
      throw new Error(`characters/${id}/interactions.json item ${String(item.id)} is malformed`);
    return { id: item.id, label: item.label, lines: item.lines };
  });
}

export async function builtinInteraction(id: string, interactionId: string): Promise<BuiltinInteraction> {
  const found = (await builtinInteractions(id)).find((item) => item.id === interactionId);
  if (!found) throw new Error(`characters/${id}/interactions.json has no item ${interactionId}`);
  return found;
}

/** The pack's voice templates, parsed the way the app parses voice.json. */
export async function builtinVoice(id: string): Promise<VoiceTemplates> {
  return parseVoicePack(await readPackFile(id, "voice.json")).templates;
}

export function builtinVariants(templates: VoiceTemplates, kind: VoiceKind): string[] {
  const variants = templates[kind];
  if (variants === undefined || variants.length === 0)
    throw new Error(`the pack has no usable ${kind} voice variants`);
  return variants.map(lineVariantText);
}

/** What the app shows for a voice event: renderVoice over the pack's templates. */
export function renderedVoice(templates: VoiceTemplates, kind: VoiceKind, slots: Record<string, string>, variantSeed = 0): string {
  const text = renderVoice(templates, { kind, slots }, variantSeed);
  if (text === null) throw new Error(`the pack's ${kind} variants render nothing for slots ${JSON.stringify(slots)}`);
  return text;
}
