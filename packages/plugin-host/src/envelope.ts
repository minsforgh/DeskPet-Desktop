export type Envelope =
  | { v: 1; kind: "req"; id: number; method: string; params: unknown; inv?: string }
  | { v: 1; kind: "res"; id: number; ok: true; value: unknown }
  | { v: 1; kind: "res"; id: number; ok: false; error: { code: string; message: string } };

export const MAX_MESSAGE_BYTES = 1024 * 1024;

function binaryBytes(value: unknown, seen = new Set<object>()): number {
  if (value === null || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Blob) return value.size;
  let size = 0;
  const nestedValues = value instanceof Map ? [...value.keys(), ...value.values()] :
    value instanceof Set ? [...value.values()] : Object.values(value);
  for (const nested of nestedValues) {
    size += binaryBytes(nested, seen);
    if (size > MAX_MESSAGE_BYTES) return size;
  }
  return size;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isEnvelope(value: unknown): value is Envelope {
  if (!isObject(value) || value.v !== 1 || !Number.isSafeInteger(value.id) ||
      typeof value.id !== "number" || value.id <= 0) return false;
  if (value.kind === "req") {
    return typeof value.method === "string" && value.method.length > 0 &&
      Object.hasOwn(value, "params") &&
      (!Object.hasOwn(value, "inv") || typeof value.inv === "string") &&
      hasOnly(value, ["v", "kind", "id", "method", "params", "inv"]);
  }
  if (value.kind !== "res" || typeof value.ok !== "boolean") return false;
  if (value.ok) return Object.hasOwn(value, "value") && hasOnly(value, ["v", "kind", "id", "ok", "value"]);
  return isObject(value.error) && typeof value.error.code === "string" &&
    typeof value.error.message === "string" && hasOnly(value.error, ["code", "message"]) &&
    hasOnly(value, ["v", "kind", "id", "ok", "error"]);
}

export function validateEnvelope(value: unknown): { ok: true; value: Envelope } | { ok: false; reason: "shape" | "size" } {
  if (!isEnvelope(value)) return { ok: false, reason: "shape" };
  try {
    const binary = binaryBytes(value);
    if (binary > MAX_MESSAGE_BYTES) return { ok: false, reason: "size" };
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return { ok: false, reason: "shape" };
    if (Buffer.byteLength(serialized, "utf8") + binary > MAX_MESSAGE_BYTES) return { ok: false, reason: "size" };
  } catch {
    return { ok: false, reason: "shape" };
  }
  return { ok: true, value };
}
