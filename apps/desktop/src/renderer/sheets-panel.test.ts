import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PackListItem } from "../main/pack-service.js";
import { failureText, issueText, parsePick, renderSheetsPanel, type SheetsApi } from "./sheets-panel.js";

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  id = "";
  value = "";
  type = "";
  src = "";
  alt = "";
  checked = false;
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};
  private text = "";
  constructor(readonly tag: string) {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get innerHTML(): string { throw new Error("innerHTML must not be read"); }
  set innerHTML(_value: string) { throw new Error("innerHTML must not be used"); }
  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeElement[]): void { this.text = ""; this.children = nodes; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(type: string, listener: () => void): void { (this.listeners[type] ??= []).push(listener); }
  dispatch(type: string): void { for (const listener of this.listeners[type] ?? []) listener(); }
  click(): void { this.dispatch("click"); }
  find(predicate: (element: FakeElement) => boolean): FakeElement[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap((child) => child.find(predicate))];
  }
  byId(id: string): FakeElement { const found = this.find((element) => element.id === id)[0]; if (!found) throw new Error(`no #${id}`); return found; }
}
const doc = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
const flush = async (): Promise<void> => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); };
const pack: PackListItem = { id: "placeholder", name: "<b>P</b>", source: "builtin", valid: true, current: true, directEdit: true,
  states: { idle: { frames: 8, fps: 8, loop: true, next: "blink", facing: "left" }, "<i>x</i>": { frames: 2, fps: 4, loop: false } } };
const PREVIEW = "data:image/png;base64,AAAA";
const clean = { canceled: false, token: "t", preview: PREVIEW, footCheck: { skipped: false, issueFrames: 0, issues: [] } };
const issuePick = { canceled: false, token: "t1", preview: PREVIEW,
  footCheck: { skipped: false, issueFrames: 2, issues: [
    { frame: 3, reason: "foot y exceeds tolerance", measured: 90, expected: 100 }, { frame: 5, reason: "발 근처 잡점" }] } };

function setup(pick: unknown, applyResult: unknown = {}) {
  const root = new FakeElement("section");
  const calls: Array<{ kind: string; payload: unknown }> = [];
  const api: SheetsApi = {
    sheetPick: async (payload) => { calls.push({ kind: "pick", payload }); return pick; },
    sheetApply: async (payload) => { calls.push({ kind: "apply", payload }); if (applyResult instanceof Error) throw applyResult; return applyResult; },
  };
  const applied: string[] = [];
  renderSheetsPanel(doc, root as unknown as HTMLElement, pack, api, { applied: async (id, text) => { applied.push(`${id}:${text}`); } });
  return { root, calls, applied };
}

