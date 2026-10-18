import type { CharacterManifest, LinePetEvent, ReactionRule, ValidationResult } from "./contracts.js";
import { characterManifestSchema, petEventSchema, userCharacterIdPattern } from "./schemas.js";
import { validateBehavior } from "./behavior.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const eventTypes = ["notify", "react", "status"] as const;
const moods = ["happy", "surprised", "sleepy", "worried", "neutral"] as const;
const priorities = ["low", "normal", "high", "urgent"] as const;
const voiceKinds = ["done", "waiting", "failed", "info", "deadline", "reminder", "alert"] as const;
const voiceSlotNames = ["task", "result", "folder", "message"] as const;
const voiceSlotPattern = new RegExp(petEventSchema.properties.voice.properties.slots.properties.task.pattern);

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isIntegerInRange(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

const sheetPattern = new RegExp(characterManifestSchema.properties.states.additionalProperties.properties.sheet.pattern);
export function isSafePackRelativePath(value: unknown): value is string {
  return typeof value === "string" && sheetPattern.test(value) &&
    Array.from(value).length <= 160 && value.split("/").every((part) => Array.from(part).length <= 64) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".." &&
      ![...part].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ||
        character === "\\" || character === ":") && !/[. ]$/u.test(part));
}

const userIdPattern = new RegExp(userCharacterIdPattern);
const reservedNames = new Set(["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)]);
export function validUserCharacterId(id: unknown): id is string {
  return typeof id === "string" && userIdPattern.test(id) && !reservedNames.has(id);
}

function isDisplayString(value: unknown, max: number): value is string {
  return typeof value === "string" && Array.from(value).length <= max && !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  });
}

export function validatePackJsonLimits(input: unknown): string[] {
  const errors: string[] = [];
  const seen = new WeakSet<object>();
  function visit(value: unknown, depth: number): void {
    if (value === null || typeof value !== "object") return;
    if (depth > 8) { errors.push("JSON depth exceeds 8"); return; }
    if (seen.has(value)) { errors.push("JSON contains a cycle"); return; }
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
    } else {
      const entries = Object.entries(value);
      if (entries.length > 256) errors.push("JSON object exceeds 256 keys");
      for (const [key, child] of entries) {
        if (["__proto__", "constructor", "prototype"].includes(key)) errors.push(`JSON key ${key} is forbidden`);
        visit(child, depth + 1);
      }
    }
    seen.delete(value);
  }
  visit(input, 0);
  return errors;
}

