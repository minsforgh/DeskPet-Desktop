import { describe, expect, it } from "vitest";
import { parseToday } from "./today.js";

const base = { id: "x", date: "2026-10-08", status: "NONE", checkedAt: null, checkedOutAt: null, isStudying: false };

describe("parseToday", () => {
  it("미시작", () => {
    expect(parseToday(base)).toEqual({ kind: "ok", started: false, ended: false });
  });

  it("시작·종료", () => {
    expect(parseToday({ ...base, checkedAt: "2026-10-08T09:00:00" })).toEqual({ kind: "ok", started: true, ended: false });
    expect(parseToday({ ...base, checkedAt: "a", checkedOutAt: "b" })).toEqual({ kind: "ok", started: true, ended: true });
  });

  it("null·필드 없음·빈 문자열은 모두 미시작", () => {
    for (const checkedAt of [null, undefined, "", "  "]) {
      expect(parseToday({ ...base, checkedAt })).toEqual({ kind: "ok", started: false, ended: false });
    }
    const noFields: Record<string, unknown> = { ...base };
    delete noFields.checkedAt;
    delete noFields.checkedOutAt;
    expect(parseToday(noFields)).toEqual({ kind: "ok", started: false, ended: false });
  });

  it("표지는 date 또는 status 중 하나만 문자열이어도 된다", () => {
    expect(parseToday({ date: "d" }).kind).toBe("ok");
    expect(parseToday({ status: "s" }).kind).toBe("ok");
  });

  it("거짓 경보 방지: 표지 없음은 unexpectedShape", () => {
    for (const body of [{}, [], "<html></html>", null, undefined, 3, { date: 1, status: null }, { checkedAt: null }]) {
      expect(parseToday(body)).toEqual({ kind: "unexpectedShape" });
    }
  });

  it("checkedAt/checkedOutAt 형식이 다르면 unexpectedShape", () => {
    expect(parseToday({ ...base, checkedAt: 123 })).toEqual({ kind: "unexpectedShape" });
    expect(parseToday({ ...base, checkedOutAt: {} })).toEqual({ kind: "unexpectedShape" });
    expect(parseToday({ ...base, checkedAt: true })).toEqual({ kind: "unexpectedShape" });
  });

  it("결과에 응답 값이 담기지 않는다", () => {
    expect(JSON.stringify(parseToday({ ...base, checkedAt: "SECRET" }))).not.toContain("SECRET");
  });
});
