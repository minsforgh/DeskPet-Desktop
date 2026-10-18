import type { CharacterManifest, ValidationResult } from "./contracts.js";
import { validateCharacterManifest, validatePackJsonLimits, validUserCharacterId } from "./validate.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Compose a one-level user pack over a built-in pack without changing either input. */
export function mergeCharacterManifest(baseInput: unknown, derivedInput: unknown): ValidationResult<CharacterManifest> {
  const baseResult = validateCharacterManifest(baseInput);
  if (!baseResult.ok) return { ok: false, errors: baseResult.errors.map((error) => `base: ${error}`) };
  const base = baseResult.value;
  if (base.extends !== undefined) return { ok: false, errors: ["base pack must not extend another pack"] };
  if (!isObject(derivedInput)) return { ok: false, errors: ["derived manifest must be an object"] };
  const errors = validatePackJsonLimits(derivedInput);
  if (!validUserCharacterId(derivedInput.id)) errors.push("derived id must be a valid user pack id");
  if (derivedInput.extends !== base.id) errors.push("base pack missing or extends does not match base id");
  if (derivedInput.id === derivedInput.extends) errors.push("pack cannot extend itself");
  if (derivedInput.apiVersion !== "1") errors.push('apiVersion must be "1"');
  if (typeof derivedInput.name !== "string") errors.push("name must be a string");
  for (const field of ["cellSize", "anchor"] as const) {
    if (Object.hasOwn(derivedInput, field)) errors.push(`${field} cannot be overridden`);
  }
  const states: Record<string, unknown> = { ...base.states };
  if (Object.hasOwn(derivedInput, "states")) {
    if (!isObject(derivedInput.states)) errors.push("states must be an object");
    else for (const [name, override] of Object.entries(derivedInput.states)) {
      if (!Object.hasOwn(base.states, name)) { errors.push(`states.${name} cannot add a state`); continue; }
      if (!isObject(override)) { errors.push(`states.${name} must be an object`); continue; }
      for (const field of Object.keys(override)) {
        if (!["fps", "loop", "next"].includes(field)) errors.push(`states.${name}.${field} cannot be overridden`);
      }
      const current = base.states[name];
      if (current !== undefined) {
        const state: Record<string, unknown> = { ...current };
        for (const field of ["fps", "loop", "next"] as const) {
          if (Object.hasOwn(override, field)) state[field] = override[field];
        }
        states[name] = state;
      }
    }
  }
  if (Object.hasOwn(derivedInput, "fallbacks") && !isObject(derivedInput.fallbacks)) errors.push("fallbacks must be an object");
  if (Object.hasOwn(derivedInput, "meta") && !isObject(derivedInput.meta)) errors.push("meta must be an object");
  if (Object.hasOwn(derivedInput, "behavior") && !isObject(derivedInput.behavior)) errors.push("behavior must be an object");
  if (errors.length) return { ok: false, errors };
  const merged = {
    ...base,
    id: derivedInput.id,
    name: derivedInput.name,
    extends: derivedInput.extends,
    states,
    fallbacks: { ...base.fallbacks, ...(isObject(derivedInput.fallbacks) ? derivedInput.fallbacks : {}) },
    meta: { ...base.meta, ...(isObject(derivedInput.meta) ? derivedInput.meta : {}) },
    ...(base.behavior !== undefined || isObject(derivedInput.behavior)
      ? { behavior: { ...base.behavior, ...(isObject(derivedInput.behavior) ? derivedInput.behavior : {}) } } : {}),
    ...(Object.hasOwn(derivedInput, "scale") ? { scale: derivedInput.scale } : {}),
    ...(Object.hasOwn(derivedInput, "preview") ? { preview: derivedInput.preview } : {}),
    ...(Object.hasOwn(derivedInput, "voice") ? { voice: derivedInput.voice } : {}),
    ...(Object.hasOwn(derivedInput, "interactions") ? { interactions: derivedInput.interactions } : {}),
    ...(Object.hasOwn(derivedInput, "sequences") ? { sequences: derivedInput.sequences } : {}),
    ...(Object.hasOwn(derivedInput, "reactions") ? { reactions: derivedInput.reactions } : {}),
    ...(Object.hasOwn(derivedInput, "motions") ? { motions: derivedInput.motions } : {}),
  };
  return validateCharacterManifest(merged);
}