export function validatePetEvent(input: unknown): ValidationResult<LinePetEvent> {
  if (!isObject(input)) return { ok: false, errors: ["event must be an object"] };
  const errors: string[] = [];
  if (typeof input.source !== "string") errors.push("source must be a string");
  if (!isOneOf(input.type, eventTypes)) errors.push("type must be notify, react, or status");
  for (const field of ["key", "detail"] as const) {
    if (Object.hasOwn(input, field) && typeof input[field] !== "string") errors.push(`${field} must be a string`);
  }
  if (Object.hasOwn(input, "text") &&
      (typeof input.text !== "string" || Array.from(input.text).length > 120)) {
    errors.push("text must be a string of at most 120 Unicode code points");
  }
  if (Object.hasOwn(input, "line")) {
    if (!isObject(input.line)) errors.push("line must be an object");
    else {
      if (typeof input.line.id !== "string" || input.line.id.length === 0) errors.push("line.id must be a non-empty string");
      for (const name of Object.keys(input.line)) {
        if (name !== "id" && name !== "vars") errors.push(`line.${name} is not allowed`);
      }
      if (Object.hasOwn(input.line, "vars")) {
        if (!isObject(input.line.vars)) errors.push("line.vars must be an object");
        else for (const [name, value] of Object.entries(input.line.vars)) {
          if (typeof value !== "string" || Array.from(value).length > 500 || !voiceSlotPattern.test(value))
            errors.push(`line.vars.${name} must be a string of at most 500 Unicode code points without control characters`);
        }
      }
    }
  }
  if (Object.hasOwn(input, "mood") && !isOneOf(input.mood, moods)) errors.push("mood must be a known mood");
  if (Object.hasOwn(input, "priority") && !isOneOf(input.priority, priorities)) errors.push("priority must be low, normal, high, or urgent");
  if (Object.hasOwn(input, "voice")) {
    if (!isObject(input.voice)) errors.push("voice must be an object");
    else {
      if (!isOneOf(input.voice.kind, voiceKinds)) errors.push("voice.kind must be done, waiting, failed, info, deadline, reminder, or alert");
      for (const name of Object.keys(input.voice)) {
        if (name !== "kind" && name !== "slots") errors.push(`voice.${name} is not allowed`);
      }
      if (Object.hasOwn(input.voice, "slots")) {
        if (!isObject(input.voice.slots)) errors.push("voice.slots must be an object");
        else for (const [name, value] of Object.entries(input.voice.slots)) {
          if (!voiceSlotNames.some((allowed) => allowed === name)) errors.push(`voice.slots.${name} is not allowed`);
          else if (typeof value !== "string" || Array.from(value).length > 500 || !voiceSlotPattern.test(value))
            errors.push(`voice.slots.${name} must be a string of at most 500 Unicode code points without control characters`);
        }
      }
    }
  }
  if (Object.hasOwn(input, "actions")) {
    if (!Array.isArray(input.actions) || input.actions.length > 3) errors.push("actions must be an array of at most 3 actions");
    else input.actions.forEach((action: unknown, index: number) => {
      if (!isObject(action)) errors.push(`actions[${index}] must be an object`);
      else {
        if (typeof action.label !== "string") errors.push(`actions[${index}].label must be a string`);
        if (typeof action.action !== "string") errors.push(`actions[${index}].action must be a string`);
      }
    });
  }
  if (Object.hasOwn(input, "ttlMs") && !isIntegerInRange(input.ttlMs, 1, Number.MAX_SAFE_INTEGER)) errors.push("ttlMs must be a positive safe integer");
  if (Object.hasOwn(input, "timestamp") && !isIntegerInRange(input.timestamp, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) errors.push("timestamp must be a safe integer");
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as LinePetEvent };
}

export function validateReactionRule(input: unknown): ValidationResult<ReactionRule> {
  if (!isObject(input)) return { ok: false, errors: ["rule must be an object"] };
  const errors: string[] = [];
  if (!isObject(input.match)) errors.push("match must be an object");
  else {
    if (Object.hasOwn(input.match, "source") && typeof input.match.source !== "string") errors.push("match.source must be a string");
    if (Object.hasOwn(input.match, "type") && !isOneOf(input.match.type, eventTypes)) errors.push("match.type must be a known event type");
    if (Object.hasOwn(input.match, "mood") && !isOneOf(input.match.mood, moods)) errors.push("match.mood must be a known mood");
    if (Object.hasOwn(input.match, "priority") && !isOneOf(input.match.priority, priorities)) errors.push("match.priority must be a known priority");
  }
  if (typeof input.play !== "string") errors.push("play must be a string");
  if (Object.hasOwn(input, "durationMs") && !isIntegerInRange(input.durationMs, 1, 60_000)) errors.push("durationMs must be an integer from 1 to 60000");
  if (Object.hasOwn(input, "repeat") && !isIntegerInRange(input.repeat, 1, 10)) errors.push("repeat must be an integer from 1 to 10");
  if (Object.hasOwn(input, "sound") && !isSafePackRelativePath(input.sound)) errors.push("sound must contain safe pack-relative path components");
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as ReactionRule };
}

