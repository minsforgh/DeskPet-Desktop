import type { PackListItem, PackSaveResult } from "../main/pack-service.js";
import type { FieldError } from "../main/settings-service.js";

type PackActionResult = { ok: true; packId: string } | { ok: false; errors: FieldError[] };
type PackDeleteResult = { ok: true; deleted: boolean } | { ok: false; errors: FieldError[] };
type PackMetaResult = ({ ok: true } & PackSaveResult) | { ok: false; errors: FieldError[] };

export interface CharacterApi {
  packsList(): Promise<PackListItem[]>;
  packSelect(payload: { packId: string }): Promise<PackActionResult>;
  packDelete(payload: { packId: string }): Promise<PackDeleteResult>;
  packSaveMeta(payload: { packId: string; meta: { name: string; meta: Record<string, string> } }): Promise<PackMetaResult>;
}

export interface CharacterHooks {
  setDirty(dirty: boolean): void;
  showVoice(pack: PackListItem): Promise<void>;
  showInteractions(pack: PackListItem): Promise<void>;
  showBehavior(pack: PackListItem): Promise<void>;
  showSequences(pack: PackListItem): Promise<void>;
  showReactions(pack: PackListItem): Promise<void>;
  showMotions(pack: PackListItem): Promise<void>;
  showSheets(pack: PackListItem): Promise<void>;
  beforePackChange?(): Promise<boolean>;
  interactionsDirty(): boolean;
  discardInteractions(): void;
  sequencesDirty(): boolean;
  discardSequences(): void;
  reactionsDirty(): boolean;
  discardReactions(): void;
  motionsDirty(): boolean;
  discardMotions(): void;
  behaviorDirty(): boolean;
  discardBehavior(): void;
  confirmDiscard(): boolean;
}

const META_FIELDS = [["author", "제작자"], ["version", "버전"], ["license", "라이선스"], ["description", "설명"]] as const;
type Subtab = "voice" | "interactions" | "sequences" | "reactions" | "motions" | "behavior" | "sheets" | "info";

