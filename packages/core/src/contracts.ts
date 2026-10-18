export interface PetEvent {
  source: string; // Plugin id or "http".
  type: "notify" | "react" | "status";
  key?: string;
  /** Bubble text, at most 120 characters. */
  text?: string;
  detail?: string;
  /** Render with the current character's voice template; use text when no template exists. */
  voice?: {
    kind: "done" | "waiting" | "failed" | "info" | "deadline" | "reminder" | "alert";
    slots?: { task?: string; result?: string; folder?: string; message?: string };
  };
  mood?: "happy" | "surprised" | "sleepy" | "worried" | "neutral";
  priority?: "low" | "normal" | "high" | "urgent";
  /** At most three actions. */
  actions?: Array<{ label: string; action: string; args?: unknown }>;
  /** Positive integer milliseconds measured from the time the core receives the event. */
  ttlMs?: number;
  /** Epoch milliseconds; the core fills in its receipt time when omitted. */
  timestamp?: number;
}

/** v2 and internal event shape; v1 emit remains typed as PetEvent. */
export interface LinePetEvent extends PetEvent {
  line?: { id: string; vars?: Record<string, string> };
}

export interface ReactionRule {
  match: {
    source?: string;
    type?: PetEvent["type"];
    mood?: PetEvent["mood"];
    priority?: PetEvent["priority"];
  };
  play: string;
  durationMs?: number;
  repeat?: number;
  sound?: string;
}

export interface CharacterState {
  sheet: string;
  /** Positive integer; zero frames cannot be animated. */
  frames: number;
  fps: number;
  loop: boolean;
  next?: string;
  /** Direction depicted by this state; omitted for directionless art. */
  facing?: "left" | "right";
}

export interface CharacterBehavior {
  sleepAfterMs?: number;
  blinkIntervalMs?: readonly [number, number];
  walkIntervalMs?: readonly [number, number];
  walkDurationMs?: number;
  walkSpeedPxPerSecond?: number;
  /** 0-1 chance of climbing a wall the pet walks into (ADR-0009 §10). */
  climbChance?: number;
  /** 0-1 chance of stepping off a ledge the pet walks to. */
  descendChance?: number;
  /** ADR-0009 §17: height difference (DIP) up to which the pet jumps instead of climbing. */
  jumpMaxHeight?: number;
  /** Climb and climb-down speed, DIP/s. */
  climbSpeed?: number;
  /** Extra height (DIP) a jump rises above the top edge. */
  jumpClearance?: number;
  /** Gravity for falls, jumps and throws, DIP/s². */
  gravity?: number;
  /** ADR-0009 §18: gap (DIP) from a ledge within which the pet may jump to the next window; 0 turns it off. */
  gapJumpDistance?: number;
  /** 0-1 chance of jumping the gap when there is a window to jump to. */
  gapJumpChance?: number;
}

export interface CharacterManifest {
  id: string;
  name: string;
  /** Character manifest API version is the literal string "1". */
  apiVersion: "1";
  cellSize: [number, number];
  anchor: [number, number];
  scale: number;
  states: Record<string, CharacterState>;
  fallbacks: Record<string, string>;
  /** Pack-relative path of the voice template file, e.g. "voice.json". */
  voice?: string;
  meta?: { author?: string; version?: string; license?: string; description?: string; createdWith?: string };
  preview?: string;
  extends?: string;
  interactions?: string;
  sequences?: string;
  reactions?: string;
  /** Pack-relative path of the movement-to-state map and landing style (ADR-0009 §9-2). */
  motions?: string;
  behavior?: CharacterBehavior;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };
