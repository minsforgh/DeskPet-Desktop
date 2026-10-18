import { describe, expect, it } from "vitest";
import { parseInteractions } from "@deskpet/core";
import { fromPackInteractions } from "../main/interaction-store.js";
import { getDefaultInteractions, type PetInteraction } from "../main/pet-menu.js";
import type { InteractionsView } from "../main/settings-service.js";
import { createInteractionsReload, renderInteractionsPanel, type InteractionsApi } from "./interactions-panel.js";

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
const defaults = getDefaultInteractions();
const defaultPat = defaults.find(({ id }) => id === "pat");
if (!defaultPat) throw new Error("default pat interaction missing");
const view = (extra: PetInteraction[] = []): InteractionsView => ({ items: [...getDefaultInteractions(), ...extra], defaults });
const flush = async (): Promise<void> => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };
const rows = (panel: FakeElement): FakeElement[] => panel.byClass("ix-row");
const row = (panel: FakeElement, id: string): FakeElement => {
  const found = rows(panel).find((entry) => entry.dataset.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};
const part = (panel: FakeElement, id: string, name: string): FakeElement => {
  const found = row(panel, id).byClass(name)[0];
  if (!found) throw new Error(`no ${name}`);
  return found;
};
const input = (element: FakeElement, value: string): void => { element.value = value; element.dispatch("input"); };
function setup(initial = view(), packId = "placeholder") {
  const panel = new FakeElement("section");
  const saves: Array<{ packId: string; interactions: unknown }> = [];
  const tries: unknown[] = [];
  const dirty: boolean[] = [];
  const api: InteractionsApi = {
    packSaveInteractions: async (payload) => { saves.push(payload); return { ok: true, packId: payload.packId, derived: false }; },
    interactionsTry: async (payload) => { tries.push(payload); return { ok: true }; },
  };
  renderInteractionsPanel(doc, panel as unknown as HTMLElement, initial, packId, api,
    { setDirty: (value) => { dirty.push(value); }, saved: async () => {} });
  return { panel, saves, tries, dirty };
}

describe("interactions editor", () => {
  it("saves a chosen play, keeps sequence, and warns when fallback resolves to idle", async () => {
    const initial: InteractionsView = { ...view(), states: ["idle", "happy", "surprised"],
      fallbacks: { celebrate: "happy", missing: "idle" } };
    const pat = initial.items[0];
    if (!pat) throw new Error("pat default missing");
    initial.items[0] = { ...pat, sequence: "greeting" };
    const { panel, saves } = setup(initial);
    part(panel, "pat", "ix-toggle").click();
    const play = part(panel, "pat", "ix-play");
    expect(play.children.map((option) => option.value)).toEqual(["", "celebrate", "happy", "idle", "missing", "surprised"]);
    play.value = "missing";
    play.dispatch("change");
    expect(part(panel, "pat", "ix-play-warning").textContent).toContain("idle");
    play.value = "celebrate";
    play.dispatch("change");
    expect(part(panel, "pat", "ix-play-warning").textContent).toBe("");
    play.value = "surprised";
    play.dispatch("change");
    expect(part(panel, "pat", "ix-play-warning").textContent).toBe("");
    panel.byId("ix-save").click();
    await flush();
    const saved = saves[0]?.interactions as { items: Array<{ id: string; play?: string; sequence?: string }> };
    expect(saved.items[0]).toMatchObject({ id: "pat", play: "surprised", sequence: "greeting" });
    const parsed = parseInteractions(saved);
    expect(parsed.problems).toEqual([]);
    expect(fromPackInteractions(parsed.interactions)[0]).toMatchObject({ id: "pat", play: "surprised", sequence: "greeting" });
  });
  it("renders folded sections with Korean moods, then opens an editor with line controls", () => {
    const { panel } = setup();
    expect(rows(panel).map((entry) => entry.dataset.id)).toEqual(["pat", "talk", "scare"]);
    expect(part(panel, "pat", "ix-toggle").textContent).toBe(defaultPat.label);
    expect(part(panel, "pat", "ix-toggle").attributes["aria-expanded"]).toBe("false");
    expect(part(panel, "pat", "ix-mood").children.map((entry) => entry.textContent)).toEqual(["기쁨", "놀람", "졸림", "걱정", "평온"]);
    expect(part(panel, "pat", "ix-line-count").textContent).toBe("대사 1줄");
    expect(part(panel, "pat", "ix-body").hidden).toBe(true);
    part(panel, "pat", "ix-toggle").click();
    expect(part(panel, "pat", "ix-body").hidden).toBe(false);
    expect(part(panel, "pat", "ix-line").value).toBe(defaultPat.lines[0]);
    expect(part(panel, "pat", "ix-try").textContent).toBe("▶ 펫에게 보내기");
    expect(row(panel, "pat").byClass("ix-delete")).toHaveLength(0);
  });

  it("moves visible rows in saved pack order and adds an opened custom section", async () => {
    const { panel, saves } = setup();
    part(panel, "talk", "ix-up").click();
    expect(rows(panel).map((entry) => entry.dataset.id)).toEqual(["talk", "pat", "scare"]);
    panel.byId("ix-add").click();
    expect(rows(panel).at(-1)?.dataset.id).toBe("custom-1");
    expect(part(panel, "custom-1", "ix-body").hidden).toBe(false);
    panel.byId("ix-save").click();
    await flush();
    const data = saves[0]?.interactions as { items: Array<{ id: string }> };
    expect(data.items.map(({ id }) => id)).toEqual(["talk", "pat", "scare", "custom-1"]);
  });

  it("always saves the full list in screen order, hidden shipped items included", async () => {
    const { panel, saves } = setup();
    part(panel, "scare", "ix-up").click();
    panel.byId("ix-save").click();
    await flush();
    const data = saves[0]?.interactions as { items: Array<{ id: string }> };
    expect(data.items.map(({ id }) => id)).toEqual(["pat", "scare", "talk"]);
    const hiddenView = setup({ items: getDefaultInteractions().map((entry) => entry.id === "talk" ? { ...entry, hidden: true } : entry), defaults });
    hiddenView.panel.byId("ix-save").click();
    await flush();
    const hiddenData = hiddenView.saves[0]?.interactions as { items: Array<{ id: string }>; hidden: string[] };
    expect(hiddenData.items.map(({ id }) => id)).toEqual(["pat", "talk", "scare"]);
    expect(hiddenData.hidden).toEqual(["talk"]);
  });

  it("collects hidden items below and restores them; shipped rows cannot be deleted", () => {
    const { panel } = setup();
    part(panel, "pat", "ix-hide").click();
    expect(rows(panel).map((entry) => entry.dataset.id)).toEqual(["talk", "scare"]);
    expect(panel.byClass("ix-hidden-list")[0]?.textContent).toContain(`숨긴 항목${defaultPat.label}다시 보이기`);
    panel.byClass("ix-show")[0]?.click();
    expect(rows(panel).map((entry) => entry.dataset.id)).toEqual(["pat", "talk", "scare"]);
    expect(row(panel, "pat").byClass("ix-delete")).toHaveLength(0);
  });

  it("warns when a speaking item has zero lines and refuses invalid limits", async () => {
    const { panel, saves } = setup();
    part(panel, "pat", "ix-toggle").click();
    part(panel, "pat", "ix-line-delete").click();
    panel.byId("ix-save").click();
    await flush();
    expect(part(panel, "pat", "ix-error").textContent).toBe("대사를 한 줄 이상 적어 주세요");
    expect(saves).toHaveLength(0);
    part(panel, "pat", "ix-add-line").click();
    input(part(panel, "pat", "ix-line"), "가".repeat(121));
    panel.byId("ix-save").click();
    await flush();
    expect(part(panel, "pat", "ix-error").textContent).toBe("대사는 120자 이하여야 해요");
  });

  it("saves a selected non-current pack by its id and clears dirty; cancel restores edits", async () => {
    const { panel, saves, dirty } = setup(view(), "wolf-maid");
    part(panel, "pat", "ix-toggle").click();
    input(part(panel, "pat", "ix-label"), "다른 이름");
    expect(panel.byId("ix-dirty").textContent).toBe("저장하지 않은 변경이 있어요");
    panel.byId("ix-cancel").click();
    expect(part(panel, "pat", "ix-toggle").textContent).toBe(defaultPat.label);
    part(panel, "pat", "ix-toggle").click();
    input(part(panel, "pat", "ix-label"), "다른 이름");
    panel.byId("ix-save").click();
    await flush();
    expect(saves[0]?.packId).toBe("wolf-maid");
    expect(panel.byId("ix-dirty").textContent).toBe("");
    expect(dirty.at(-1)).toBe(false);
  });

  it("sends the chosen line as the user wrote it", async () => {
    const { panel, tries } = setup();
    part(panel, "pat", "ix-toggle").click();
    input(part(panel, "pat", "ix-line"), "지금 대사");
    part(panel, "pat", "ix-try").click();
    await flush();
    expect(tries).toMatchObject([{ id: "pat", lines: ["지금 대사"] }]);
  });
});

describe("interaction reload", () => {
  it("drops delayed responses after an edit, and discards older pack responses", async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    let dirty = false;
    const drawn: string[] = [];
    const reloader = createInteractionsReload((id) => id === "first" ? new Promise<string>((resolve) => { resolveFirst = resolve; }) : Promise.resolve(id),
      (_id, value) => { drawn.push(value); }, () => { throw new Error("load failed"); }, () => dirty);
    const pending = reloader.reload("first");
    dirty = true;
    resolveFirst?.("first");
    await pending;
    expect(drawn).toEqual([]);
    dirty = false;
    const older = reloader.reload("first");
    await reloader.reload("second");
    resolveFirst?.("first");
    await older;
    expect(drawn).toEqual(["second"]);
  });
});
