import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { DesktopApp } from "./desktop-app.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type BadgeState = { visible: boolean; text: string | null; tooltip: string | null;
  rect: { x: number; y: number; width: number; height: number } | null;
  tooltipRows: Array<{ x: number; y: number; width: number; height: number }> };
type State = { rendererMetrics: { badge: BadgeState }; trayMenu: string[]; trayToolTip: string; ignoreMouseEvents: boolean;
  pluginHost: { plugins: Array<{ id: string; state: string }> };
  bounds: { x: number; y: number; width: number; height: number };
  contentRect: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number } };

const state = (app: DesktopApp): Promise<State> => app.request({ cmd: "state" }) as Promise<State>;
const waitFor = (fn: () => Promise<void>): Promise<void> => vi.waitFor(fn, { timeout: 10_000, interval: 50 });

test("badge placement changes on the rendered pet, survives restart, and stays on screen at both edges", async () => {
  const root = await mkdtemp(join(tmpdir(), "deskpet-badge-placement-"));
  const plugins = join(root, "plugins");
  const userData = join(root, "user-data");
  const folder = join(plugins, "placement");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify({ id: "placement", name: "Placement", version: "1.0.0",
    apiVersion: "2", entry: "index.mjs", description: "Placement fixture", permissions: {},
    contributes: { badges: ["placement.status"] } }), "utf8");
  await writeFile(join(folder, "index.mjs"), 'export default { activate(ctx) { ctx.setBadge("placement.status", { text: "Ready", tone: "warn" }); } };', "utf8");
  const args = [`--plugins-dir=${plugins}`, "--terrain-source=off"];
  let app = await DesktopApp.launch(userData, args);
  try {
    const assertSide = async (side: "above" | "left" | "right", gap: number): Promise<void> => {
      const shown = await state(app);
      const chip = shown.rendererMetrics.badge.rect;
      if (!chip) throw new Error("Badge chip has no rendered bounds");
      const content = { x: shown.contentRect.x - shown.bounds.x, y: shown.contentRect.y - shown.bounds.y,
        width: shown.contentRect.width, height: shown.contentRect.height };
      if (side === "above") expect(content.y - (chip.y + chip.height)).toBeCloseTo(gap, 0);
      if (side === "left") expect(content.x - (chip.x + chip.width)).toBeCloseTo(gap, 0);
      if (side === "right") expect(chip.x - (content.x + content.width)).toBeCloseTo(gap, 0);
    };
    const initial = await state(app);
    await app.request({ cmd: "moveBy", dx: Math.floor(initial.workArea.x + initial.workArea.width / 2 - initial.contentRect.width / 2 - initial.contentRect.x), dy: 0 });
    await waitFor(() => assertSide("above", 3));
    await app.request({ cmd: "trayMenuClick", label: "설정…" });
    await app.request({ cmd: "settingsSet", selector: "#badge-side", value: "left" });
    await waitFor(() => assertSide("left", 3));
    const leftChip = (await state(app)).rendererMetrics.badge.rect;
    if (!leftChip) throw new Error("Left badge chip has no rendered bounds");
    const hovered = await app.request({ cmd: "petMouseMoveForTest",
      x: leftChip.x + leftChip.width / 2, y: leftChip.y + leftChip.height / 2 }) as BadgeState;
    expect(hovered.tooltipRows[0]?.y).toBeGreaterThanOrEqual(leftChip.y + leftChip.height);
    await app.request({ cmd: "petMouseMoveForTest", x: 0, y: 0 });
    await app.request({ cmd: "settingsSet", selector: "#badge-gap", value: "20" });
    await waitFor(() => assertSide("left", 20));
    await app.request({ cmd: "settingsSet", selector: "#badge-side", value: "right" });
    await waitFor(() => assertSide("right", 20));
    await app.request({ cmd: "settingsClose" });
    await app.dispose();
    app = await DesktopApp.launch(userData, args);
    await waitFor(() => assertSide("right", 20));
    for (const edge of ["left", "right"] as const) {
      const before = await state(app);
      const target = edge === "left" ? before.workArea.x : before.workArea.x + before.workArea.width - before.contentRect.width;
      await app.request({ cmd: "moveBy", dx: target - before.contentRect.x, dy: 0 });
      await waitFor(async () => {
        const shown = await state(app);
        const chip = shown.rendererMetrics.badge.rect;
        if (!chip) throw new Error("Badge chip has no rendered bounds");
        expect(shown.bounds.x + chip.x).toBeGreaterThanOrEqual(shown.workArea.x);
        expect(shown.bounds.x + chip.x + chip.width).toBeLessThanOrEqual(shown.workArea.x + shown.workArea.width);
        if (edge === "right") expect(chip.x + chip.width).toBeLessThanOrEqual(shown.contentRect.x - shown.bounds.x);
      });
    }
  } finally {
    await app.dispose();
    await cleanupTemporaryPath(root);
  }
}, 90_000);

