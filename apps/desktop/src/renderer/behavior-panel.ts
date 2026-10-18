import type { CharacterBehavior } from "@deskpet/core";

export interface BehaviorValues {
  sleepAfterMs: number;
  blinkIntervalMs: readonly [number, number];
  walkIntervalMs: readonly [number, number];
  walkDurationMs: number;
  walkSpeedPxPerSecond: number;
  climbChance: number;
  descendChance: number;
  jumpMaxHeight: number;
  climbSpeed: number;
  jumpClearance: number;
  gravity: number;
  gapJumpDistance: number;
  gapJumpChance: number;
}

export interface BehaviorView { packId: string; defaults: BehaviorValues; behavior: BehaviorValues; states: string[] }
export interface BehaviorApi {
  behaviorLoad(packId: string): Promise<BehaviorView>;
  behaviorSave(payload: { packId: string; behavior: CharacterBehavior | null }): Promise<
    { ok: true; view: BehaviorView } | { ok: false; message: string }>;
}

const fields = [
  { key: "sleepAfterMs", title: "잠들기까지", state: "sleep", min: 5, max: 3600, step: 1 },
  { key: "blinkIntervalMs", title: "눈 깜빡임 간격", state: "blink", min: 1, max: 60, step: 1 },
  { key: "walkIntervalMs", title: "걷기 간격", state: "walk", min: 1, max: 600, step: 1 },
  { key: "walkDurationMs", title: "걷기 시간", state: "walk", min: 0.5, max: 30, step: 0.001 },
  { key: "walkSpeedPxPerSecond", title: "걷기 속도", state: "walk", min: 0, max: 300, step: "any" },
  // Shown as 0-100 % with one decimal; stored as 0-1 (ADR-0009 §10). Movement needs no animation state.
  { key: "climbChance", title: "오르기 확률", state: undefined, min: 0, max: 100, step: "any" },
  { key: "descendChance", title: "내려가기 확률", state: undefined, min: 0, max: 100, step: "any" },
  { key: "jumpMaxHeight", title: "점프 기준 높이", state: undefined, min: 0, max: 2000, step: "any" },
  { key: "climbSpeed", title: "등반 속도", state: undefined, min: 20, max: 1000, step: "any" },
  { key: "jumpClearance", title: "점프 여유 높이", state: undefined, min: 0, max: 300, step: "any" },
  { key: "gravity", title: "중력", state: undefined, min: 200, max: 10000, step: "any" },
  { key: "gapJumpDistance", title: "뛰어넘기 거리", state: undefined, min: 0, max: 1000, step: "any" },
  { key: "gapJumpChance", title: "뛰어넘기 확률", state: undefined, min: 0, max: 100, step: "any" },
] as const;

/** The fields from here on form the "화면 위 이동" group (ADR-0009 §10, §17). */
const TERRAIN_GROUP_START = "climbChance";
// Stored as typed (no unit conversion), like the walk speed.
const plainUnits: Record<string, string> = { walkSpeedPxPerSecond: "픽셀/초", jumpMaxHeight: "픽셀", climbSpeed: "픽셀/초",
  jumpClearance: "픽셀", gravity: "픽셀/초²", gapJumpDistance: "픽셀" };

const helpTexts: Record<string, string> = {
  climbChance: "앞을 막는 창을 오를지(아니면 돌아섬)",
  descendChance: "창 끝에서 내려갈지(아니면 돌아섬)",
  jumpMaxHeight: "이 높이 이하는 점프·뛰어내리기, 넘으면 기어오르기·타고 내려가기",
  climbSpeed: "기어오르고 타고 내려가는 속도",
  jumpClearance: "점프할 때 창 윗변보다 더 솟는 높이",
  gravity: "떨어지고 점프하는 빠르기",
  gapJumpDistance: "창 끝에서 이 거리 안의 다음 창으로 점프해 건너감(0 이면 안 함)",
  gapJumpChance: "건너갈 창이 있을 때 뛰어넘을지(아니면 내려가기 확률로)",
};

