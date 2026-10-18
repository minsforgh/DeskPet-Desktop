import { Menu, nativeImage, Tray } from "electron";

function createTrayIcon(): Electron.NativeImage {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const head = ((x - 7.5) / 5.5) ** 2 + ((y - 8.5) / 5.5) ** 2 <= 1;
      const leftEar = x >= 2 && x <= 5 && y >= 2 && y <= 6;
      const rightEar = x >= 10 && x <= 13 && y >= 2 && y <= 6;
      if (!head && !leftEar && !rightEar) continue;

      const edge = ((x - 7.5) / 4.5) ** 2 + ((y - 8.5) / 4.5) ** 2 > 1;
      const eye = y === 8 && (x === 6 || x === 10);
      const shade = edge || eye ? 48 : 255;
      const offset = (y * size + x) * 4;
      pixels[offset] = shade;
      pixels[offset + 1] = shade;
      pixels[offset + 2] = shade;
      pixels[offset + 3] = 255;
    }
  }

  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
}

/** One line of the "플러그인" submenu. Lines without click are status text. */
export interface PluginMenuItem { label: string; click?: () => void }

function findClickable(items: readonly Electron.MenuItemConstructorOptions[], label: string): (() => void) | undefined {
  for (const item of items) {
    if (item.label === label && item.enabled !== false && item.click) {
      // These callbacks use only the action closures; Electron supplies event arguments for UI clicks.
      return item.click as () => void;
    }
    const found = Array.isArray(item.submenu) ? findClickable(item.submenu, label) : undefined;
    if (found) return found;
  }
  return undefined;
}

export function createPetTray(actions: {
  showPet: () => void;
  hidePet: () => void;
  toggleDoNotDisturb: () => void;
  openSettings: () => void;
  openLogsFolder: () => void;
  quitApp: () => void;
}): {
  tray: Tray;
  clickMenuItem: (label: string) => void;
  setDoNotDisturbChecked: (checked: boolean) => void;
  /** Whether the 방해 금지 checkbox is currently checked, for the e2e tests. */
  doNotDisturbChecked: () => boolean;
  setPluginMenu: (items: readonly PluginMenuItem[]) => void;
  setBadgeSummary: (lines: readonly string[]) => void;
  toolTip: () => string;
  /** Every label of the current menu, submenus included; the e2e tests read what the user would see. */
  menuLabels: () => string[];
} {
  const tray = new Tray(createTrayIcon());
  tray.setToolTip("DeskPet");
  let template: Electron.MenuItemConstructorOptions[] = [];
  let doNotDisturbChecked = false;
  let pluginItems: readonly PluginMenuItem[] = [];
  let toolTip = "DeskPet";
  // The checkbox toggles from the app's own state, so both a real click and clickMenuItem agree.
  const rebuild = (): void => {
    if (tray.isDestroyed()) return;
    const submenu: Electron.MenuItemConstructorOptions[] = pluginItems.length === 0
      ? [{ label: "플러그인 없음", enabled: false }]
      : pluginItems.map(({ label, click }) => click ? { label, click } : { label, enabled: false });
    template = [
      { label: "표시", click: actions.showPet },
      { label: "숨김", click: actions.hidePet },
      { label: "방해 금지", type: "checkbox", checked: doNotDisturbChecked, click: actions.toggleDoNotDisturb },
      { label: "설정…", click: actions.openSettings },
      { label: "플러그인", submenu },
      { label: "오류 기록 폴더 열기", click: actions.openLogsFolder },
      { label: "종료", click: actions.quitApp },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };
  rebuild();
  return {
    tray,
    clickMenuItem(label) {
      const callback = findClickable(template, label);
      if (!callback) throw new Error("Unknown tray menu label");
      callback();
    },
    setDoNotDisturbChecked(checked) { doNotDisturbChecked = checked; rebuild(); },
    doNotDisturbChecked: () => doNotDisturbChecked,
    setPluginMenu(items) { pluginItems = items; rebuild(); },
    setBadgeSummary(lines) { toolTip = ["DeskPet", ...lines].join("\n"); tray.setToolTip(toolTip); },
    toolTip: () => toolTip,
    menuLabels: () => template.flatMap((item) => [item.label ?? "", ...(Array.isArray(item.submenu) ? item.submenu.map((sub) => sub.label ?? "") : [])]),
  };
}
