import { describe, expect, it, vi } from "vitest";
import { MOTION_LABELS, renderMotionsPanel, type MotionsApi, type MotionsView } from "./motions-panel.js";

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  id = "";
  value = "";
  name = "";
  type = "";
  checked = false;
  disabled = false;
  dataset: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};
  private text = "";
  constructor(readonly tag: string) {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get innerHTML(): string { throw new Error("innerHTML must not be read"); }
  set innerHTML(_value: string) { throw new Error("innerHTML must not be used"); }
  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeElement[]): void { this.text = ""; this.children = nodes; }
  setAttribute(): void {}
  addEventListener(type: string, listener: () => void): void { (this.listeners[type] ??= []).push(listener); }
  dispatch(type: string): void { for (const listener of this.listeners[type] ?? []) listener(); }
  find(predicate: (element: FakeElement) => boolean): FakeElement[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap((child) => child.find(predicate))];
  }
  byId(id: string): FakeElement { const found = this.find((element) => element.id === id)[0]; if (!found) throw new Error(`no #${id}`); return found; }
  byClass(name: string): FakeElement[] { return this.find((element) => element.className.split(" ").includes(name)); }
}
const doc = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
const resolved = Object.fromEntries(MOTION_LABELS.map(([key]) => [key, "walk"]));
const view = (extra: Partial<MotionsView> = {}): MotionsView =>
  ({ motions: {}, landing: "normal", problems: [], states: ["idle", "walk", "curtsy", "<b>jump</b>"],
    nonLoopStates: ["curtsy"], resolved: { ...resolved, land: "idle" }, ...extra });
const mount = (data: MotionsView, saveResult: Awaited<ReturnType<MotionsApi["motionsSave"]>> = { ok: true, packId: "p", derived: false }) => {
  const panel = new FakeElement("div");
  const saves: Array<Parameters<MotionsApi["motionsSave"]>[0]> = [];
  const dirty: boolean[] = [];
  const api: MotionsApi = { motionsSave: async (payload) => { saves.push(payload); return saveResult; } };
  const controller = renderMotionsPanel(doc, panel as unknown as HTMLElement, data, "p", api,
    { setDirty: (value) => dirty.push(value), saved: async () => {} });
  const row = (key: string): FakeElement => {
    const found = panel.byClass("motions-row").find((entry) => entry.dataset.motion === key);
    if (!found) throw new Error(`no row ${key}`);
    return found;
  };
  const select = (key: string): FakeElement => row(key).find((element) => element.tag === "select")[0] as FakeElement;
  const landing = (value: string): FakeElement => panel.find((element) => element.tag === "input" && element.value === value)[0] as FakeElement;
  return { panel, saves, dirty, controller, row, select, landing };
};

describe("motions panel", () => {
  it("shows nine rows with Korean names and the state the app will draw", () => {
    const { panel, row } = mount(view());
    expect(panel.byClass("motions-row")).toHaveLength(9);
    expect(row("climb-ready").textContent).toContain("오르기 준비");
    expect(row("climb-ready").byClass("motions-actual")[0]?.textContent).toBe("재생될 그림: walk");
  });

  it("warns when the drawn state falls to idle and never builds markup from pack strings", () => {
    const { row, select, controller } = mount(view());
    expect(row("land").byClass("field-error")[0]?.textContent).toBe("idle로 떨어지는 동작이에요");
    select("climb").value = "<b>jump</b>";
    select("climb").dispatch("change");
    expect(row("climb").byClass("motions-actual")[0]?.textContent).toBe("재생될 그림: <b>jump</b>");
    expect(controller.dirty()).toBe(true);
  });

  it("flags a mapped state the pack no longer has", () => {
    const { row, select } = mount(view({ motions: { jump: { play: "gone" } }, resolved: { ...resolved, jump: "idle" } }));
    expect(select("jump").value).toBe("gone");
    expect(row("jump").byClass("field-error")[0]?.textContent).toBe("없는 상태예요");
  });

  it("saves the changed mapping and landing, then is clean again", async () => {
    const { saves, select, landing, controller, dirty, panel } = mount(view());
    select("jump").value = "walk";
    select("jump").dispatch("change");
    landing("soft").checked = true;
    landing("soft").dispatch("change");
    expect(dirty.at(-1)).toBe(true);
    panel.byId("mo-save").dispatch("click");
    await vi.waitFor(() => expect(panel.byId("mo-save").disabled).toBe(false));
    expect(saves).toEqual([{ packId: "p", motions: { version: 1, motions: { jump: { play: "walk" } }, landing: "soft" } }]);
    expect(controller.dirty()).toBe(false);
    expect(panel.byId("mo-status").textContent).toBe("저장했어요");
  });

  it("offers only non-looping states after landing and saves or removes the choice", async () => {
    const { panel, saves, controller } = mount(view({ afterLand: { play: "curtsy" } }));
    const select = panel.byClass("motions-after-land")[0]?.find((element) => element.tag === "select")[0];
    expect(select).toBeDefined();
    expect(select?.children.map((child) => child.value)).toEqual(["", "curtsy"]);
    expect(select?.value).toBe("curtsy");
    if (!select) return;
    select.value = "";
    select.dispatch("change");
    expect(controller.dirty()).toBe(true);
    panel.byId("mo-save").dispatch("click");
    await vi.waitFor(() => expect(panel.byId("mo-save").disabled).toBe(false));
    expect(saves[0]?.motions.afterLand).toBeUndefined();
    select.value = "curtsy";
    select.dispatch("change");
    panel.byId("mo-save").dispatch("click");
    await vi.waitFor(() => expect(panel.byId("mo-save").disabled).toBe(false));
    expect(saves[1]?.motions.afterLand).toEqual({ play: "curtsy" });
  });

  it("does not offer an unavailable afterLand state", () => {
    const { panel } = mount(view({ afterLand: { play: "walk" } }));
    const row = panel.byClass("motions-after-land")[0];
    const select = row?.find((element) => element.tag === "select")[0];
    expect(select?.children.map((child) => child.value)).toEqual(["", "curtsy"]);
    expect(select?.value).toBe("");
    expect(row?.textContent).toContain("재생할 수 없어요");
  });

  it("restores defaults without saving", () => {
    const { select, landing, panel, controller } = mount(view({ motions: { fall: { play: "walk" } }, landing: "soft" }));
    panel.byId("mo-reset").dispatch("click");
    expect(select("fall").value).toBe("");
    expect(landing("normal").checked).toBe(true);
    expect(controller.dirty()).toBe(true);
  });

  it("reports a failed save and stays dirty", async () => {
    const { select, panel, controller } = mount(view(), { ok: false, errors: [{ path: "motions", message: "거절됨" }] });
    select("fall").value = "walk";
    select("fall").dispatch("change");
    panel.byId("mo-save").dispatch("click");
    await vi.waitFor(() => expect(panel.byId("mo-save").disabled).toBe(false));
    expect(panel.byId("mo-status").textContent).toBe("거절됨");
    expect(controller.dirty()).toBe(true);
  });

  it("disables saving and editing when the pack cannot be edited", () => {
    const { panel, select, landing } = mount(view({ problems: ["motions file could not be read"] }));
    expect(panel.byId("mo-save").disabled).toBe(true);
    expect(select("jump").disabled).toBe(true);
    expect(landing("soft").disabled).toBe(true);
    expect(panel.textContent).toContain("저장할 수 없어요");
  });
});
