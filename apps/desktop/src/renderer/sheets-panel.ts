import type { PackListItem } from "../main/pack-service.js";
import type { StatePreviewData } from "../main/pack-service.js";
import { createAnimationPreview, type AnimationPreview } from "./anim-preview.js";

/** Developer mode only: replace a state's sheet or add a state to a built-in pack (ADR-0008 7-3, 7-6). */
export interface SheetsApi {
  sheetPick(payload: { packId: string; frames: number }): Promise<unknown>;
  sheetApply(payload: Record<string, unknown>): Promise<unknown>;
  statePreview?(payload: { packId: string; state: string }): Promise<StatePreviewData>;
}
export interface SheetsHooks {
  /** Called after a successful apply; the caller reloads the pack list and draws this panel again with the notice. */
  applied(packId: string, notice: string): Promise<void>;
}

interface FootIssue { frame: number; reason: string; measured?: number | string; expected?: number | string }
interface FootCheck { skipped: boolean; issueFrames: number; issues: FootIssue[] }
interface Picked { token: string; preview: string; footCheck: FootCheck }

export const STATE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
export const STATE_NAME_HINT = "영문 소문자로 시작, 소문자·숫자·-만, 32자 이하 (^[a-z][a-z0-9-]{0,31}$)";
const MAX_STATES = 32;
const REASONS: Record<string, string> = {
  "empty frame": "몸 픽셀이 없는 빈 프레임",
  "foot y exceeds tolerance": "발 높이가 기준에서 벗어남",
  "foot x exceeds tolerance": "발 좌우 위치가 기준에서 벗어남",
};

