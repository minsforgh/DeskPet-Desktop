// attendance/today 응답에서 시작·종료 여부만 뽑는다. 값은 밖으로 내보내지 않는다.

export type TodayParse = { kind: "ok"; started: boolean; ended: boolean } | { kind: "unexpectedShape" };

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function isStampField(value: unknown): boolean {
  return value === null || value === undefined || typeof value === "string";
}

export function parseToday(payload: unknown): TodayParse {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { kind: "unexpectedShape" };
  }
  const record = payload as Record<string, unknown>;
  // 구조 표지가 없으면 형식이 바뀐 것이므로 "미시작"으로 오해하지 않는다.
  if (typeof record.date !== "string" && typeof record.status !== "string") {
    return { kind: "unexpectedShape" };
  }
  if (!isStampField(record.checkedAt) || !isStampField(record.checkedOutAt)) {
    return { kind: "unexpectedShape" };
  }
  return { kind: "ok", started: nonEmpty(record.checkedAt), ended: nonEmpty(record.checkedOutAt) };
}