function make<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", content?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function action(doc: Document, id: string, label: string): HTMLButtonElement {
  const element = make(doc, "button", "", label);
  element.type = "button";
  element.id = id;
  return element;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing character panel element: ${selector}`);
  return found;
}

export function createCharacterPanel(doc: Document, root: HTMLElement, api: CharacterApi, hooks: CharacterHooks) {
  const list = required<HTMLElement>(root, "#pack-list");
  const header = required<HTMLElement>(root, "#pack-header");
  const status = required<HTMLElement>(root, "#pack-status");
  const tabs = {
    voice: required<HTMLButtonElement>(root, "#character-tab-voice"),
    interactions: required<HTMLButtonElement>(root, "#character-tab-interactions"),
    sequences: required<HTMLButtonElement>(root, "#character-tab-sequences"),
    reactions: required<HTMLButtonElement>(root, "#character-tab-reactions"),
    motions: required<HTMLButtonElement>(root, "#character-tab-motions"),
    behavior: required<HTMLButtonElement>(root, "#character-tab-behavior"),
    sheets: required<HTMLButtonElement>(root, "#character-tab-sheets"),
    info: required<HTMLButtonElement>(root, "#character-tab-info"),
  };
  const panels = {
    voice: required<HTMLElement>(root, "#voice"),
    interactions: required<HTMLElement>(root, "#interactions"),
    sequences: required<HTMLElement>(root, "#sequences"),
    reactions: required<HTMLElement>(root, "#reactions"),
    motions: required<HTMLElement>(root, "#motions"),
    behavior: required<HTMLElement>(root, "#behavior"),
    sheets: required<HTMLElement>(root, "#sheets"),
    info: required<HTMLElement>(root, "#pack-info"),
  };
  let items: PackListItem[] = [];
  let selectedId: string | undefined;
  let active: Subtab = "voice";
  let generation = 0;

  const selected = (): PackListItem | undefined => items.find(({ id }) => id === selectedId);
  const message = (value: string, error = false): void => {
    status.textContent = value;
    status.className = error ? "status error" : "status ok";
  };
  const errorText = (result: { errors: FieldError[] }): string => result.errors[0]?.message ?? "요청을 처리하지 못했어요";

  const showSubtab = async (): Promise<void> => {
    // The 애니메이션 tab exists only for a built-in pack edited in place (developer mode); main refuses the rest on its own.
    const sheetsAllowed = selected()?.directEdit === true;
    tabs.sheets.hidden = !sheetsAllowed;
    if (!sheetsAllowed && active === "sheets") active = "voice";
    for (const name of Object.keys(tabs) as Subtab[]) {
      tabs[name].setAttribute("aria-selected", String(name === active));
      panels[name].hidden = name !== active;
    }
    const pack = selected();
    if (!pack || !pack.valid) return;
    if (active === "voice") await hooks.showVoice(pack);
    if (active === "interactions") await hooks.showInteractions(pack);
    if (active === "sequences") await hooks.showSequences(pack);
    if (active === "reactions") await hooks.showReactions(pack);
    if (active === "motions") await hooks.showMotions(pack);
    if (active === "behavior") await hooks.showBehavior(pack);
    if (active === "sheets") await hooks.showSheets(pack);
  };

  const renderInfo = (pack: PackListItem): void => {
    hooks.setDirty(false);
    if (!pack.valid) {
      panels.info.replaceChildren(make(doc, "p", "status error", pack.error ?? "팩을 열 수 없어요"));
      return;
    }
    const form = make(doc, "form", "pack-info-form");
    form.noValidate = true;
    const values = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    for (const [key, title] of [["name", "이름"], ...META_FIELDS] as const) {
      const label = make(doc, "label", "pack-info-field");
      label.append(make(doc, "span", "field-title", title));
      let input: HTMLInputElement | HTMLTextAreaElement;
      if (key === "description") input = make(doc, "textarea");
      else { input = make(doc, "input"); input.type = "text"; }
      input.id = `pack-meta-${key}`;
      input.value = key === "name" ? pack.name : pack.meta?.[key] ?? "";
      label.append(input);
      form.append(label);
      values.set(key, input);
    }
    const note = make(doc, "span", "dirty-note");
    note.id = "pack-meta-dirty";
    const save = action(doc, "pack-meta-save", "저장");
    const actions = make(doc, "div", "actions");
    actions.append(save, note);
    form.append(actions);
    panels.info.replaceChildren(form);
    const snapshot = (): string => JSON.stringify(Array.from(values, ([key, input]) => [key, input.value]));
    let baseline = snapshot();
    const updateDirty = (): void => {
      const dirty = snapshot() !== baseline;
      note.textContent = dirty ? "저장하지 않은 변경이 있어요" : "";
      hooks.setDirty(dirty);
    };
    form.addEventListener("input", updateDirty);
    save.addEventListener("click", () => {
      void (async () => {
        const meta: Record<string, string> = {};
        for (const [key] of META_FIELDS) meta[key] = values.get(key)?.value ?? "";
        try {
          const result = await api.packSaveMeta({ packId: pack.id, meta: { name: values.get("name")?.value ?? "", meta } });
          if (!result.ok) { message(errorText(result), true); return; }
          baseline = snapshot();
          updateDirty();
          await refresh(result.packId);
          message(result.derived ? "내장 팩은 바꿀 수 없어 '(내 버전)' 으로 저장했어요" : "저장했어요");
        } catch { message("저장하지 못했어요", true); }
      })();
    });
  };

  const render = (): void => {
    list.replaceChildren(...items.map((pack) => {
      const entry = action(doc, "", "");
      entry.className = "pack-list-item";
      entry.title = pack.name;
      const name = make(doc, "span", "pack-name", pack.name);
      name.title = pack.name;
      entry.append(name);
      entry.dataset.packId = pack.id;
      entry.setAttribute("aria-selected", String(pack.id === selectedId));
      if (!pack.valid) entry.classList.add("pack-invalid");
      if (pack.current) { const mark = make(doc, "span", "pack-current", " ●"); mark.title = "사용 중"; entry.append(mark); }
      entry.append(make(doc, "span", "pack-source", pack.source === "builtin" ? "내장" : "내 팩"));
      if (!pack.valid) {
        const problem = pack.error ?? "팩을 열 수 없어요";
        const errorLine = make(doc, "span", "pack-error", problem);
        errorLine.title = problem;
        entry.append(errorLine);
      }
      entry.addEventListener("click", () => { void (async () => {
        if (pack.id === selectedId) return;
        if (hooks.interactionsDirty() && !hooks.confirmDiscard()) return;
        if (hooks.sequencesDirty() && !hooks.confirmDiscard()) return;
        if (hooks.reactionsDirty() && !hooks.confirmDiscard()) return;
        if (hooks.motionsDirty() && !hooks.confirmDiscard()) return;
        if (hooks.behaviorDirty() && !hooks.confirmDiscard()) return;
        if (hooks.beforePackChange && !await hooks.beforePackChange()) return;
        hooks.discardInteractions();
        hooks.discardSequences();
        hooks.discardReactions();
        hooks.discardMotions();
        hooks.discardBehavior();
        selectedId = pack.id; render(); await showSubtab();
      })(); });
      return entry;
    }));
    const pack = selected();
    if (!pack) { header.replaceChildren(make(doc, "p", "description", "캐릭터 팩이 없어요")); panels.info.replaceChildren(); return; }
    const title = make(doc, "h2", "pack-title", pack.name);
    title.title = pack.name;
    const description = make(doc, "p", "description", `id: ${pack.id} · ${pack.source === "builtin" ? "내장" : "내 팩"}`);
    const source = pack.extends ? items.find(({ id }) => id === pack.extends)?.name ?? pack.extends : undefined;
    const origin = source ? make(doc, "p", "description", `원본: ${source}`) : undefined;
    const use = action(doc, "pack-use", pack.current ? "사용 중" : "이 캐릭터 쓰기");
    use.disabled = pack.current || !pack.valid;
    use.addEventListener("click", () => { void usePack(pack.id); });
    const actions = make(doc, "div", "actions");
    if (pack.valid) actions.append(use);
    if (pack.source === "user") {
      const remove = action(doc, "pack-delete", "삭제");
      remove.addEventListener("click", () => { void deletePack(pack.id); });
      actions.append(remove);
    }
    const banner = pack.directEdit ? make(doc, "p", "pack-devmode", "개발자 모드: 원본 팩을 직접 고칩니다") : undefined;
    if (banner) banner.id = "pack-devmode-banner";
    header.replaceChildren(...(banner ? [banner] : []), title, description, ...(origin ? [origin] : []), actions);
    renderInfo(pack);
  };

  const refresh = async (preferredId?: string): Promise<void> => {
    const request = ++generation;
    const latest = await api.packsList();
    if (request !== generation) return;
    items = latest;
    selectedId = items.some(({ id }) => id === (preferredId ?? selectedId)) ? preferredId ?? selectedId
      : items.find(({ current }) => current)?.id ?? items[0]?.id;
    render();
    await showSubtab();
  };

  const usePack = async (id: string): Promise<void> => {
    try {
      if (hooks.beforePackChange && !await hooks.beforePackChange()) return;
      if (hooks.reactionsDirty() && !hooks.confirmDiscard()) return;
      if (hooks.motionsDirty() && !hooks.confirmDiscard()) return;
      const result = await api.packSelect({ packId: id });
      if (!result.ok) { message(errorText(result), true); return; }
      hooks.discardReactions();
      hooks.discardMotions();
      await refresh(id);
      message("캐릭터를 바꿨어요");
    } catch { message("캐릭터를 바꾸지 못했어요", true); }
  };

  const deletePack = async (id: string): Promise<void> => {
    try {
      if (hooks.reactionsDirty() && !hooks.confirmDiscard()) return;
      if (hooks.motionsDirty() && !hooks.confirmDiscard()) return;
      const result = await api.packDelete({ packId: id });
      if (!result.ok) { message(errorText(result), true); return; }
      if (!result.deleted) return;
      hooks.discardReactions();
      hooks.discardMotions();
      selectedId = undefined;
      await refresh();
      message("팩을 삭제했어요");
    } catch { message("팩을 삭제하지 못했어요", true); }
  };

  for (const name of Object.keys(tabs) as Subtab[]) tabs[name].addEventListener("click", () => {
    if (name === active) {
      if ((name === "interactions" && !hooks.interactionsDirty()) || (name === "sequences" && !hooks.sequencesDirty()) ||
          (name === "reactions" && !hooks.reactionsDirty()) || (name === "motions" && !hooks.motionsDirty())) void showSubtab();
      return;
    }
    if (active === "interactions" && hooks.interactionsDirty() && !hooks.confirmDiscard()) return;
    if (active === "sequences" && hooks.sequencesDirty() && !hooks.confirmDiscard()) return;
    if (active === "reactions" && hooks.reactionsDirty() && !hooks.confirmDiscard()) return;
    if (active === "motions" && hooks.motionsDirty() && !hooks.confirmDiscard()) return;
    if (active === "behavior" && hooks.behaviorDirty() && !hooks.confirmDiscard()) return;
    if (active === "interactions") hooks.discardInteractions();
    if (active === "sequences") hooks.discardSequences();
    if (active === "reactions") hooks.discardReactions();
    if (active === "motions") hooks.discardMotions();
    if (active === "behavior") hooks.discardBehavior();
    active = name; void showSubtab();
  });
  return { load: () => refresh(), refresh };
}