test("badge gap is honored on all sides for a pack whose content touches the window top", async () => {
  const root = await mkdtemp(join(tmpdir(), "deskpet-badge-wolf-"));
  const plugins = join(root, "plugins");
  const characters = join(root, "characters");
  const userData = join(root, "user-data");
  const folder = join(plugins, "placement");
  await mkdir(folder, { recursive: true });
  await mkdir(characters, { recursive: true });
  await cp(resolve(import.meta.dirname, "../../../characters/wolf-maid"), join(characters, "wolf-maid"), { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify({ id: "placement", name: "Placement", version: "1.0.0",
    apiVersion: "2", entry: "index.mjs", description: "Placement fixture", permissions: {},
    contributes: { badges: ["placement.status"] } }), "utf8");
  await writeFile(join(folder, "index.mjs"), 'export default { activate(ctx) { ctx.setBadge("placement.status", { text: "Ready", tone: "warn" }); } };', "utf8");
  const app = await DesktopApp.launch(userData, [`--characters-dir=${characters}`, "--character=wolf-maid", `--plugins-dir=${plugins}`, "--terrain-source=off"]);
  try {
    const assertGap = async (side: "above" | "left" | "right", gap: number): Promise<void> => {
      const shown = await state(app);
      const chip = shown.rendererMetrics.badge.rect;
      if (!chip) throw new Error("Badge chip has no rendered bounds");
      const content = { x: shown.contentRect.x - shown.bounds.x, y: shown.contentRect.y - shown.bounds.y,
        width: shown.contentRect.width, height: shown.contentRect.height };
      if (side === "above") expect(Math.abs(content.y - (chip.y + chip.height) - gap)).toBeLessThanOrEqual(1);
      if (side === "left") expect(Math.abs(content.x - (chip.x + chip.width) - gap)).toBeLessThanOrEqual(1);
      if (side === "right") expect(Math.abs(chip.x - (content.x + content.width) - gap)).toBeLessThanOrEqual(1);
    };
    const contentOf = async (): Promise<{ x: number; y: number }> => { const { contentRect } = await state(app); return { x: contentRect.x, y: contentRect.y }; };
    const initial = await state(app);
    await app.request({ cmd: "moveBy", dx: Math.floor(initial.workArea.x + initial.workArea.width / 2 - initial.contentRect.width / 2 - initial.contentRect.x), dy: 0 });
    await app.request({ cmd: "trayMenuClick", label: "설정…" });
    await waitFor(() => assertGap("above", 3));
    const foot = await contentOf();
    for (const gap of [0, 20, 40]) {
      await app.request({ cmd: "settingsSet", selector: "#badge-gap", value: String(gap) });
      await waitFor(() => assertGap("above", gap));
      expect(await contentOf()).toEqual(foot);
    }
    for (const side of ["left", "right"] as const) {
      await app.request({ cmd: "settingsSet", selector: "#badge-side", value: side });
      for (const gap of [0, 20, 40]) {
        await app.request({ cmd: "settingsSet", selector: "#badge-gap", value: String(gap) });
        await waitFor(() => assertGap(side, gap));
      }
    }
    await app.request({ cmd: "settingsSet", selector: "#badge-side", value: "above" });
    await waitFor(() => assertGap("above", 40));
    expect(await contentOf()).toEqual(foot);
  } finally {
    await app.dispose();
    await cleanupTemporaryPath(root);
  }
}, 90_000);

test("warn and neutral badges follow the pet, show every badge on hover, and clear from pet and tray", async () => {
  const root = await mkdtemp(join(tmpdir(), "deskpet-plugin-badge-"));
  const plugins = join(root, "plugins");
  const userData = join(root, "user-data");
  const folder = join(plugins, "badge");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify({ id: "badge", name: "Badge", version: "1.0.0",
    apiVersion: "1", entry: "index.mjs", description: "Badge e2e fixture", permissions: {}, contributes: {
      actions: ["badge.ok", "badge.neutral", "badge.warn", "badge.clear"],
      badges: ["badge.primary", "badge.second"],
      trayItems: ["badge.ok-item", "badge.neutral-item", "badge.warn-item", "badge.clear-item"],
    } }), "utf8");
  await writeFile(join(folder, "index.mjs"), `export default { activate(ctx) {
    ctx.setBadge("badge.primary", { text: "확인 대기", tone: "warn" });
    const actions = {
      "badge.ok": () => ctx.setBadge("badge.primary", { text: "완료", tone: "ok" }),
      "badge.neutral": () => ctx.setBadge("badge.primary", { text: "진행 중", tone: "neutral" }),
      "badge.warn": () => ctx.setBadge("badge.second", { text: "다시 확인", tone: "warn" }),
      "badge.clear": async () => { await ctx.setBadge("badge.second", null); await ctx.setBadge("badge.primary", null); },
    };
    for (const [id, handler] of Object.entries(actions)) {
      ctx.registerAction(id, handler);
      ctx.addTrayItem({ id: id + "-item", label: id, action: id });
    }
  } };`, "utf8");
  const other = join(plugins, "other");
  await mkdir(other);
  await writeFile(join(other, "manifest.json"), JSON.stringify({ id: "other", name: "Other", version: "1.0.0",
    apiVersion: "1", entry: "index.mjs", description: "Second badge fixture", permissions: {}, contributes: {
      actions: ["other.warn", "other.clear"], badges: ["other.status"], trayItems: ["other.warn-item", "other.clear-item"],
    } }), "utf8");
  await writeFile(join(other, "index.mjs"), `export default { activate(ctx) {
    ctx.setBadge("other.status", { text: "완료", tone: "ok" });
    ctx.registerAction("other.warn", () => ctx.setBadge("other.status", { text: "새 확인", tone: "warn" }));
    ctx.registerAction("other.clear", () => ctx.setBadge("other.status", null));
    ctx.addTrayItem({ id: "other.warn-item", label: "other.warn", action: "other.warn" });
    ctx.addTrayItem({ id: "other.clear-item", label: "other.clear", action: "other.clear" });
  } };`, "utf8");
  const app = await DesktopApp.launch(userData, [`--plugins-dir=${plugins}`, "--terrain-source=off"]);
  try {
    await waitFor(async () => {
      const shown = await state(app);
      expect(shown.rendererMetrics.badge).toMatchObject({ visible: true, text: "확인 대기" });
      expect(shown.trayMenu).toContain("Badge: 실행 중 · 확인 대기");
      expect(shown.trayMenu).toContain("Other: 실행 중 · 완료");
      expect(shown.trayToolTip).toContain("Badge: 확인 대기");
    });
    const rect = (await state(app)).rendererMetrics.badge.rect;
    expect(rect).not.toBeNull();
    if (!rect) throw new Error("Badge chip has no bounds");
    const x = Math.floor(rect.x + rect.width / 2);
    const y = Math.floor(rect.y + rect.height / 2);
    expect(await app.request({ cmd: "hitTest", x, y })).toMatchObject({ interactive: true });
    const hovered = await app.request({ cmd: "petMouseMoveForTest", x, y }) as BadgeState;
    expect(await app.request({ cmd: "petBadgeClickForTest", x, y })).toEqual({ clicked: false });
    expect(hovered.tooltip?.split("\n")).toEqual(expect.arrayContaining(["Badge: 확인 대기", "Other: 완료"]));
    expect(hovered.tooltip?.split("\n")).toHaveLength(2);
    await waitFor(async () => { expect((await state(app)).ignoreMouseEvents).toBe(false); });
    expect(await app.request({ cmd: "hitTest", x: 0, y: 0 })).toMatchObject({ interactive: false, alpha: 0 });
    await app.request({ cmd: "petMouseMoveForTest", x: 0, y: 0 });
    expect((await state(app)).rendererMetrics.badge.tooltip).toBeNull();
    await waitFor(async () => { expect((await state(app)).ignoreMouseEvents).toBe(true); });
    await app.request({ cmd: "screenshot", path: join(tmpdir(), "deskpet-m12-plugin-badge.png") });

    await app.request({ cmd: "trayMenuClick", label: "badge.ok" });
    await waitFor(async () => {
      const shown = await state(app);
      expect(shown.rendererMetrics.badge.visible).toBe(false);
      expect(shown.trayMenu).toContain("Badge: 실행 중 · 완료");
      expect(shown.trayMenu).toContain("Other: 실행 중 · 완료");
      expect(shown.trayToolTip).toBe("DeskPet");
    });
    await app.request({ cmd: "trayMenuClick", label: "badge.neutral" });
    await waitFor(async () => { expect((await state(app)).rendererMetrics.badge.text).toBe("진행 중"); });
    await app.request({ cmd: "trayMenuClick", label: "badge.warn" });
    await waitFor(async () => { expect((await state(app)).rendererMetrics.badge.text).toBe("다시 확인 +1"); });
    const second = (await state(app)).rendererMetrics.badge.rect;
    if (!second) throw new Error("Badge chip has no bounds");
    const list = await app.request({ cmd: "petMouseMoveForTest",
      x: Math.floor(second.x + second.width / 2), y: Math.floor(second.y + second.height / 2) }) as BadgeState;
    expect(list.tooltip?.split("\n")).toEqual(expect.arrayContaining(["Badge: 진행 중", "Badge: 다시 확인", "Other: 완료"]));
    expect(list.tooltip?.split("\n")).toHaveLength(3);
    await app.request({ cmd: "trayMenuClick", label: "other.warn" });
    await waitFor(async () => { expect((await state(app)).rendererMetrics.badge.text).toBe("새 확인 +2"); });
    await app.request({ cmd: "trayMenuClick", label: "other.clear" });
    await app.request({ cmd: "trayMenuClick", label: "badge.clear" });
    await waitFor(async () => {
      const shown = await state(app);
      expect(shown.rendererMetrics.badge.visible).toBe(false);
      expect(shown.trayMenu).toContain("Badge: 실행 중");
      expect(shown.trayMenu).toContain("Other: 실행 중");
      expect(shown.trayMenu.some((line) => line.includes(" · 확인 대기") || line.includes(" · 다시 확인"))).toBe(false);
      expect(shown.trayToolTip).toBe("DeskPet");
    });
  } finally {
    await app.dispose();
    await cleanupTemporaryPath(root);
  }
}, 60_000);

