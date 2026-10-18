import { describe, expect, it } from "vitest";
import type { VoiceView } from "../main/settings-service.js";
import type { LineVariant, VoiceTemplates } from "@deskpet/core";
import { KIND_LABELS, NO_TEMPLATE_TEXT, NO_VOICE_TEXT, UNUSABLE_TEXT, createVoiceLoadGate, renderPluginLinesPanel, renderVoicePanel, type VoiceApi } from "./voice-panel.js";

/** The few DOM members the panel touches; innerHTML and friends throw so any markup use fails the test. */
class FakeElement {
  children: FakeElement[] = [];
  className = "";
  id = "";
  value = "";
  type = "";
  maxLength = -1;
  disabled = false;
  hidden = false;
  open = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<() => void>> = {};
  private text = "";
  readonly classList = {
    remove: (...names: string[]) => { this.className = this.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
    add: (name: string) => { this.className = `${this.className} ${name}`.trim(); },
    toggle: (name: string, force: boolean) => { if (force) this.classList.add(name); else this.classList.remove(name); },
  };
  constructor(readonly tag: string) {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  get innerHTML(): string { throw new Error("innerHTML must not be read"); }
  set innerHTML(_value: string) { throw new Error("innerHTML must not be used"); }
  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  insertBefore(node: FakeElement, before: FakeElement | null): void {
    const at = before ? this.children.indexOf(before) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
  }
  replaceChildren(...nodes: FakeElement[]): void { this.text = ""; this.children = nodes; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(type: string, listener: () => void): void { (this.listeners[type] ??= []).push(listener); }
  click(): void { for (const listener of this.listeners.click ?? []) listener(); }
  dispatchEvent(event: Event): boolean { for (const listener of this.listeners[event.type] ?? []) listener(); return true; }
  focus(): void { this.dispatchEvent(new Event("focus")); }
  contains(target: FakeElement): boolean { return this.find((element) => element === target).length > 0; }
  matches(selector: string): boolean {
    if (selector === "details[open]") return this.tag === "details" && this.open;
    const [tag, name] = selector.split(".");
    return (tag === "" || this.tag === tag) && (!name || this.className.split(" ").includes(name));
  }
  querySelector<T>(selector: string): T | null { return (this.find((item) => item !== this && item.matches(selector))[0] ?? null) as T | null; }
  querySelectorAll<T>(selector: string): T[] { return this.find((item) => item !== this && item.matches(selector)) as T[]; }
  find(predicate: (element: FakeElement) => boolean): FakeElement[] {
    return [...(predicate(this) ? [this] : []), ...this.children.flatMap((child) => child.find(predicate))];
  }
  byId(id: string): FakeElement {
    const found = this.find((element) => element.id === id)[0];
    if (!found) throw new Error(`no #${id}`);
    return found;
  }
  byClass(name: string): FakeElement[] { return this.find((element) => element.className.split(" ").includes(name)); }
}
const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;

const kindOrder = ["done", "waiting", "failed", "info", "deadline", "reminder", "alert"] as const;
const view = (variants: Partial<Record<(typeof kindOrder)[number], string[]>>, problems: string[] = []): VoiceView => ({
  characterName: "늑대 메이드", problems, kinds: kindOrder.map((kind) => ({ kind, variants: variants[kind] ?? [] })),
});

describe("voice editor", () => {
  it("rejects a delayed response after a later load or a local edit", () => {
    let dirty = false;
    const gate = createVoiceLoadGate(() => dirty);
    const older = gate.begin();
    const latest = gate.begin();
    expect(gate.accepts(older)).toBe(false);
    dirty = true;
    expect(gate.accepts(latest)).toBe(false);
    dirty = false;
    expect(gate.accepts(latest)).toBe(true);
  });
  function editor(data = view({ done: ["{task} 끝", "{folder} 작업"] }), baseTemplates?: VoiceTemplates,
    templates?: VoiceTemplates) {
    const panel = new FakeElement("section");
    const dirty: boolean[] = [];
    const saves: unknown[] = [];
    const controller = renderVoicePanel(fakeDocument, panel as unknown as HTMLElement, data,
      { ...idleApi, packSaveVoice: async (payload) => { saves.push(payload); return { ok: true, packId: "wolf-maid-mine", derived: true, problems: [] }; } },
      "현재 캐릭터", { packId: "wolf-maid", templates, baseTemplates, setDirty: (value) => dirty.push(value),
        onSaved: async () => undefined, confirmDiscarded: () => true });
    if (!controller) throw new Error("editor missing");
    return { panel, controller, dirty, saves };
  }
  const row = (panel: FakeElement, kind: string, index: number): FakeElement => {
    const block = panel.byClass("voice-kind").find((item) => item.dataset.kind === kind);
    if (!block) throw new Error("kind missing");
    const found = block.byClass("voice-variant")[index];
    if (!found) throw new Error("row missing");
    return found;
  };
  const button = (parent: FakeElement, label: string): FakeElement => {
    const found = parent.find((item) => item.tag === "button" && item.textContent === label)[0];
    if (!found) throw new Error(`button ${label} missing`);
    return found;
  };
  const child = (parent: FakeElement, name: string): FakeElement => {
    const found = parent.byClass(name)[0];
    if (!found) throw new Error(`class ${name} missing`);
    return found;
  };
  it("shows seven sections, counts warnings, and edits, moves, adds and removes variants", () => {
    const { panel, controller } = editor(view({ done: ["{foo}", "둘"] }));
    const blocks = panel.byClass("voice-kind");
    expect(blocks).toHaveLength(7);
    expect(blocks[0]?.byClass("voice-kind-title")[0]?.textContent).toContain("완료 · 작업이 끝났을 때 · 2개 · ⚠ 1");
    expect(blocks[2]?.textContent).toContain("(원문 그대로)");
    const first = row(panel, "done", 0);
    child(first, "voice-variant-input").value = "수정";
    child(first, "voice-variant-input").dispatchEvent(new Event("input"));
    expect(first.byClass("voice-row-preview")[0]?.textContent).toBe("수정");
    button(first, "▼").click();
    expect(row(panel, "done", 0).byClass("voice-variant-input")[0]?.value).toBe("둘");
    for (let index = 0; index < 6; index += 1) button(child(panel, "voice-kind"), "+ 변형 추가").click();
    expect(panel.byClass("voice-kind")[0]?.byClass("voice-variant")).toHaveLength(8);
    expect(button(child(panel, "voice-kind"), "+ 변형 추가").disabled).toBe(true);
    button(row(panel, "done", 0), "삭제").click();
    expect(controller.dirty()).toBe(true);
  });
  it("keeps object variants, previews their lines, and restores object defaults", async () => {
    const parts = { prefix: "주인님,", content: "{task} 끝", suffix: "확인해 주세요" };
    const templates: VoiceTemplates = { done: [parts, "문장 {task}"] };
    const { panel, controller, saves } = editor(view({ done: ["주인님, {task} 끝 확인해 주세요", "문장 {task}"] }),
      templates, templates);
    expect(row(panel, "done", 0).byClass("voice-variant-mode")[0]?.value).toBe("parts");
    expect(row(panel, "done", 0).byClass("voice-row-preview")[0]?.textContent)
      .toBe("주인님,\n빌드 정리 끝\n확인해 주세요");
    const prefix = child(row(panel, "done", 0), "voice-prefix");
    prefix.value = "집사님,"; prefix.dispatchEvent(new Event("input"));
    expect(await controller.save()).toBe(true);
    expect(saves).toEqual([{ packId: "wolf-maid", voicePack: { version: 1, templates: { done: [
      { ...parts, prefix: "집사님," }, "문장 {task}",
    ] } } }]);
    button(child(panel, "voice-kind"), "기본값으로 되돌리기").click();
    expect(row(panel, "done", 0).byClass("voice-prefix")[0]?.value).toBe(parts.prefix);
    expect(await controller.save()).toBe(true);
    expect(saves[1]).toEqual({ packId: "wolf-maid", voicePack: { version: 1, templates } });
  });
  it("inserts a slot at the last focused cursor, previews samples and cancellation", () => {
    const { panel, controller } = editor(view({ done: ["{task} 끝"] }));
    const input = child(row(panel, "done", 0), "voice-variant-input");
    input.value = "앞 뒤"; input.selectionStart = input.selectionEnd = 2; input.focus();
    const insert = child(row(panel, "done", 0), "voice-slot-insert");
    insert.value = "result"; insert.dispatchEvent(new Event("change"));
    expect(input.value).toBe("앞 {result}뒤");
    expect(row(panel, "done", 0).byClass("voice-row-preview")[0]?.textContent).toBe("앞 테스트 통과뒤");
    panel.byId("voice-sample").value = "5"; panel.byId("voice-sample").dispatchEvent(new Event("change"));
    expect(row(panel, "done", 0).byClass("voice-row-preview")[0]?.textContent).toContain("건너뜀 (result 비어 있음)");
    expect(panel.byClass("voice-kind")[0]?.byClass("voice-fallback")[0]?.textContent)
      .toBe("이 샘플로는 원래 문구(text)가 그대로 나와요");
    button(panel, "취소").click();
    expect(controller.dirty()).toBe(false);
    expect(row(panel, "done", 0).byClass("voice-variant-input")[0]?.value).toBe("{task} 끝");
  });
  it("shows discarded and truncated previews and reset only for derived packs", () => {
    const plain = editor();
    expect(plain.panel.byClass("voice-reset")).toHaveLength(0);
    const { panel } = editor(view({ done: ["수정"] }), { done: ["원본"] });
    expect(panel.byClass("voice-reset")).toHaveLength(7);
    const input = child(row(panel, "done", 0), "voice-variant-input");
    input.value = "{wrong}"; input.dispatchEvent(new Event("input"));
    expect(row(panel, "done", 0).byClass("voice-row-preview")[0]?.textContent).toContain("⚠ 저장 때 버려져요");
    input.value = "가".repeat(121); input.dispatchEvent(new Event("input"));
    expect(row(panel, "done", 0).byClass("voice-row-preview")[0]?.textContent).toContain("(120자에서 잘림)");
    button(child(panel, "voice-kind"), "기본값으로 되돌리기").click();
    expect(row(panel, "done", 0).byClass("voice-variant-input")[0]?.value).toBe("원본");
  });
  it("sends the unsaved row template with the current sample values", async () => {
    const sent: unknown[] = [];
    const panel = new FakeElement("section");
    renderVoicePanel(fakeDocument, panel as unknown as HTMLElement, view({ done: ["원본"] }),
      { ...idleApi, voiceSend: async (payload) => { sent.push(payload); return { ok: true }; } }, "현재 캐릭터",
      { packId: "wolf-maid", setDirty: () => undefined, onSaved: async () => undefined, confirmDiscarded: () => true });
    const input = child(row(panel, "done", 0), "voice-variant-input");
    input.value = "새 문구 {task}"; input.dispatchEvent(new Event("input"));
    button(row(panel, "done", 0), "▶ 펫에게 보내기").click();
    await flush();
    expect(sent).toEqual([{ kind: "done", slots: { task: "빌드 정리", result: "테스트 통과", folder: "", message: "" },
      template: "새 문구 {task}" }]);
  });
  it("edits a disabled plugin, previews variables, saves only its override, and resets to pack text", async () => {
    const panel = new FakeElement("section");
    const saves: Record<string, LineVariant[]>[] = [];
    const lines = [{ id: "jungle.attendance-complete", label: "출석 완료", kind: "done" as const,
      variables: ["name"], variants: ["기본 {name}"] }];
    const controller = renderPluginLinesPanel(fakeDocument, panel as unknown as HTMLElement,
      { packId: "wolf-maid", catalogs: [{ pluginId: "jungle", catalog: { version: 1, lines } }],
        packLines: { "jungle.attendance-complete": ["팩 {name}"] }, overrides: {} },
      [{ id: "jungle", name: "Jungle", state: "disabled", statusLine: "꺼짐", notice: "" }],
      { lineOverridesSave: async ({ lines: saved }) => { saves.push(saved); return { ok: true }; },
        lineSend: async () => ({ ok: true }) }, () => undefined);
    expect(panel.byClass("plugin-lines-title")[0]?.textContent).toContain("Jungle · 1개 · 꺼짐");
    expect(panel.byClass("plugin-line-title")[0]?.textContent).toContain("팩 {name} · 캐릭터 팩");
    expect(panel.byClass("plugin-line-send-reason")[0]?.textContent).toContain("보낼 수 없어요");
    const input = panel.byClass("plugin-line-variant")[0]?.byClass("voice-variant-input")[0];
    if (!input) throw new Error("plugin line input missing");
    input.value = "수정 {name}"; input.dispatchEvent(new Event("input"));
    expect(panel.byClass("plugin-line-preview")[0]?.textContent).toBe("수정 예시");
    expect(controller.dirty()).toBe(true);
    expect(await controller.save()).toBe(true);
    expect(saves).toEqual([{ "jungle.attendance-complete": ["수정 {name}"] }]);
    expect(panel.byClass("plugin-line-title")[0]?.textContent).toContain("내 수정");
    const reset = panel.byClass("voice-reset")[0];
    if (!reset) throw new Error("reset missing");
    reset.click();
    expect(panel.byClass("plugin-line-variant")[0]?.byClass("voice-variant-input")[0]?.value).toBe("팩 {name}");
    expect(await controller.save()).toBe(true);
    expect(saves[1]).toEqual({});
  });
  it("searches plugin lines, steps through previews, and sends a running plugin line on the button", async () => {
    const panel = new FakeElement("section");
    const sent: unknown[] = [];
    renderPluginLinesPanel(fakeDocument, panel as unknown as HTMLElement,
      { packId: "wolf-maid", catalogs: [{ pluginId: "fixture", catalog: { version: 1, lines: [
        { id: "fixture.hello", label: "인사", kind: "info", variables: ["name"], variants: ["안녕 {name}", "반가워 {name}"] },
      ] } }], overrides: {} },
      [{ id: "fixture", name: "Fixture", state: "running", statusLine: "실행 중", notice: "" }],
      { lineOverridesSave: async () => ({ ok: true }), lineSend: async (payload) => { sent.push(payload); return { ok: true }; } },
      () => undefined);
    const row = panel.byClass("line-row")[0];
    if (!row) throw new Error("plugin row missing");
    expect(row.byClass("plugin-line-preview")[0]?.textContent).toBe("안녕 예시");
    button(row, "다음 변형").click();
    expect(row.byClass("plugin-line-preview")[0]?.textContent).toBe("반가워 예시");
    const sample = row.byClass("plugin-line-samples")[0]?.find((item) => item.tag === "input")[0];
    if (!sample) throw new Error("sample missing");
    sample.value = "친구"; sample.dispatchEvent(new Event("input"));
    button(row, "미리보기").click();
    expect(row.byClass("plugin-line-preview")[0]?.textContent).toBe("반가워 친구");
    button(row, "펫에게 보내기").click();
    await Promise.resolve();
    expect(sent).toEqual([{ lineId: "fixture.hello", vars: { name: "친구" }, previewText: "반가워 친구", variant: 1 }]);
    const search = panel.byClass("plugin-lines-search")[0];
    if (!search) throw new Error("search missing");
    search.value = "없음"; search.dispatchEvent(new Event("input"));
    expect(row.hidden).toBe(true);
    search.value = "인사"; search.dispatchEvent(new Event("input"));
    expect(row.hidden).toBe(false);
  });
  it("keeps structured line fields and converts format only when selected", async () => {
    const panel = new FakeElement("section");
    const parts = { prefix: "주인님,", content: "{name} 완료", suffix: "했어요" };
    const saved: Record<string, LineVariant[]>[] = [];
    const controller = renderPluginLinesPanel(fakeDocument, panel as unknown as HTMLElement,
      { packId: "wolf-maid", catalogs: [{ pluginId: "fixture", catalog: { version: 1, lines: [
        { id: "fixture.done", label: "완료", kind: "done", variables: ["name"], variants: [parts] },
      ] } }], overrides: { "fixture.done": [parts] } },
      [{ id: "fixture", name: "Fixture", state: "running", statusLine: "실행 중", notice: "" }],
      { lineOverridesSave: async ({ lines }) => { saved.push(lines); return { ok: true }; },
        lineSend: async () => ({ ok: true }) }, () => undefined);
    expect(panel.byClass("plugin-line-mode")[0]?.value).toBe("parts");
    expect(panel.byClass("plugin-line-fields")[0]?.byClass("voice-variant-input")).toHaveLength(3);
    const prefix = panel.byClass("plugin-line-prefix")[0];
    if (!prefix) throw new Error("prefix missing");
    prefix.value = "집사님,"; prefix.dispatchEvent(new Event("input"));
    expect(panel.byClass("plugin-line-preview")[0]?.textContent).toBe("집사님, 예시 완료 했어요");
    expect(await controller.save()).toBe(true);
    expect(saved).toEqual([{ "fixture.done": [{ ...parts, prefix: "집사님," }] }]);
    const mode = panel.byClass("plugin-line-mode")[0];
    if (!mode) throw new Error("mode missing");
    mode.value = "sentence"; mode.dispatchEvent(new Event("change"));
    expect(panel.byClass("plugin-line-fields")[0]?.byClass("voice-variant-input")).toHaveLength(1);
    expect(panel.byClass("plugin-line-conversion")[0]?.textContent).toContain("후: 집사님, {name} 완료 했어요");
    const sentenceMode = panel.byClass("plugin-line-mode")[0];
    if (!sentenceMode) throw new Error("mode missing");
    sentenceMode.value = "parts"; sentenceMode.dispatchEvent(new Event("change"));
    expect(panel.byClass("plugin-line-content")[0]?.value).toBe("집사님, {name} 완료 했어요");
  });
});
const idleApi: VoiceApi = {
  voicePreview: () => Promise.resolve({ ok: true, text: null, variantCount: 0 }),
  voiceSend: () => Promise.resolve({ ok: true }),
};
function draw(data: VoiceView, api: VoiceApi = idleApi): FakeElement {
  const panel = new FakeElement("section");
  renderVoicePanel(fakeDocument, panel as unknown as HTMLElement, data, api);
  return panel;
}
const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe("renderVoicePanel", () => {
  it("shows the character, all seven kinds with their labels and variants, and no problem box when there are none", () => {
    const panel = draw(view({ done: ["{task} 끝났어요", "{task} 마쳤어요"], waiting: ["확인해 주세요 {message}"] }));
    expect(panel.byId("voice-character").textContent).toBe("현재 캐릭터: 늑대 메이드");
    const blocks = panel.byClass("voice-kind");
    expect(blocks.map((block) => block.dataset.kind)).toEqual([...kindOrder]);
    for (const block of blocks) expect(block.textContent).toContain(KIND_LABELS[block.dataset.kind as (typeof kindOrder)[number]]);
    expect(blocks[0]?.byClass("voice-variant").map((item) => item.textContent)).toEqual(["{task} 끝났어요", "{task} 마쳤어요"]);
    expect(blocks[2]?.textContent).toContain(NO_TEMPLATE_TEXT);
    expect(panel.find((element) => element.id === "voice-problems")).toEqual([]);
    expect(panel.find((element) => element.id === "voice-empty")).toEqual([]);
  });

  it("explains that a character without templates uses the default sentences", () => {
    const panel = draw(view({}));
    expect(panel.byId("voice-empty").textContent).toBe(NO_VOICE_TEXT);
    expect(panel.byClass("voice-none")).toHaveLength(7);
  });

  it("lists the file's problems in an alert box", () => {
    const panel = draw(view({ done: ["x"] }, ["templates.done[1] uses unknown slot {foo}", "templates.party is not a known kind"]));
    const box = panel.byId("voice-problems");
    expect(box.attributes.role).toBe("alert");
    expect(box.byClass("voice-problem").map((item) => item.textContent))
      .toEqual(["templates.done[1] uses unknown slot {foo}", "templates.party is not a known kind"]);
  });

  it("puts markup from a pack into the page as plain text only", () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const data = { ...view({ done: [evil] }, [evil]), characterName: evil };
    const panel = draw(data);
    expect(panel.byId("voice-character").textContent).toBe(`현재 캐릭터: ${evil}`);
    expect(panel.byClass("voice-variant")[0]?.textContent).toBe(evil);
    expect(panel.byClass("voice-problem")[0]?.textContent).toBe(evil);
    expect(panel.find((element) => element.tag === "img" || element.tag === "script")).toEqual([]);
  });

  it("offers the kind choice and four slot inputs limited to 500 characters", () => {
    const panel = draw(view({}));
    expect(panel.byId("voice-kind").children.map((option) => option.value)).toEqual([...kindOrder]);
    for (const name of ["task", "result", "folder", "message"]) expect(panel.byId(`voice-slot-${name}`).maxLength).toBe(500);
  });

  it("previews with the typed slots, steps through variants, and shows the fallback note without a result", async () => {
    const calls: unknown[] = [];
    const api: VoiceApi = {
      ...idleApi,
      voicePreview: (payload) => { calls.push(payload); return Promise.resolve({ ok: true, text: payload.variant === 0 ? "빌드 끝났어요" : null, variantCount: 2 }); },
    };
    const panel = draw(view({ done: ["a", "b"] }), api);
    panel.byId("voice-kind").value = "done";
    panel.byId("voice-slot-task").value = "빌드";
    panel.byId("voice-preview").click();
    await flush();
    expect(calls[0]).toEqual({ kind: "done", slots: { task: "빌드" }, variant: 0 });
    expect(panel.byId("voice-result").textContent).toBe("빌드 끝났어요");
    expect(panel.byId("voice-variant-info").textContent).toBe("변형 1/2부터 시도");
    panel.byId("voice-next").click();
    await flush();
    expect(calls[1]).toEqual({ kind: "done", slots: { task: "빌드" }, variant: 1 });
    expect(panel.byId("voice-result").textContent).toBe(UNUSABLE_TEXT);
  });

  it("sends only when the send button is pressed and reports the outcome", async () => {
    const sent: unknown[] = [];
    let answer: Awaited<ReturnType<VoiceApi["voiceSend"]>> = { ok: true };
    const api: VoiceApi = { ...idleApi, voiceSend: (payload) => { sent.push(payload); return Promise.resolve(answer); } };
    const panel = draw(view({ done: ["a"] }), api);
    await flush();
    expect(sent).toEqual([]);
    panel.byId("voice-kind").value = "done";
    panel.byId("voice-slot-message").value = "안녕";
    panel.byId("voice-send").click();
    await flush();
    expect(sent).toEqual([{ kind: "done", slots: { message: "안녕" } }]);
    expect(panel.byId("voice-status").textContent).toBe("펫에게 보냈어요");
    answer = { ok: false, message: "너무 빨라요" };
    panel.byId("voice-send").click();
    await flush();
    expect(panel.byId("voice-status").textContent).toBe("너무 빨라요");
  });
});