describe("sheets panel", () => {
  it("lists states with text only and offers replace and add", () => {
    const { root } = setup(undefined);
    const rows = root.byId("sh-states").children;
    expect(rows).toHaveLength(2);
    expect(rows[1]?.dataset.state).toBe("<i>x</i>");
    expect(rows[1]?.textContent).toContain("<i>x</i>");
    expect(rows[0]?.textContent).toContain("8프레임 · 8fps · 반복");
  });

  it("keeps apply disabled until 그래도 사용 when the foot check found issues, and sends only the token and settings", async () => {
    const { root, calls, applied } = setup(issuePick);
    root.byId("sh-add").click();
    root.byId("sh-name").value = "bow";
    root.byId("sh-frames").value = "8";
    root.byId("sh-pick").click();
    await flush();
    expect(calls[0]).toEqual({ kind: "pick", payload: { packId: "placeholder", frames: 8 } });
    expect(root.byId("sh-preview").src).toBe(PREVIEW);
    expect(root.byId("sh-foot-summary").textContent).toBe("발 위치 이상 2프레임");
    expect(root.byId("sh-foot-issues").children.map((item) => item.textContent)).toEqual([
      "3번 프레임: 발 높이가 기준에서 벗어남 · 측정 90 · 기대 100", "5번 프레임: 발 근처 잡점"]);
    expect(root.byId("sh-apply").disabled).toBe(true);
    root.byId("sh-apply").click();
    await flush();
    expect(calls).toHaveLength(1);
    root.byId("sh-override").click();
    expect(root.byId("sh-apply").disabled).toBe(false);
    root.byId("sh-apply").click();
    await flush();
    expect(calls[1]).toEqual({ kind: "apply", payload: { packId: "placeholder", token: "t1", state: "bow", frames: 8, fps: 8, loop: true,
      overrideFootIssues: true } });
    expect(applied).toEqual(["placeholder:bow 상태를 추가했어요"]);
  });

  it("enables apply right away without issues, and reports a skipped check", async () => {
    const { root } = setup({ ...clean, footCheck: { skipped: true, issueFrames: 0, issues: [] } });
    root.byId("sh-add").click();
    root.byId("sh-pick").click();
    await flush();
    expect(root.byId("sh-foot-summary").textContent).toContain("건너뛰");
    expect(root.byId("sh-apply").disabled).toBe(false);
    expect(root.byId("sh-override").hidden).toBe(true);
  });

  it("rejects a bad new name locally, and a replace keeps the state's own next and facing", async () => {
    const added = setup(clean);
    added.root.byId("sh-add").click();
    added.root.byId("sh-name").value = "Bow";
    added.root.byId("sh-pick").click();
    await flush();
    added.root.byId("sh-apply").click();
    await flush();
    expect(added.calls.filter(({ kind }) => kind === "apply")).toHaveLength(0);
    expect(added.root.byId("sh-status").textContent).toContain("규칙");
    expect(added.root.byId("sh-status").className).toContain("error");

    const replaced = setup(clean);
    replaced.root.byId("sh-states").children[0]?.children[2]?.click();
    replaced.root.byId("sh-pick").click();
    await flush();
    replaced.root.byId("sh-apply").click();
    await flush();
    expect(replaced.calls[1]?.payload).toEqual({ packId: "placeholder", token: "t", state: "idle", frames: 8, fps: 8, loop: true,
      next: "blink", facing: "left" });
  });

  it("shows main's refusal text and drops the spent pick", async () => {
    const { root } = setup(clean, new Error("Error invoking remote method 'settings:sheet-apply': Error: 시트 선택이 만료되었습니다. 다시 골라 주세요"));
    root.byId("sh-add").click();
    root.byId("sh-name").value = "bow";
    root.byId("sh-pick").click();
    await flush();
    root.byId("sh-apply").click();
    await flush();
    expect(root.byId("sh-status").textContent).toContain("시트 선택이 만료되었습니다");
    expect(root.byId("sh-apply").disabled).toBe(true);
  });

  it("handles a cancel and a malformed answer without showing a preview", async () => {
    const canceled = setup({ canceled: true });
    canceled.root.byId("sh-add").click();
    canceled.root.byId("sh-pick").click();
    await flush();
    expect(canceled.root.byId("sh-status").textContent).toContain("취소");
    const bad = setup({ ...clean, preview: "https://example.com/x.png" });
    bad.root.byId("sh-add").click();
    bad.root.byId("sh-pick").click();
    await flush();
    expect(bad.root.byId("sh-status").className).toContain("error");
    expect(bad.root.find((element) => element.id === "sh-preview")).toHaveLength(0);
  });

  it("parses and words results", () => {
    expect(parsePick({ canceled: true })).toBe("canceled");
    expect(parsePick({ canceled: false, token: "t" })).toBeUndefined();
    expect(issueText({ frame: 1, reason: "empty frame" })).toBe("1번 프레임: 몸 픽셀이 없는 빈 프레임");
    expect(failureText(new Error("Error invoking remote method 'x': Error: 개발자 모드에서만 시트를 편집할 수 있습니다")))
      .toBe("개발자 모드에서만 시트를 편집할 수 있습니다");
    expect(failureText("x")).toBe("처리하지 못했어요");
  });

  it("adds only img-src data: to the settings window CSP", () => {
    const html = readFileSync(new URL("./settings.html", import.meta.url), "utf8");
    expect(html).toContain("content=\"default-src 'none'; script-src 'self'; style-src 'self'; img-src data:\"");
  });
});