test("v1 plugin cannot display a badge action", async () => {
  const root = await mkdtemp(join(tmpdir(), "deskpet-v1-badge-action-"));
  const plugins = join(root, "plugins");
  const folder = join(plugins, "legacy");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify({ id: "legacy", name: "Legacy", version: "1.0.0",
    apiVersion: "1", entry: "index.mjs", description: "Rejected v1 badge action", permissions: {}, contributes: {
      actions: ["legacy.run"], badges: ["legacy.status"],
    } }), "utf8");
  await writeFile(join(folder, "index.mjs"), `export default { activate(ctx) {
    ctx.setBadge("legacy.status", { text: "Rejected", action: "legacy.run" });
    ctx.registerAction("legacy.run", () => {});
  } };`, "utf8");
  const app = await DesktopApp.launch(join(root, "user-data"), [`--plugins-dir=${plugins}`, "--terrain-source=off"]);
  try {
    await waitFor(async () => {
      const shown = await state(app);
      expect(shown.pluginHost.plugins.find((plugin) => plugin.id === "legacy")?.state).toBe("disabled");
      expect(shown.rendererMetrics.badge.visible).toBe(false);
      expect(shown.trayMenu.some((line) => line.includes("Rejected"))).toBe(false);
    });
  } finally {
    await app.dispose();
    await cleanupTemporaryPath(root);
  }
}, 60_000);