const isChance = (key: string): boolean => key === "climbChance" || key === "descendChance" || key === "gapJumpChance";
const toPercent = (value: number): number => Math.round(value * 1000) / 10;
const fromPercent = (value: number): number => Math.round(value * 10) / 1000;
const shown = (key: string, value: number): number =>
  key in plainUnits ? value : isChance(key) ? toPercent(value) : value / 1000;
const unitOf = (key: string): string => plainUnits[key] ?? (isChance(key) ? "%" : "초");

type Controller = { dirty(): boolean; discard(): void };

export function createBehaviorPanel(doc: Document, root: HTMLElement, api: BehaviorApi, setDirty: (dirty: boolean) => void) {
  let selectedId: string | undefined;
  let generation = 0;
  let controller: Controller | undefined;

  const draw = (view: BehaviorView): void => {
    const form = doc.createElement("form");
    form.id = "behavior-form";
    form.noValidate = true;
    const controls = new Map<string, HTMLInputElement>();
    for (const field of fields) {
      if (field.key === TERRAIN_GROUP_START) {
        const heading = doc.createElement("h3");
        heading.id = "behavior-terrain-group";
        heading.className = "behavior-group";
        heading.textContent = "화면 위 이동";
        form.append(heading);
      }
      const row = doc.createElement("div");
      row.className = "behavior-row";
      const title = doc.createElement("span");
      title.className = "field-title";
      title.textContent = field.title;
      row.append(title);
      const current = view.behavior[field.key];
      const baseline = view.defaults[field.key];
      const values = Array.isArray(current) ? current : [current];
      const bases = Array.isArray(baseline) ? baseline : [baseline];
      values.forEach((value, index) => {
        const label = doc.createElement("label");
        label.textContent = values.length === 2 ? (index === 0 ? "최소" : "최대") : unitOf(field.key);
        const input = doc.createElement("input");
        input.type = "number";
        input.id = `behavior-${field.key}${values.length === 2 ? `-${index}` : ""}`;
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = String(field.step);
        input.value = String(shown(field.key, value));
        input.disabled = field.state !== undefined && !view.states.includes(field.state);
        label.append(input);
        row.append(label);
        controls.set(input.id, input);
      });
      const defaultText = doc.createElement("span");
      defaultText.className = "description behavior-default";
      defaultText.textContent = `팩 기본값: ${bases.map((value) => shown(field.key, value)).join("~")} ${unitOf(field.key)}`;
      row.append(defaultText);
      const helpText = helpTexts[field.key];
      if (helpText) {
        const help = doc.createElement("span");
        help.className = "description behavior-help";
        help.textContent = helpText;
        row.append(help);
      }
      form.append(row);
    }
    const actions = doc.createElement("div");
    actions.className = "actions";
    const save = doc.createElement("button");
    save.type = "submit";
    save.id = "behavior-save";
    save.textContent = "저장";
    const reset = doc.createElement("button");
    reset.type = "button";
    reset.id = "behavior-reset";
    reset.textContent = "기본값으로";
    const note = doc.createElement("span");
    note.id = "behavior-dirty";
    note.className = "dirty-note";
    const status = doc.createElement("p");
    status.id = "behavior-status";
    status.className = "status";
    actions.append(save, reset, note);
    form.append(actions, status);
    root.replaceChildren(form);

    const snapshot = (): string => JSON.stringify(Array.from(controls.values(), (input) => input.value));
    const baseline = snapshot();
    const dirty = (): boolean => snapshot() !== baseline;
    const updateDirty = (): void => { note.textContent = dirty() ? "저장하지 않은 변경이 있어요" : ""; setDirty(dirty()); };
    form.addEventListener("input", updateDirty);
    controller = { dirty, discard: () => { setDirty(false); controller = undefined; root.replaceChildren(); } };

    const saveValue = async (behavior: CharacterBehavior | null): Promise<void> => {
      const enabled = new Map(Array.from(controls.values(), (input) => [input, !input.disabled]));
      for (const input of controls.values()) input.disabled = true;
      save.disabled = true;
      reset.disabled = true;
      try {
        const result = await api.behaviorSave({ packId: view.packId, behavior });
        if (!result.ok) { status.textContent = result.message; status.className = "status error"; return; }
        if (selectedId !== view.packId) return;
        draw(result.view);
        const savedStatus = root.querySelector<HTMLElement>("#behavior-status");
        if (savedStatus) { savedStatus.textContent = "저장했어요"; savedStatus.className = "status ok"; }
        setDirty(false);
      } catch { status.textContent = "행동 설정을 저장하지 못했어요"; status.className = "status error"; }
      finally {
        for (const [input, wasEnabled] of enabled) input.disabled = !wasEnabled;
        save.disabled = false;
        reset.disabled = false;
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values: CharacterBehavior = {};
      for (const field of fields) {
        if (field.state !== undefined && !view.states.includes(field.state)) continue;
        const names = field.key === "blinkIntervalMs" || field.key === "walkIntervalMs"
          ? [`behavior-${field.key}-0`, `behavior-${field.key}-1`] : [`behavior-${field.key}`];
        const inputs = names.map((name) => controls.get(name));
        const invalid = inputs.find((input) => !input || !input.validity.valid || input.value === "");
        if (inputs.some((input) => !input || !input.validity.valid || input.value === "")) {
          // Name the field and its range so the user knows which value to change.
          const whole = field.step === 1 ? ", 정수" : "";
          status.textContent = `${field.title}: ${field.min}–${field.max} ${unitOf(field.key)}${whole}로 넣어 주세요`;
          status.className = "status error";
          invalid?.focus();
          return;
        }
        if (inputs.length === 2 && Number(inputs[0]?.value) > Number(inputs[1]?.value)) {
          status.textContent = `${field.title}: 최소가 최대보다 클 수 없어요`;
          status.className = "status error";
          inputs[0]?.focus();
          return;
        }
        const numbers = inputs.map((input) => field.key in plainUnits
          ? Number(input?.value) : isChance(field.key) ? fromPercent(Number(input?.value)) : Math.round(Number(input?.value) * 1000));
        if (field.key === "sleepAfterMs" && numbers[0] !== view.defaults.sleepAfterMs) values.sleepAfterMs = numbers[0];
        if (field.key === "walkDurationMs" && numbers[0] !== view.defaults.walkDurationMs) values.walkDurationMs = numbers[0];
        if (field.key === "walkSpeedPxPerSecond" && numbers[0] !== view.defaults.walkSpeedPxPerSecond)
          values.walkSpeedPxPerSecond = numbers[0];
        for (const key of ["climbChance", "descendChance", "jumpMaxHeight", "climbSpeed", "jumpClearance", "gravity", "gapJumpDistance", "gapJumpChance"] as const)
          if (field.key === key && numbers[0] !== undefined && numbers[0] !== view.defaults[key]) values[key] = numbers[0];
        if (field.key === "blinkIntervalMs" && numbers[0] !== undefined && numbers[1] !== undefined)
          if (numbers[0] !== view.defaults.blinkIntervalMs[0] || numbers[1] !== view.defaults.blinkIntervalMs[1])
            values.blinkIntervalMs = [numbers[0], numbers[1]];
        if (field.key === "walkIntervalMs" && numbers[0] !== undefined && numbers[1] !== undefined)
          if (numbers[0] !== view.defaults.walkIntervalMs[0] || numbers[1] !== view.defaults.walkIntervalMs[1])
            values.walkIntervalMs = [numbers[0], numbers[1]];
      }
      void saveValue(Object.keys(values).length === 0 ? null : values);
    });
    reset.addEventListener("click", () => { void saveValue(null); });
  };

  return {
    dirty: (): boolean => controller?.dirty() === true,
    discard: (): void => controller?.discard(),
    async load(packId: string): Promise<void> {
      if (selectedId === packId && controller?.dirty()) return;
      selectedId = packId;
      const request = ++generation;
      try {
        const view = await api.behaviorLoad(packId);
        if (request === generation) draw(view);
      } catch {
        if (request !== generation) return;
        const message = doc.createElement("p");
        message.className = "status error";
        message.textContent = "행동 정보를 불러오지 못했어요";
        root.replaceChildren(message);
      }
    },
  };
}
