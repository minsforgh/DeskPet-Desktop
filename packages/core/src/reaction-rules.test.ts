import { describe, expect, it } from "vitest";
import { selectReaction } from "@deskpet/core";
import type { PetEvent, ReactionRule } from "@deskpet/core";

const event = (extra: Partial<PetEvent> = {}): PetEvent => ({ source: "http", type: "react", ...extra });

describe("selectReaction", () => {
  it("maps moods to core states and leaves neutral or absent moods alone", () => {
    for (const [mood, play] of [["happy", "happy"], ["surprised", "surprised"], ["worried", "worried"], ["sleepy", "sleep"]] as const) {
      expect(selectReaction(event({ mood }))).toEqual({ play });
    }
    expect(selectReaction(event({ mood: "neutral" }))).toBeUndefined();
    expect(selectReaction(event())).toBeUndefined();
  });

  it("repeats urgent defaults three times", () => {
    expect(selectReaction(event({ mood: "happy", priority: "urgent" }))).toEqual({ play: "happy", repeat: 3 });
    expect(selectReaction(event({ priority: "urgent" }), [{ match: {}, play: "walk" }])).toEqual({ play: "walk", repeat: 3 });
    expect(selectReaction(event({ priority: "urgent" }), [{ match: {}, play: "walk", repeat: 2 }])).toEqual({ play: "walk", repeat: 2 });
  });

  it("prioritizes additional matching rules over defaults, then specificity, then latest insertion", () => {
    const rules: ReactionRule[] = [
      { match: {}, play: "idle" },
      { match: { mood: "happy" }, play: "talk" },
      { match: { mood: "happy", source: "http" }, play: "walk", durationMs: 500 },
      { match: { mood: "happy", source: "http" }, play: "drag", repeat: 2 },
      { match: { mood: "worried" }, play: "worried" },
    ];
    expect(selectReaction(event({ mood: "happy" }), rules)).toEqual({ play: "drag", repeat: 2 });
    expect(selectReaction(event({ mood: "neutral" }), rules)).toEqual({ play: "idle" });
    expect(selectReaction(event({ mood: "happy", source: "else" }), rules)).toEqual({ play: "talk" });
  });

  it("requires all declared match conditions, including priority and type", () => {
    const rules: ReactionRule[] = [{ match: { type: "notify", priority: "urgent" }, play: "surprised" }];
    expect(selectReaction(event({ mood: "sleepy", priority: "urgent" }), rules)).toEqual({ play: "sleep", repeat: 3 });
    expect(selectReaction(event({ type: "notify", priority: "urgent" }), rules)).toEqual({ play: "surprised", repeat: 3 });
  });
});