test("v2 badge chip and tooltip row invoke their declared actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "deskpet-badge-actions-"));
  const plugins = join(root, "plugins");
  const userData = join(root, "user-data");
  const actionable = join(plugins, "actionable");
  await mkdir(actionable, { recursive: true });
  await writeFile(join(actionable, "manifest.json"), JSON.stringify({ id: "actionable", name: "Actionable", version: "1.0.0",
    apiVersion: "2", entry: "index.mjs", description: "Badge actions", permissions: {}, contributes: {
      actions: ["actionable.first", "actionable.second"], badges: ["actionable.first-badge", "actionable.second-badge"],
    } }), "utf8");
  await writeFile(join(actionable, "index.mjs"), `export default { activate(ctx) {
    ctx.setBadge("actionable.first-badge", { text: "First", tone: "neutral", action: "actionable.first" });
    ctx.setBadge("actionable.second-badge", { text: "Second", tone: "warn", action: "actionable.second" });
    ctx.registerAction("actionable.first", () => ctx.setBadge("actionable.first-badge", { text: "First clicked", tone: "neutral" }));
    ctx.registerAction("actionable.second", () => ctx.setBadge("actionable.second-badge", { text: "Second clicked", tone: "warn" }));
  } };`, "utf8");
  const app = await DesktopApp.launch(userData, [`--plugins-dir=${plugins}`, "--terrain-source=off"]);
  try {
    await waitFor(async () => {
      const shown = await state(app);
      expect(shown.rendererMetrics.badge).toMatchObject({ visible: true, text: "Second +1" });
    });
    const chip = (await state(app)).rendererMetrics.badge.rect;
    if (!chip) throw new Error("Actionable badge has no bounds");
    const x = chip.x + chip.width / 2;
    const y = chip.y + chip.height / 2;
    expect(await app.request({ cmd: "petBadgeDragForTest", x, y })).toEqual({ clicked: false });
    expect((await state(app)).rendererMetrics.badge.text).toBe("Second +1");
    expect(await app.request({ cmd: "petBadgeClickForTest", x, y })).toEqual({ clicked: true });
    await waitFor(async () => { expect((await state(app)).rendererMetrics.badge.text).toBe("Second clic… +1"); });
    const hovered = await app.request({ cmd: "petMouseMoveForTest", x, y }) as BadgeState;
    expect(hovered.tooltipRows).toHaveLength(2);
    const row = hovered.tooltipRows[0];
    if (!row) throw new Error("First tooltip row has no bounds");
    const rowX = row.x + row.width / 2;
    const rowY = row.y + row.height / 2;
    expect(await app.request({ cmd: "hitTest", x: rowX, y: rowY })).toMatchObject({ interactive: true });
    expect(await app.request({ cmd: "petBadgeClickForTest", x: rowX, y: rowY })).toEqual({ clicked: true });
    await waitFor(async () => {
      const next = await app.request({ cmd: "petMouseMoveForTest", x, y }) as BadgeState;
      expect(next.tooltip).toContain("Actionable: First clicked");
    });
    expect(await app.request({ cmd: "hitTest", x: 0, y: 0 })).toMatchObject({ interactive: false });
  } finally {
    await app.dispose();
    await cleanupTemporaryPath(root);
  }
}, 60_000);