function make<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = "", content?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function button(doc: Document, id: string, label: string): HTMLButtonElement {
  const element = make(doc, "button", "", label);
  element.type = "button";
  if (id) element.id = id;
  return element;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseFootCheck(value: unknown): FootCheck | undefined {
  if (!record(value) || typeof value.skipped !== "boolean" || typeof value.issueFrames !== "number" || !Array.isArray(value.issues)) return undefined;
  const issues: FootIssue[] = [];
  for (const item of value.issues) {
    if (!record(item) || typeof item.frame !== "number" || typeof item.reason !== "string") return undefined;
    const measured = typeof item.measured === "string" || typeof item.measured === "number" ? item.measured : undefined;
    const expected = typeof item.expected === "string" || typeof item.expected === "number" ? item.expected : undefined;
    issues.push({ frame: item.frame, reason: item.reason, ...(measured === undefined ? {} : { measured }), ...(expected === undefined ? {} : { expected }) });
  }
  return { skipped: value.skipped, issueFrames: value.issueFrames, issues };
}

/** The shape main answers a pick with; anything else (or a non-PNG preview) is treated as a failed pick. */
export function parsePick(value: unknown): Picked | "canceled" | undefined {
  if (!record(value)) return undefined;
  if (value.canceled === true) return "canceled";
  const footCheck = parseFootCheck(value.footCheck);
  if (typeof value.token !== "string" || typeof value.preview !== "string" || !value.preview.startsWith("data:image/png;base64,") || !footCheck)
    return undefined;
  return { token: value.token, preview: value.preview, footCheck };
}

export function issueText(issue: FootIssue): string {
  const parts = [`${issue.frame}번 프레임: ${REASONS[issue.reason] ?? issue.reason}`];
  if (issue.measured !== undefined) parts.push(`측정 ${issue.measured}`);
  if (issue.expected !== undefined) parts.push(`기대 ${issue.expected}`);
  return parts.join(" · ");
}

/** IPC rejections read "Error invoking remote method '…': Error: <message>"; only the message is for the user. */
export function failureText(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const message = raw.slice(raw.lastIndexOf("Error: ") >= 0 ? raw.lastIndexOf("Error: ") + 7 : 0).trim();
  return message && message.length <= 200 ? message : "처리하지 못했어요";
}

export function renderSheetsPanel(doc: Document, root: HTMLElement, pack: PackListItem, api: SheetsApi, hooks: SheetsHooks, notice = ""): void {
  const previews: AnimationPreview[] = [];
  const stopPreviews = (): void => { for (const preview of previews) preview.stop(); previews.length = 0; };
  stopPreviews();
  const states = pack.states ?? {};
  const names = Object.keys(states);
  const intro = make(doc, "p", "description", "개발자 모드: 고른 PNG 를 이 팩의 characters 폴더에 직접 씁니다. git 으로 되돌릴 수 있어요");
  const listing = make(doc, "ul", "sheet-states");
  listing.id = "sh-states";
  const form = make(doc, "div", "sheet-form");
  form.id = "sh-form";
  const status = make(doc, "p", notice ? "status ok" : "status", notice);
  status.id = "sh-status";
  status.setAttribute("role", "status");
  const add = button(doc, "sh-add", "새 상태 추가");
  add.disabled = names.length >= MAX_STATES;
  const actions = make(doc, "div", "actions");
  actions.append(add);
  root.replaceChildren(intro, listing, actions, form, status);

  const say = (text: string, error = false): void => { status.textContent = text; status.className = error ? "status error" : "status ok"; };

  for (const name of names) {
    const state = states[name];
    if (!state) continue;
    const row = make(doc, "li", "sheet-state");
    row.dataset.state = name;
    const detail = `${state.frames}프레임 · ${state.fps}fps · ${state.loop ? "반복" : "한 번"}`;
    const replace = button(doc, "", "시트 교체");
    replace.className = "sh-replace";
    replace.addEventListener("click", () => { openForm(name); });
    row.append(make(doc, "span", "sheet-name", name), make(doc, "span", "sheet-detail", detail), replace);
    if (api.statePreview) void api.statePreview({ packId: pack.id, state: name }).then((data) => {
      if (!row.isConnected) return;
      const preview = createAnimationPreview(doc, data);
      previews.push(preview);
      row.append(preview.element);
    }).catch(() => { if (row.isConnected) row.append(make(doc, "span", "status error", "미리보기를 불러오지 못했어요")); });
    listing.append(row);
  }
  add.addEventListener("click", () => { openForm(undefined); });

  function openForm(replacing: string | undefined): void {
    stopPreviews();
    const current = replacing === undefined ? undefined : states[replacing];
    let picked: Picked | undefined;
    let override = false;

    const field = (title: string, input: HTMLElement): HTMLElement => {
      const label = make(doc, "label", "pack-info-field");
      label.append(make(doc, "span", "field-title", title), input);
      return label;
    };
    const input = (id: string, value: string, type = "text"): HTMLInputElement => {
      const element = make(doc, "input");
      element.id = id;
      element.type = type;
      element.value = value;
      return element;
    };
    const heading = make(doc, "h3", "sheet-heading", replacing === undefined ? "새 상태 추가" : `${replacing} 시트 교체`);
    const name = input("sh-name", "");
    const nameHint = make(doc, "p", "description", `이름 규칙: ${STATE_NAME_HINT}`);
    const frames = input("sh-frames", String(current?.frames ?? 8), "number");
    const fps = input("sh-fps", String(current?.fps ?? 8), "number");
    const loop = input("sh-loop", "", "checkbox");
    loop.checked = current?.loop ?? true;
    const next = input("sh-next", current?.next ?? "");
    const facing = make(doc, "select");
    facing.id = "sh-facing";
    for (const [value, label] of [["", "지정 안 함"], ["left", "왼쪽"], ["right", "오른쪽"]] as const) {
      const option = make(doc, "option", "", label);
      option.value = value;
      facing.append(option);
    }
    facing.value = current?.facing ?? "";
    const pick = button(doc, "sh-pick", "파일 고르기");
    const previewBox = make(doc, "div", "sheet-preview-box");
    const summary = make(doc, "p", "sheet-foot-summary");
    summary.id = "sh-foot-summary";
    const issuesList = make(doc, "ul", "sheet-foot-issues");
    issuesList.id = "sh-foot-issues";
    const overrideButton = button(doc, "sh-override", "그래도 사용");
    overrideButton.hidden = true;
    overrideButton.setAttribute("aria-pressed", "false");
    const apply = button(doc, "sh-apply", replacing === undefined ? "추가" : "교체");
    apply.disabled = true;
    const cancel = button(doc, "sh-cancel", "닫기");

    const sync = (): void => {
      const issues = (picked?.footCheck.issueFrames ?? 0) > 0;
      overrideButton.hidden = !issues;
      overrideButton.setAttribute("aria-pressed", String(override));
      overrideButton.textContent = override ? "그래도 사용 (선택됨)" : "그래도 사용";
      apply.disabled = !picked || (issues && !override);
    };
    const reset = (): void => {
      picked = undefined;
      override = false;
      previewBox.replaceChildren();
      summary.textContent = "";
      issuesList.replaceChildren();
      sync();
    };
    const showPick = (result: Picked): void => {
      for (const preview of previews) if (preview.element.parentElement === previewBox) preview.stop();
      const count = Number(frames.value);
      const rate = Number(fps.value);
      if (Number.isInteger(count) && count > 0 && Number.isFinite(rate) && rate > 0 && pack.cellSize) {
        const preview = createAnimationPreview(doc, { sheet: result.preview, frames: count, fps: rate,
          loop: loop.checked, cellSize: pack.cellSize });
        preview.element.id = "sh-preview";
        previews.push(preview);
        previewBox.replaceChildren(preview.element);
      } else {
        const image = make(doc, "img", "sheet-preview");
        image.id = "sh-preview";
        image.alt = "고른 시트 미리보기";
        image.src = result.preview;
        previewBox.replaceChildren(image);
      }
      const { footCheck } = result;
      if (footCheck.skipped) summary.textContent = "시트가 커서 발 위치 검사를 건너뛰었어요";
      else summary.textContent = footCheck.issueFrames > 0 ? `발 위치 이상 ${footCheck.issueFrames}프레임` : "발 위치 이상 없음";
      issuesList.replaceChildren(...footCheck.issues.slice(0, 20).map((issue) => make(doc, "li", "", issueText(issue))));
    };

    frames.addEventListener("input", () => { if (picked) { reset(); say("프레임 수를 바꿨어요. 파일을 다시 골라 주세요"); } });
    fps.addEventListener("input", () => { if (picked) showPick(picked); });
    loop.addEventListener("change", () => { if (picked) showPick(picked); });
    overrideButton.addEventListener("click", () => { override = !override; sync(); });
    cancel.addEventListener("click", () => { stopPreviews(); form.replaceChildren(); });

    const framesValue = (): number | undefined => {
      const value = Number(frames.value);
      return Number.isInteger(value) && value >= 1 && value <= 64 && frames.value.trim() !== "" ? value : undefined;
    };
    pick.addEventListener("click", () => { void (async () => {
      const count = framesValue();
      if (count === undefined) { say("프레임 수는 1~64 사이 정수여야 해요", true); return; }
      reset();
      try {
        const result = parsePick(await api.sheetPick({ packId: pack.id, frames: count }));
        if (result === undefined) { say("시트를 읽지 못했어요", true); return; }
        if (result === "canceled") { say("파일 고르기를 취소했어요"); return; }
        picked = result;
        showPick(result);
        sync();
        say(result.footCheck.issueFrames > 0 ? "발 위치 이상이 있어요. 확인하고 [그래도 사용]을 눌러야 적용돼요" : "시트를 골랐어요");
      } catch (error) { say(failureText(error), true); }
    })(); });

    apply.addEventListener("click", () => { void (async () => {
      if (!picked || apply.disabled) return;
      const count = framesValue();
      const rate = Number(fps.value);
      const state = replacing ?? name.value;
      if (count === undefined) { say("프레임 수는 1~64 사이 정수여야 해요", true); return; }
      if (fps.value.trim() === "" || !Number.isFinite(rate) || rate <= 0 || rate > 60) { say("fps 는 0 초과 60 이하여야 해요", true); return; }
      if (replacing === undefined) {
        if (!STATE_NAME_PATTERN.test(state)) { say(`상태 이름이 규칙에 맞지 않아요. ${STATE_NAME_HINT}`, true); return; }
        if (names.includes(state)) { say("같은 이름의 상태가 이미 있어요. 목록의 [시트 교체]를 쓰세요", true); return; }
      }
      const payload: Record<string, unknown> = { packId: pack.id, token: picked.token, state, frames: count, fps: rate, loop: loop.checked };
      if (next.value.trim() !== "") payload.next = next.value.trim();
      if (facing.value === "left" || facing.value === "right") payload.facing = facing.value;
      if (picked.footCheck.issueFrames > 0) payload.overrideFootIssues = override;
      apply.disabled = true;
      try {
        await api.sheetApply(payload);
        // The one-time token is spent, applied or not; a failure needs a fresh pick.
        await hooks.applied(pack.id, replacing === undefined ? `${state} 상태를 추가했어요` : `${state} 시트를 바꿨어요`);
      } catch (error) {
        reset();
        say(`${failureText(error)} (파일을 다시 골라 주세요)`, true);
      }
    })(); });

    const actionRow = make(doc, "div", "actions");
    actionRow.append(apply, cancel);
    form.replaceChildren(heading, ...(replacing === undefined ? [field("이름", name), nameHint] : []),
      field("프레임 수", frames), field("fps", fps), field("반복", loop), field("다음 상태 (선택)", next), field("바라보는 방향", facing),
      pick, previewBox, summary, issuesList, overrideButton, actionRow);
    say("");
  }
}