export function validateCharacterManifest(input: unknown): ValidationResult<CharacterManifest> {
  const errors: string[] = [];
  const numberInRange = (value: unknown, min: number, max: number, integer: boolean): boolean =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));

  if (!isObject(input)) return { ok: false, errors: ["manifest must be an object"] };
  errors.push(...validatePackJsonLimits(input));

  for (const field of ["id", "name"] as const) {
    if (typeof input[field] !== "string") errors.push(`${field} must be a string`);
  }
  if (typeof input.id === "string" && Array.from(input.id).length > 48) errors.push("id must be at most 48 code points");
  if (!isDisplayString(input.name, 80)) errors.push("name must be at most 80 code points without control characters");
  if (input.apiVersion !== "1") errors.push('apiVersion must be "1"');
  for (const field of ["cellSize", "anchor"] as const) {
    const value = input[field];
    if (!Array.isArray(value) || value.length !== 2) {
      errors.push(`${field} must contain exactly two integers`);
      continue;
    }
    for (let index = 0; index < 2; index += 1) {
      const minimum = field === "cellSize" ? 1 : 0;
      if (!numberInRange(value[index], minimum, field === "cellSize" ? 1024 : Number.MAX_VALUE, true)) {
        errors.push(`${field}[${index}] must be an integer ${field === "cellSize" ? "greater than zero" : "at least zero"}`);
      }
    }
  }
  if (Array.isArray(input.anchor) && Array.isArray(input.cellSize) && input.anchor.length === 2 && input.cellSize.length === 2) {
    for (let index = 0; index < 2; index += 1) {
      if (typeof input.anchor[index] === "number" && typeof input.cellSize[index] === "number" && input.anchor[index] >= input.cellSize[index]) {
        errors.push(`anchor[${index}] must be within cellSize[${index}]`);
      }
    }
  }
  if (!numberInRange(input.scale, Number.MIN_VALUE, 4, false)) errors.push("scale must be greater than 0 and at most 4");

  if (!isObject(input.states)) {
    errors.push("states must be an object");
  } else {
    if (!Object.hasOwn(input.states, "idle")) errors.push("states.idle is required");
    if (Object.keys(input.states).length > 32) errors.push("states must contain at most 32 states");
    for (const [name, state] of Object.entries(input.states)) {
      const path = `states.${name}`;
      if (!isObject(state)) {
        errors.push(`${path} must be an object`);
        continue;
      }
      if (!isSafePackRelativePath(state.sheet)) {
        errors.push(`${path}.sheet must contain safe pack-relative path components`);
      }
      if (!numberInRange(state.frames, 1, 64, true)) errors.push(`${path}.frames must be an integer from 1 to 64`);
      if (!numberInRange(state.fps, Number.MIN_VALUE, 60, false)) errors.push(`${path}.fps must be greater than 0 and at most 60`);
      if (typeof state.loop !== "boolean") errors.push(`${path}.loop must be a boolean`);
      if (Object.hasOwn(state, "facing") && !isOneOf(state.facing, ["left", "right"] as const)) errors.push(`${path}.facing must be left or right`);
      if (Object.hasOwn(state, "next")) {
        if (typeof state.next !== "string") errors.push(`${path}.next must be a string`);
        else if (!Object.hasOwn(input.states, state.next)) errors.push(`${path}.next must name a state in states`);
      }
    }
  }

  if (!isObject(input.fallbacks)) {
    errors.push("fallbacks must be an object");
  } else {
    for (const [name, target] of Object.entries(input.fallbacks)) {
      if (typeof target !== "string") errors.push(`fallbacks.${name} must be a string`);
      else if (isObject(input.states) && !Object.hasOwn(input.states, target)) errors.push(`fallbacks.${name} must name a state in states`);
    }
  }

  if (Object.hasOwn(input, "voice") && !isSafePackRelativePath(input.voice)) errors.push("voice must be a safe pack-relative path");
  for (const field of ["preview", "interactions", "sequences", "reactions", "motions"] as const) {
    if (Object.hasOwn(input, field) && (!isSafePackRelativePath(input[field]) ||
      !input[field].endsWith(field === "preview" ? ".png" : ".json")))
      errors.push(`${field} must be a safe pack-relative ${field === "preview" ? "PNG" : "JSON"} path`);
  }
  if (Object.hasOwn(input, "extends") && !validUserCharacterId(input.extends)) errors.push("extends must be a valid pack id");
  if (Object.hasOwn(input, "behavior")) errors.push(...validateBehavior(input.behavior));
  if (Object.hasOwn(input, "meta")) {
    if (!isObject(input.meta)) errors.push("meta must be an object");
    else for (const [field, max] of [["author", 80], ["version", 32], ["license", 80],
      ["description", 500], ["createdWith", 80]] as const) {
      if (Object.hasOwn(input.meta, field) && !isDisplayString(input.meta[field], max))
        errors.push(`meta.${field} must be at most ${max} code points without control characters`);
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as CharacterManifest };
}
