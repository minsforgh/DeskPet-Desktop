import type { LineCatalog, ReactionTarget, Reactions, VoiceKind } from "@deskpet/core";
import type { PluginSettingsEntry } from "../main/plugin-host-app.js";
import type { PackSaveResult, StatePreviewData } from "../main/pack-service.js";
import type { FieldError, VoiceSendResult } from "../main/settings-service.js";
import { createAnimationPreview, type AnimationPreview } from "./anim-preview.js";
import { EDITOR_LABELS } from "./voice-panel.js";

const KINDS: readonly VoiceKind[] = ["done", "waiting", "failed", "info", "deadline", "reminder", "alert"];
export interface ReactionsView {
  reactions: Reactions;
  problems: string[];
  plays: Record<string, { resolved: string; cycleMs: number }>;
  sequences: Array<{ id: string; label?: string; firstPlay?: string }>;
}
export interface ReactionsApi {
  reactionsSave(payload: { packId: string; reactions: { version: 1; kinds: Reactions["kinds"] } }): Promise<
    ({ ok: true } & PackSaveResult) | { ok: false; errors: FieldError[] }>;
  voiceSend(payload: { kind: VoiceKind; slots: Record<string, string> }): Promise<VoiceSendResult>;
  lineSend(payload: { lineId: string; vars?: Record<string, string>; previewText?: string }): Promise<VoiceSendResult>;
  statePreview?(payload: { packId: string; state: string }): Promise<StatePreviewData>;
}
export interface ReactionsHooks {
  setDirty(dirty: boolean): void;
  saved(result: PackSaveResult): Promise<void>;
}
export interface LineReactionsInput {
  catalogs: Array<{ pluginId: string; catalog: LineCatalog }>;
  plugins: readonly PluginSettingsEntry[];
  /** Saved per-line choices of the current pack; the pack's own `lines` come from the reactions view. */
  reactions: Record<string, ReactionTarget>;
  lineReactionsSave(payload: { lines: Record<string, ReactionTarget> }): Promise<{ ok: true } | { ok: false; errors: Array<{ message: string }> }>;
}
export interface ReactionsController { dirty(): boolean; discard(): void }

function make<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const targetText = (view: ReactionsView, target: ReactionTarget): string => target.sequence !== undefined
  ? `시퀀스 ${view.sequences.find(({ id }) => id === target.sequence)?.label ?? target.sequence}` : `상태 ${target.play ?? ""}`;

