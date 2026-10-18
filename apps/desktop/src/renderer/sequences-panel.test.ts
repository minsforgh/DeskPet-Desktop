import { describe, expect, it } from "vitest";
import { renderSequencesPanel, sequenceProblem, totalMs, type SequencesApi, type SequencesView } from "./sequences-panel.js";

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  id = "";
  value = "";
  type = "";
  checked = false;
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};
  private text = "";
  readonly classList = {
    remove: (...names: string[]) => { this.className = this.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
    add: (name: string) => { this.className = `${this.className} ${name}`.trim(); },
  };
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
  byClass(name: string): FakeElement[] { return this.find((element) => element.className.split(" ").includes(name)); }
}
const doc = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
const plays = { idle: { resolved: "idle", cycleMs: 1_000 }, happy: { resolved: "happy", cycleMs: 600 }, talk: { resolved: "talk", cycleMs: 500 },
  celebrate: { resolved: "happy", cycleMs: 600 } };
const view = (extra: Partial<SequencesView> = {}): SequencesView => ({ plays, refs: [], sequences: [
  { id: "greet", label: "인사", steps: [{ play: "happy", ms: 1_500, say: "<b>안녕</b>" }, { play: "talk" }] }], ...extra });
const row = (panel: FakeElement, id: string): FakeElement => {
  const found = panel.byClass("sq-row").find((entry) => entry.dataset.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};
const input = (element: FakeElement, value: string): void => { element.value = value; element.dispatch("input"); };
const flush = async (): Promise<void> => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };
function setup(initial = view()) {
  const panel = new FakeElement("section");
  const saves: Array<{ packId: string; sequences: unknown }> = [];
  const tries: unknown[] = [];
  const dirty: boolean[] = [];
  const api: SequencesApi = {
    sequencesSave: async (payload) => { saves.push(payload); return { ok: true, packId: payload.packId, derived: false }; },
    interactionsTry: async (payload) => { tries.push(payload); return { ok: true }; },
  };
  renderSequencesPanel(doc, panel as unknown as HTMLElement, initial, "wolf-maid", api, { setDirty: (value) => { dirty.push(value); }, saved: async () => {} });
  return { panel, saves, tries, dirty };
}

describe("sequence editor", () => {
  it("shows seconds, keeps pack strings as text, and saves the same sequences unchanged", async () => {
    const { panel, saves, dirty } = setup();
    expect(panel.byClass("sq-sec").map((element) => element.value)).toEqual(["1.5", ""]);
    expect(panel.byClass("sq-say")[0]?.value).toBe("<b>안녕</b>");
    expect(panel.byClass("sq-summary")[0]?.textContent).toBe("2단계 · 2초");
    panel.byId("sq-save").click();
    await flush();
    expect(saves).toEqual([{ packId: "wolf-maid", sequences: { version: 1, sequences: [{ id: "greet", label: "인사",
      steps: [{ play: "happy", ms: 1_500, say: "<b>안녕</b>" }, { play: "talk" }] }] } }]);
    expect(dirty.at(-1)).toBe(false);
  });

  it("adds a sequence, converts seconds to milliseconds, marks dirty, and cancel restores", async () => {
    const { panel, saves, dirty } = setup(view({ sequences: [] }));
    panel.byId("sq-add").click();
    const added = row(panel, "sequence-1");
    input(added.byClass("sq-sec")[0] as FakeElement, "2.5");
    input(added.byClass("sq-say")[0] as FakeElement, " 어서 오세요 ");
    expect(panel.byId("sq-dirty").textContent).toBe("저장하지 않은 변경이 있어요");
    expect(dirty.at(-1)).toBe(true);
    panel.byId("sq-save").click();
    await flush();
    expect(saves[0]?.sequences).toMatchObject({ sequences: [{ id: "sequence-1", steps: [{ play: "happy", ms: 2_500, say: "어서 오세요" }] }] });
    expect(dirty.at(-1)).toBe(false);
    panel.byId("sq-add").click();
    expect(panel.byClass("sq-row")).toHaveLength(2);
    panel.byId("sq-cancel").click();
    expect(panel.byClass("sq-row")).toHaveLength(1);
  });

  it("blocks saving with a row error for bad ids, durations and duplicate ids", async () => {
    const { panel, saves } = setup();
    input(row(panel, "greet").byClass("sq-sec")[0] as FakeElement, "0.1");
    panel.byId("sq-save").click();
    await flush();
    expect(saves).toHaveLength(0);
    expect(panel.byId("sq-status").textContent).toContain("저장하지 못했어요");
    expect(row(panel, "greet").byClass("ix-error")[0]?.textContent).toBe("1단계: 시간은 0.3~10초여야 해요");
    expect(sequenceProblem({ key: 1, id: "Bad", label: "", steps: [{ play: "idle", sec: "", say: "" }] }, [])).toContain("id는");
    const dup = { key: 2, id: "a", label: "", steps: [{ play: "idle", sec: "", say: "" }] };
    expect(sequenceProblem(dup, [dup, { ...dup, key: 3 }])).toBe("같은 id가 이미 있어요");
    expect(sequenceProblem({ key: 4, id: "a", label: "", steps: [{ play: "walk", sec: "", say: "" }] }, [])).toContain("재생 동작");
  });

  it("warns at eight steps and over thirty seconds, counting blank lengths as one cycle (at least 300 ms)", () => {
    expect(totalMs([{ play: "idle", sec: "" }, { play: "talk", sec: "" }, { play: "happy", sec: "1" }, { play: "missing", sec: "" }], plays)).toBe(2_800);
    const { panel } = setup(view({ sequences: [{ id: "long", steps: Array.from({ length: 8 }, () => ({ play: "idle", ms: 4_000 })) }] }));
    const warning = row(panel, "long").byClass("sq-warn")[0]?.textContent ?? "";
    expect(warning).toContain("단계는 최대 8개");
    expect(warning).toContain("총 32초");
    expect(row(panel, "long").byClass("sq-add-step")[0]?.disabled).toBe(true);
  });

  it("sends one step to the pet as a play-and-line preview", async () => {
    const { panel, tries } = setup();
    (row(panel, "greet").byClass("sq-try")[0] as FakeElement).click();
    await flush();
    expect(tries).toEqual([{ id: "sequence-preview", label: "미리보기", mood: "neutral", speak: true, lines: ["<b>안녕</b>"], play: "happy" }]);
  });

  it("lists the interactions that use a sequence, warns when its id changes, and names them on delete", () => {
    const { panel } = setup(view({ refs: [{ id: "hello", label: "인사하기", sequence: "greet" }] }));
    const target = row(panel, "greet");
    expect(target.byClass("sq-refs")[0]?.textContent).toBe("이 동작을 쓰는 상호작용: 인사하기");
    input(target.byClass("sq-id")[0] as FakeElement, "greet-2");
    expect(target.byClass("sq-refs")[0]?.textContent).toContain("연결이 끊겨요");
    target.byClass("sq-delete")[0]?.click();
    expect(panel.byId("sq-status").textContent).toContain("인사하기");
  });
});
