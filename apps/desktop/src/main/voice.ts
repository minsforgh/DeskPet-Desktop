import type { LineCatalog, LineParts, LinePetEvent, VoiceKind, VoiceLines, VoiceTemplates } from "@deskpet/core";
import { renderLineParts, renderVoiceParts } from "@deskpet/core";

export type RenderedPetEvent = LinePetEvent & { fullText?: string; parts?: LineParts };

/** Per-kind counters that rotate through a character's variants; kept in memory only. */
export type VoiceCounters = Partial<Record<VoiceKind, number>> & { lines?: Record<string, number> };

export interface LineVoiceContext {
  catalogs: readonly LineCatalog[];
  packLines: VoiceLines;
  overrides: VoiceLines;
}

/**
 * Replaces `text` with the current character's voice rendering when the event asks for a voice
 * and a usable template exists. Everything else about the event stays as received.
 */
export function applyVoice(event: LinePetEvent, templates: VoiceTemplates, counters: VoiceCounters,
  lines?: LineVoiceContext): RenderedPetEvent {
  if (event.line !== undefined) {
    const catalogLine = lines?.catalogs.flatMap((catalog) => catalog.lines).find((line) => line.id === event.line?.id);
    if (catalogLine === undefined) return event;
    const seed = counters.lines?.[catalogLine.id] ?? 0;
    const vars = event.line.vars ?? {};
    for (const variants of [lines?.overrides[catalogLine.id], lines?.packLines[catalogLine.id], catalogLine.variants]) {
      if (variants === undefined || variants.length === 0) continue;
      const rendered = renderLineParts({ version: 1, lines: [{ ...catalogLine, variants }] }, catalogLine.id, vars, seed);
      if (rendered !== undefined) {
        counters.lines ??= {};
        counters.lines[catalogLine.id] = seed + 1;
        return { ...event, ...rendered };
      }
    }
    return event;
  }
  const { voice } = event;
  if (voice === undefined) return event;
  const rendered = renderVoiceParts(templates, voice, counters[voice.kind] ?? 0);
  if (rendered === null) return event;
  counters[voice.kind] = (counters[voice.kind] ?? 0) + 1;
  return { ...event, ...rendered };
}
