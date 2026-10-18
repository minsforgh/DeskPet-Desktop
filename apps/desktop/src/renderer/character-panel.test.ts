import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PackListItem } from "../main/pack-service.js";
import { createCharacterPanel, type CharacterApi } from "./character-panel.js";

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  id = "";
  value = "";
  type = "";
  hidden = false;
  disabled = false;
  noValidate = false;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};
  private text = "";
  readonly classList = { add: (name: string) => { this.className = `${this.className} ${name}`.trim(); } };
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
  byId(id: string): FakeElement {
    const found = this.find((element) => element.id === id)[0];
    if (!found) throw new Error(`no #${id}`);
    return found;
  }
  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith("#")) throw new Error(`Unexpected selector: ${selector}`);
    return this.find((element) => element.id === selector.slice(1))[0] ?? null;
  }
}

const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
const ids = ["pack-list", "pack-header", "pack-status", "character-tab-voice", "character-tab-interactions", "character-tab-sequences", "character-tab-reactions", "character-tab-motions", "character-tab-behavior", "character-tab-sheets", "character-tab-info",
  "voice", "interactions", "sequences", "reactions", "motions", "behavior", "sheets", "pack-info"];
const baseItems = (): PackListItem[] => [
  { id: "placeholder", name: "Placeholder", source: "builtin", valid: true, current: true },
  { id: "wolf-maid", name: "늑대 메이드", source: "builtin", valid: true, current: false },
  { id: "mine", name: "내 캐릭터", source: "user", extends: "wolf-maid", valid: true, current: false,
    meta: { author: "작가", version: "1", license: "MIT", description: "소개" } },
  { id: "broken", name: "망가진 팩", source: "user", extends: "missing", valid: false, error: "원본 팩 없음", current: false },
];

function setup(initial?: PackListItem[]) {
  const root = new FakeElement("section");
  root.append(...ids.map((id) => { const child = new FakeElement("div"); child.id = id; return child; }));
  let items = initial ?? baseItems();
  const voices: string[] = [];
  const interactions: string[] = [];
  const dirty: boolean[] = [];
  const api: CharacterApi = {
    packsList: async () => items,
    packSelect: async ({ packId }) => {
      items = items.map((item) => ({ ...item, current: item.id === packId }));
      return { ok: true, packId };
    },
    packDelete: async () => ({ ok: true, deleted: true }),
    packSaveMeta: async ({ packId, meta }) => {
      items = [...items.map((item) => ({ ...item, current: false })),
        { id: `${packId}-mine`, name: meta.name, source: "user", extends: packId, valid: true, current: true, meta: meta.meta }];
      return { ok: true, packId: `${packId}-mine`, derived: true };
    },
  };
  const panel = createCharacterPanel(fakeDocument, root as unknown as HTMLElement, api, {
    setDirty: (value) => dirty.push(value),
    showVoice: async (pack) => { voices.push(pack.id); },
    showInteractions: async (pack) => { interactions.push(pack.id); },
    showBehavior: async () => {},
    showSequences: async () => {},
    showReactions: async () => {},
    showMotions: async () => {},
    showSheets: async () => {},
    sequencesDirty: () => false,
    discardSequences: () => {},
    reactionsDirty: () => false,
    discardReactions: () => {},
    motionsDirty: () => false,
    discardMotions: () => {},
    interactionsDirty: () => false,
    discardInteractions: () => {},
    behaviorDirty: () => false,
    discardBehavior: () => {},
    confirmDiscard: () => true,
  });
  return { root, panel, voices, interactions, dirty };
}

