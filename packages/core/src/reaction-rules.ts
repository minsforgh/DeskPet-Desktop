import type { PetEvent, ReactionRule } from "./contracts.js";

export type SelectedReaction = Pick<ReactionRule, "play" | "durationMs" | "repeat">;

/** Later rules win ties; a rule with more declared match conditions wins first. */
export function selectReaction(event: PetEvent, rules: readonly ReactionRule[] = []): SelectedReaction | undefined {
  let selected: ReactionRule | undefined;
  let specificity = -1;
  for (const rule of rules) {
    const fields = ["source", "type", "mood", "priority"] as const;
    if (!fields.every((field) => rule.match[field] === undefined || rule.match[field] === event[field])) continue;
    const count = fields.filter((field) => rule.match[field] !== undefined).length;
    if (count >= specificity) {
      selected = rule;
      specificity = count;
    }
  }
  if (selected) return {
    play: selected.play,
    ...(selected.durationMs === undefined ? {} : { durationMs: selected.durationMs }),
    ...(selected.repeat === undefined ? (event.priority === "urgent" ? { repeat: 3 } : {}) : { repeat: selected.repeat }),
  };
  const play = event.mood === "sleepy" ? "sleep" : event.mood;
  if (play === undefined || play === "neutral") return undefined;
  return event.priority === "urgent" ? { play, repeat: 3 } : { play };
}
