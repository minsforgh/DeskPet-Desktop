export interface TerrainView { enabled: boolean; excludedApps: string[] }
export interface TerrainApi {
  terrainLoad(): Promise<TerrainView>;
  terrainSave(payload: TerrainView): Promise<{ ok: true; view: TerrainView } | { ok: false; message: string }>;
}

// Guidance only: main validates the same pattern and count again (ADR-0009 §10).
const EXCLUDED_NAME = /^[A-Za-z0-9._ -]{1,64}$/;
const MAX_EXCLUDED = 64;

type Make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => HTMLElementTagNameMap[K];

/** "화면 위 이동" section of the general tab. Names reach the page through textContent and value only. */
export function createTerrainSection(doc: Document, api: TerrainApi, make: Make, setDirty: (dirty: boolean) => void):
  { element: HTMLElement; loaded: Promise<void> } {
  const box = make("fieldset");
  box.id = "terrain-section";
  box.append(make("legend", "", "화면 위 이동"));
  const toggleLabel = make("label");
  const enabled = make("input");
  enabled.type = "checkbox";
  enabled.id = "terrain-enabled";
  toggleLabel.append(enabled, make("span", "", "다른 창과 화면 위를 오르내리며 돌아다니기"));
  const info = make("p", "description", "읽는 정보: 창의 위치·크기, 제외 목록이 있을 때 실행 파일 이름. 읽지 않는 정보: 창 제목·내용·경로.");
  info.id = "terrain-info";
  const listTitle = make("p", "field-title", "제외 앱 (이 앱의 창은 발판으로 쓰지 않아요)");
  const list = make("ul");
  list.id = "terrain-excluded-list";
  const input = make("input");
  input.type = "text";
  input.id = "terrain-exclude-input";
  input.placeholder = "예: chrome.exe";
  input.maxLength = 64;
  input.setAttribute("aria-label", "제외할 실행 파일 이름");
  const add = make("button", "", "추가");
  add.type = "button";
  add.id = "terrain-exclude-add";
  const save = make("button", "", "저장");
  save.type = "button";
  save.id = "terrain-save";
  const note = make("span", "terrain-dirty-note");
  const status = make("span", "status");
  status.id = "terrain-status";
  status.setAttribute("role", "status");
  const actions = make("div", "actions");
  actions.append(save, note, status);
  box.append(toggleLabel, info, listTitle, list, input, add, actions);

  let names: string[] = [];
  let baseline = "";
  let loaded = false;
  const snapshot = (): string => JSON.stringify({ enabled: enabled.checked, names });
  const updateDirty = (): void => {
    const dirty = loaded && snapshot() !== baseline;
    note.textContent = dirty ? "저장하지 않은 변경이 있어요" : "";
    setDirty(dirty);
  };
  const say = (text: string, kind: "" | "ok" | "error"): void => {
    status.textContent = text;
    status.classList.remove("ok", "error");
    if (kind) status.classList.add(kind);
  };
  const drawList = (): void => {
    list.replaceChildren(...names.map((name, index) => {
      const item = make("li", "terrain-excluded");
      const remove = make("button", "terrain-excluded-remove", "삭제");
      remove.type = "button";
      remove.setAttribute("aria-label", `${name} 삭제`);
      remove.addEventListener("click", () => { names = names.filter((_, other) => other !== index); drawList(); updateDirty(); });
      item.append(make("span", "terrain-excluded-name", name), remove);
      return item;
    }));
  };
  const apply = (view: TerrainView): void => {
    enabled.checked = view.enabled;
    names = [...view.excludedApps];
    drawList();
    baseline = snapshot();
    loaded = true;
    updateDirty();
  };

  enabled.addEventListener("change", updateDirty);
  const addName = (): void => {
    const name = input.value.trim();
    if (!EXCLUDED_NAME.test(name)) { say("실행 파일 이름은 영문·숫자·. _ - 공백만, 64자까지 쓸 수 있어요", "error"); return; }
    if (names.some((other) => other.toLowerCase() === name.toLowerCase())) { say("이미 목록에 있어요", "error"); return; }
    if (names.length >= MAX_EXCLUDED) { say("제외 앱은 최대 64개까지예요", "error"); return; }
    names = [...names, name];
    input.value = "";
    say("", "");
    drawList();
    updateDirty();
  };
  add.addEventListener("click", addName);
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addName(); } });
  save.addEventListener("click", () => {
    void (async () => {
      say("저장 중…", "");
      try {
        const result = await api.terrainSave({ enabled: enabled.checked, excludedApps: names });
        if (!result.ok) { say(result.message, "error"); return; }
        apply(result.view);
        say("저장했어요", "ok");
      } catch { say("화면 위 이동 설정을 저장하지 못했어요", "error"); }
    })();
  });

  enabled.disabled = true;
  const loadedView = api.terrainLoad().then((view) => { apply(view); enabled.disabled = false; },
    () => { say("화면 위 이동 설정을 불러오지 못했어요", "error"); });
  return { element: box, loaded: loadedView };
}