/** Per-line choices: none, a state or a sequence, saved to the current pack's settings instead of the pack file. */
function renderLineReactions(doc: Document, view: ReactionsView, input: LineReactionsInput, api: ReactionsApi,
  kinds: () => Reactions["kinds"], onDirty: () => void): { element: HTMLElement; dirty(): boolean } {
  const original: Record<string, ReactionTarget> = structuredClone(input.reactions);
  const known = input.catalogs.flatMap(({ catalog }) => catalog.lines.map(({ id }) => id));
  const rows = new Map<string, { play: HTMLSelectElement; sequence: HTMLSelectElement; warning: HTMLElement; source: HTMLElement }>();
  const root = make(doc, "section", "line-reactions");
  root.id = "line-reactions";
  root.append(make(doc, "h3", "", "대사별 반응"));
  root.append(make(doc, "p", "description", "지정하지 않은 대사는 알림 종류별 반응, 플러그인 규칙, 기분 순서로 따라가요."));
  const note = make(doc, "span", "dirty-note");
  note.id = "line-reactions-dirty";
  const status = make(doc, "span", "status");
  status.id = "line-reactions-status";
  status.setAttribute("role", "status");
  const targetOf = (id: string): ReactionTarget | undefined => {
    const row = rows.get(id);
    if (!row) return undefined;
    return row.play.value ? { play: row.play.value } : row.sequence.value ? { sequence: row.sequence.value } : undefined;
  };
  const read = (): Record<string, ReactionTarget> => Object.fromEntries(known.flatMap((id) => {
    const target = targetOf(id);
    return target ? [[id, target]] : [];
  }));
  const snapshot = (value: Record<string, ReactionTarget>): string => JSON.stringify(known.map((id) => value[id] ?? null));
  const dirty = (): boolean => snapshot(read()) !== snapshot(original);
  const save = make(doc, "button", "", "저장");
  save.type = "button";
  save.id = "line-reactions-save";
  const updateDirty = (): void => {
    const count = known.filter((id) => JSON.stringify(targetOf(id) ?? null) !== JSON.stringify(original[id] ?? null)).length;
    note.textContent = count ? `저장하지 않은 변경이 있어요 (${count})` : "";
    save.disabled = count === 0;
    onDirty();
  };
  /** What an event for this line plays right now, and which layer decides it. */
  const applied = (id: string, kind: VoiceKind): string => {
    const own = original[id];
    if (own) return `${targetText(view, own)} · 내 지정`;
    const pack = view.reactions.lines?.[id];
    if (pack) return `${targetText(view, pack)} · 캐릭터 팩 대사`;
    const byKind = kinds()[kind];
    if (byKind) return `${targetText(view, byKind)} · 종류별 (${EDITOR_LABELS[kind][0]})`;
    return "플러그인 규칙·기분에 따라 · 자동";
  };
  const refreshRow = (id: string, kind: VoiceKind): void => {
    const row = rows.get(id);
    if (!row) return;
    const selected = row.play.value || view.sequences.find((item) => item.id === row.sequence.value)?.firstPlay;
    const resolved = selected ? view.plays[selected]?.resolved : undefined;
    row.warning.textContent = row.sequence.value && !view.sequences.some(({ id: sid }) => sid === row.sequence.value)
      ? "없는 시퀀스예요" : row.play.value && !view.plays[row.play.value] ? "없는 상태예요"
        : resolved === "idle" ? "idle로 떨어지는 동작이에요" : "";
    row.source.textContent = `지금: ${applied(id, kind)}`;
  };
  for (const plugin of input.plugins) {
    const catalog = input.catalogs.find(({ pluginId }) => pluginId === plugin.id)?.catalog;
    if (!catalog) continue;
    const section = make(doc, "details", "line-reactions-plugin");
    section.dataset.linesPlugin = plugin.id;
    section.append(make(doc, "summary", "line-reactions-title", `${plugin.name} · ${catalog.lines.length}개${plugin.state === "running" ? "" : " · 꺼짐"}`));
    for (const line of catalog.lines) {
      const row = make(doc, "div", "row line-reaction-row");
      row.dataset.lineId = line.id;
      const title = make(doc, "div", "reactions-title");
      const source = make(doc, "span", "description line-reaction-source");
      title.append(make(doc, "strong", "", line.label), source);
      const target = original[line.id];
      const playLabel = make(doc, "label", "prop", "재생 동작");
      const play = make(doc, "select");
      play.setAttribute("aria-label", `${line.label} 재생 동작`);
      play.append(new Option("없음", ""));
      for (const name of Object.keys(view.plays)) play.append(new Option(name, name));
      if (target?.play && !view.plays[target.play]) play.append(new Option(`${target.play} (없음)`, target.play));
      play.value = target?.play ?? "";
      playLabel.append(play);
      const sequenceLabel = make(doc, "label", "prop", "동작(시퀀스)");
      const sequence = make(doc, "select");
      sequence.setAttribute("aria-label", `${line.label} 동작(시퀀스)`);
      sequence.append(new Option("없음", ""));
      for (const item of view.sequences) sequence.append(new Option(item.label ? `${item.label} (${item.id})` : item.id, item.id));
      if (target?.sequence && !view.sequences.some(({ id }) => id === target.sequence))
        sequence.append(new Option(`${target.sequence} (없음)`, target.sequence));
      sequence.value = target?.sequence ?? "";
      sequenceLabel.append(sequence);
      const warning = make(doc, "span", "field-error");
      const send = make(doc, "button", "line-reaction-send", "▶ 보내 보기");
      send.type = "button";
      const pluginRunning = plugin.state === "running";
      send.disabled = !pluginRunning;
      if (!pluginRunning) send.title = `${plugin.name}: 지금은 켜져 있지 않아 보낼 수 없어요`;
      send.addEventListener("click", () => { void (async () => {
        const result = await api.lineSend({ lineId: line.id });
        status.textContent = result.ok ? "펫에게 보냈어요" : result.message;
        status.className = result.ok ? "status ok" : "status error";
      })(); });
      const reset = make(doc, "button", "line-reaction-reset", "기본값으로 되돌리기");
      reset.type = "button";
      reset.addEventListener("click", () => { play.value = ""; sequence.value = ""; refreshRow(line.id, line.kind); updateDirty(); });
      play.addEventListener("change", () => { if (play.value) sequence.value = ""; refreshRow(line.id, line.kind); updateDirty(); });
      sequence.addEventListener("change", () => { if (sequence.value) play.value = ""; refreshRow(line.id, line.kind); updateDirty(); });
      row.append(title, playLabel, sequenceLabel, warning, send, reset);
      section.append(row);
      rows.set(line.id, { play, sequence, warning, source });
      refreshRow(line.id, line.kind);
    }
    root.append(section);
  }
  if (rows.size === 0) root.append(make(doc, "p", "muted", "대사를 제공하는 플러그인이 없어요"));
  save.addEventListener("click", () => { void (async () => {
    save.disabled = true;
    try {
      const lines = read();
      const result = await input.lineReactionsSave({ lines });
      if (!result.ok) { status.textContent = result.errors[0]?.message ?? "저장하지 못했어요"; status.className = "status error"; return; }
      for (const id of known) { const target = lines[id]; if (target) original[id] = target; else Reflect.deleteProperty(original, id); }
      for (const { catalog } of input.catalogs) for (const line of catalog.lines) refreshRow(line.id, line.kind);
      status.textContent = "저장했어요";
      status.className = "status ok";
    } catch { status.textContent = "저장하지 못했어요"; status.className = "status error"; }
    finally { updateDirty(); }
  })(); });
  const actions = make(doc, "div", "actions");
  actions.append(save, note, status);
  root.append(actions);
  updateDirty();
  return { element: root, dirty };
}

export function renderReactionsPanel(doc: Document, panel: HTMLElement, view: ReactionsView, packId: string,
  api: ReactionsApi, hooks: ReactionsHooks, lines?: LineReactionsInput): ReactionsController {
  const rows = new Map<VoiceKind, { play: HTMLSelectElement; sequence: HTMLSelectElement; warning: HTMLElement;
    preview: HTMLElement; send: HTMLButtonElement; animation?: AnimationPreview }>();
  const root = make(doc, "div", "reactions-editor");
  root.append(make(doc, "h2", "", "알림 반응"));
  root.append(make(doc, "p", "description", "알림 종류마다 재생할 상태나 동작을 고르세요."));
  if (view.problems.length) {
    const problems = make(doc, "ul", "voice-problems");
    for (const problem of view.problems) {
      const kind = KINDS.find((candidate) => problem.startsWith(`reactions ${candidate} references missing sequence `));
      problems.append(make(doc, "li", "", kind
        ? `${EDITOR_LABELS[kind][0]}: 없는 시퀀스를 가리켜 매핑을 사용하지 않아요`
        : "알림 반응 파일의 일부 항목을 사용할 수 없어요"));
    }
    root.append(problems);
  }
  const baseline = JSON.stringify(view.reactions.kinds);
  let saved = baseline;
  let abandoned = false;
  const note = make(doc, "span", "dirty-note");
  const status = make(doc, "span", "status");
  status.id = "rx-status";
  status.setAttribute("role", "status");
  const read = (): Reactions["kinds"] => {
    const kinds: Reactions["kinds"] = {};
    for (const [kind, row] of rows) {
      if (row.play.value) kinds[kind] = { play: row.play.value };
      else if (row.sequence.value) kinds[kind] = { sequence: row.sequence.value };
    }
    return kinds;
  };
  const changed = (): boolean => JSON.stringify(read()) !== saved;
  const updateDirty = (): void => {
    const dirty = changed();
    note.textContent = dirty ? "저장하지 않은 변경이 있어요" : "";
    for (const row of rows.values()) {
      row.send.disabled = dirty;
      row.send.title = dirty ? "저장한 뒤 실제 반응을 볼 수 있어요" : "";
    }
    hooks.setDirty(dirty || lineSection?.dirty() === true);
  };
  let lineSection: ReturnType<typeof renderLineReactions> | undefined;
  for (const kind of KINDS) {
    const target = view.reactions.kinds[kind];
    const row = make(doc, "div", "row reactions-row");
    row.dataset.kind = kind;
    const title = make(doc, "div", "reactions-title");
    title.append(make(doc, "strong", "", EDITOR_LABELS[kind][0]), make(doc, "span", "description", EDITOR_LABELS[kind][1]));
    const playLabel = make(doc, "label", "prop", "재생 동작");
    const play = make(doc, "select");
    play.setAttribute("aria-label", `${EDITOR_LABELS[kind][0]} 재생 동작`);
    play.append(new Option("없음", ""));
    for (const name of Object.keys(view.plays)) play.append(new Option(name, name));
    if (target?.play && !view.plays[target.play]) play.append(new Option(`${target.play} (없음)`, target.play));
    play.value = target?.play ?? "";
    playLabel.append(play);
    const sequenceLabel = make(doc, "label", "prop", "동작(시퀀스)");
    const sequence = make(doc, "select");
    sequence.setAttribute("aria-label", `${EDITOR_LABELS[kind][0]} 동작(시퀀스)`);
    sequence.append(new Option("없음", ""));
    for (const item of view.sequences) sequence.append(new Option(item.label ? `${item.label} (${item.id})` : item.id, item.id));
    if (target?.sequence && !view.sequences.some(({ id }) => id === target.sequence))
      sequence.append(new Option(`${target.sequence} (없음)`, target.sequence));
    sequence.value = target?.sequence ?? "";
    sequenceLabel.append(sequence);
    const warning = make(doc, "span", "field-error");
    const preview = make(doc, "div", "reactions-preview");
    const send = make(doc, "button", "", "▶ 펫에게 보내기");
    send.type = "button";
    send.addEventListener("click", () => { void (async () => {
      const result = await api.voiceSend({ kind, slots: { task: "작업", result: "완료", message: "알림", folder: "폴더" } });
      status.textContent = result.ok ? "펫에게 보냈어요" : result.message;
      status.className = result.ok ? "status ok" : "status error";
    })(); });
    row.append(title, playLabel, sequenceLabel, warning, send, preview);
    root.append(row);
    rows.set(kind, { play, sequence, warning, preview, send });
  }
  const refresh = (kind: VoiceKind): void => {
    const row = rows.get(kind);
    if (!row) return;
    row.animation?.stop();
    row.animation = undefined;
    row.preview.replaceChildren();
    const selected = row.play.value || view.sequences.find(({ id }) => id === row.sequence.value)?.firstPlay;
    const resolved = selected ? view.plays[selected]?.resolved : undefined;
    row.warning.textContent = row.sequence.value && !view.sequences.some(({ id }) => id === row.sequence.value)
      ? "없는 시퀀스예요" : row.play.value && !view.plays[row.play.value] ? "없는 상태예요"
        : resolved === "idle" ? "idle로 떨어지는 동작이에요" : "";
    if (!resolved || resolved === "idle" || !api.statePreview) return;
    void api.statePreview({ packId, state: resolved }).then((data) => {
      if (abandoned || !row.preview.isConnected || (row.play.value || view.sequences.find(({ id }) => id === row.sequence.value)?.firstPlay) !== selected) return;
      row.animation = createAnimationPreview(doc, data);
      row.preview.replaceChildren(row.animation.element);
    }).catch(() => { row.preview.textContent = "미리보기를 불러오지 못했어요"; });
  };
  for (const [kind, row] of rows) {
    row.play.addEventListener("change", () => { if (row.play.value) row.sequence.value = ""; refresh(kind); updateDirty(); });
    row.sequence.addEventListener("change", () => { if (row.sequence.value) row.play.value = ""; refresh(kind); updateDirty(); });
    refresh(kind);
  }
  const save = make(doc, "button", "", "저장");
  save.type = "button";
  save.id = "rx-save";
  save.addEventListener("click", () => { void (async () => {
    save.disabled = true;
    try {
      const result = await api.reactionsSave({ packId, reactions: { version: 1, kinds: read() } });
      if (!result.ok) { status.textContent = result.errors[0]?.message ?? "저장하지 못했어요"; status.className = "status error"; return; }
      saved = JSON.stringify(read());
      updateDirty();
      await hooks.saved(result);
      status.textContent = "저장했어요";
      status.className = "status ok";
    } catch { status.textContent = "저장하지 못했어요"; status.className = "status error"; }
    finally { save.disabled = false; }
  })(); });
  const actions = make(doc, "div", "actions");
  actions.append(save, note, status);
  root.append(actions);
  if (lines) {
    lineSection = renderLineReactions(doc, view, lines, api, () => JSON.parse(saved) as Reactions["kinds"], updateDirty);
    root.append(lineSection.element);
  }
  panel.replaceChildren(root);
  updateDirty();
  return { dirty: () => changed() || lineSection?.dirty() === true, discard: () => { abandoned = true; for (const row of rows.values()) row.animation?.stop(); hooks.setDirty(false); } };
}