describe("character panel long strings and developer mode", () => {
  const long = `C:${"x".repeat(197)}`;
  it("keeps every pack string in text nodes that carry a tooltip and an overflow-safe class", async () => {
    const { root, panel } = setup([{ id: "mochi", name: long, source: "builtin", valid: false, error: long, current: true }]);
    await panel.load();
    const row = root.byId("pack-list").children[0];
    const name = row?.children.find((child) => child.className === "pack-name");
    const error = row?.children.find((child) => child.className === "pack-error");
    expect(name?.textContent).toBe(long);
    expect((name as unknown as { title: string }).title).toBe(long);
    expect((error as unknown as { title: string }).title).toBe(long);
    const title = root.byId("pack-header").children.find((child) => child.tag === "h2");
    expect(title?.className).toBe("pack-title");
    expect((title as unknown as { title: string }).title).toBe(long);
  });

  it("has CSS that clips names with an ellipsis and wraps errors and descriptions", () => {
    const css = readFileSync(new URL("./settings.css", import.meta.url), "utf8");
    const rule = (selector: string) => css.split(String.fromCharCode(10)).find((line) => line.startsWith(selector)) ?? "";
    expect(rule(".pack-name")).toContain("text-overflow: ellipsis");
    expect(rule(".pack-name")).toContain("white-space: nowrap");
    expect(rule(".pack-source, .pack-error")).toContain("overflow-wrap: anywhere");
    expect(rule(".pack-title")).toContain("text-overflow: ellipsis");
    expect(rule(".character-detail {")).toContain("overflow-wrap: anywhere");
    expect(rule("#pack-list")).toContain("overflow: auto");
    expect(rule(".pack-list-item")).toContain("overflow: hidden");
  });

  it("shows the developer-mode banner only for a directly edited built-in pack", async () => {
    const { root, panel } = setup([
      { id: "wolf-maid", name: "늑대 메이드", source: "builtin", valid: true, current: true, directEdit: true },
      { id: "mine", name: "내 팩", source: "user", valid: true, current: false }]);
    await panel.load();
    expect(root.byId("pack-header").textContent).toContain("개발자 모드: 원본 팩을 직접 고칩니다");
    root.byId("pack-list").children[1]?.click();
    await vi.waitFor(() => expect(root.byId("pack-header").textContent).toContain("내 팩"));
    expect(root.byId("pack-header").textContent).not.toContain("개발자 모드");
  });
});

describe("character panel", () => {
  it("shows built-in, user, invalid and current packs, and selecting a row only changes the detail", async () => {
    const { root, panel, voices } = setup();
    await panel.load();
    const rows = root.byId("pack-list").children;
    expect(rows.map((row) => row.textContent)).toEqual([
      "Placeholder ●내장", "늑대 메이드내장", "내 캐릭터내 팩", "망가진 팩내 팩원본 팩 없음",
    ]);
    expect(rows[3]?.className).toContain("pack-invalid");
    rows[1]?.click();
    await vi.waitFor(() => expect(voices.at(-1)).toBe("wolf-maid"));
    expect(root.byId("pack-header").textContent).toContain("늑대 메이드");
    expect(root.byId("pack-use").disabled).toBe(false);
    expect(rows[0]?.textContent).toContain("●");
  });

  it("switches subtabs and opens interactions for a pack that is not in use", async () => {
    const { root, panel, interactions } = setup();
    await panel.load();
    root.byId("pack-list").children[2]?.click();
    root.byId("character-tab-interactions").click();
    await vi.waitFor(() => expect(interactions).toEqual(["mine"]));
    root.byId("character-tab-info").click();
    expect(root.byId("pack-meta-author").value).toBe("작가");
    expect(root.byId("pack-meta-description").value).toBe("소개");
    expect(root.byId("pack-info").hidden).toBe(false);
    root.byId("character-tab-voice").click();
    expect(root.byId("voice").hidden).toBe(false);
  });

  it("saves built-in metadata as a derived pack and moves the selected id", async () => {
    const { root, panel, dirty } = setup();
    await panel.load();
    root.byId("pack-list").children[1]?.click();
    root.byId("character-tab-info").click();
    root.byId("pack-meta-name").value = "늑대 메이드 (내 버전)";
    root.byId("pack-info").children[0]?.dispatch("input");
    expect(root.byId("pack-meta-dirty").textContent).toBe("저장하지 않은 변경이 있어요");
    expect(dirty.at(-1)).toBe(true);
    root.byId("pack-meta-save").click();
    await vi.waitFor(() => expect(root.byId("pack-header").textContent).toContain("id: wolf-maid-mine"));
    expect(root.byId("pack-status").textContent).toContain("'(내 버전)' 으로 저장했어요");
    expect(root.byId("pack-list").children.at(-1)?.textContent).toContain(" ●내 팩");
    expect(dirty.at(-1)).toBe(false);
  });
});

describe("character panel 애니메이션 tab", () => {
  it("is shown only for a directly edited built-in pack and falls back to 어투 otherwise", async () => {
    const { root, panel } = setup([
      { id: "dev", name: "개발", source: "builtin", valid: true, current: true, directEdit: true },
      { id: "plain", name: "일반", source: "builtin", valid: true, current: false }]);
    await panel.load();
    expect(root.byId("character-tab-sheets").hidden).toBe(false);
    root.byId("character-tab-sheets").click();
    expect(root.byId("sheets").hidden).toBe(false);
    root.byId("pack-list").children[1]?.click();
    await vi.waitFor(() => expect(root.byId("character-tab-sheets").hidden).toBe(true));
    expect(root.byId("character-tab-voice").attributes["aria-selected"]).toBe("true");
    expect(root.byId("sheets").hidden).toBe(true);
  });
});
