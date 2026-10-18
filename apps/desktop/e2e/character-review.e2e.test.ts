import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readPng, writePng } from "../../../tools/sprite-pipeline/src/png.js";
import { DesktopApp } from "./desktop-app.js";
import { BADGE_TOP_MARGIN, petWindowY } from "./helpers/pet-window.js";
import { cleanupTemporaryPath } from "./test-cleanup.js";

type Point = { x: number; y: number };
type State = { foot: Point; bounds: { width: number; height: number }; character: { id: string; loaded: boolean } };
let temporary: string;
let characters: string;
let userData: string;
let app: DesktopApp;

async function makePack(directory: string, id: string, scale: number, anchorX: number): Promise<void> {
  await mkdir(join(directory, "sheets"), { recursive: true });
  const pixels = new Uint8Array(256 * 256 * 4);
  const paint = (x: number, y: number): void => {
    const offset = (y * 256 + x) * 4;
    pixels.set([255, 0, 0, 255], offset);
  };
  for (let y = 230; y <= 240; y += 1)
    for (let x = anchorX - 5; x <= anchorX + 5; x += 1) paint(x, y);
  for (let y = 0; y < 8; y += 1) for (let x = 250; x < 256; x += 1) paint(x, y);
  await writeFile(join(directory, "sheets", "idle.png"), writePng({ width: 256, height: 256, pixels }));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    id, name: id, apiVersion: "1", cellSize: [256, 256], anchor: [anchorX, 240], scale,
    states: { idle: { sheet: "sheets/idle.png", frames: 1, fps: 8, loop: true } }, fallbacks: {},
  }));
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "deskpet-review-"));
  characters = join(temporary, "characters");
  userData = join(temporary, "user-data");
  await makePack(join(characters, "large"), "large", 1, 128);
  await makePack(join(characters, "small"), "small", 0.5, 32);
  app = await DesktopApp.launch(userData, [`--characters-dir=${characters}`, "--character=large", "--terrain-source=off"]);
}, 30000);

afterAll(async () => {
  try { if (app) await app.dispose(); }
  finally { if (temporary) await cleanupTemporaryPath(temporary, app ? [app] : []); }
});

// With the 20-launch lifecycle check running in parallel, four measured runs reached
// 4,469 ms (p99/max), and the former 5 s limit timed out once under contention.
test("resizing and off-center rendering preserve the foot and edge pixel across restart", async () => {
  await app.request({ cmd: "moveBy", dx: -300, dy: -300 });
  const original = await app.request({ cmd: "state" }) as State;
  const switched = await app.request({ cmd: "setCharacter", character: "small" }) as State["character"];
  expect(switched).toMatchObject({ id: "small", loaded: true });
  const small = await app.request({ cmd: "state" }) as State;
  expect(small.foot).toEqual(original.foot);
  expect(small.bounds).toMatchObject({ width: 128, height: 128 + BADGE_TOP_MARGIN });
  const screenshot = join(temporary, "edge.png");
  await app.request({ cmd: "screenshot", path: screenshot });
  const image = readPng(await readFile(screenshot));
  const edgeX = Math.floor(127.5 * image.width / small.bounds.width);
  const edgeY = Math.floor(petWindowY(2.5) * image.height / small.bounds.height);
  expect(image.pixels[(edgeY * image.width + edgeX) * 4 + 3]).toBe(255);
  await app.quit();
  app = await DesktopApp.launch(userData, [`--characters-dir=${characters}`, "--character=small", "--terrain-source=off"]);
  const restarted = await app.request({ cmd: "state" }) as State;
  expect(restarted.foot).toEqual(original.foot);
}, 8000);

test("concurrent selections return their own result and finish on the later pack", async () => {
  const responses = await new Promise<Map<number, { ok: boolean; result: State["character"] }>>((resolveResponses, rejectResponses) => {
    const socket = connect(`\\\\.\\pipe\\deskpet-dev-${app.name}`);
    const received = new Map<number, { ok: boolean; result: State["character"] }>();
    let pending = "";
    const timer = setTimeout(() => { socket.destroy(); rejectResponses(new Error("Concurrent character requests timed out")); }, 5000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(
      JSON.stringify({ id: 1001, cmd: "setCharacter", character: "large" }) + "\n" +
      JSON.stringify({ id: 1002, cmd: "setCharacter", character: "small" }) + "\n"));
    socket.on("data", (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const response = JSON.parse(pending.slice(0, newline)) as { id: number; ok: boolean; result: State["character"] };
        received.set(response.id, response);
        pending = pending.slice(newline + 1);
        if (received.size === 2) { clearTimeout(timer); socket.destroy(); resolveResponses(received); return; }
        newline = pending.indexOf("\n");
      }
    });
    socket.on("error", rejectResponses);
  });
  const large = responses.get(1001)?.result;
  const small = responses.get(1002)?.result;
  expect(responses.get(1001)?.ok).toBe(true);
  expect(responses.get(1002)?.ok).toBe(true);
  expect(large).toMatchObject({ id: "large", loaded: true });
  expect(small).toMatchObject({ id: "small", loaded: true });
  expect((await app.request({ cmd: "state" }) as State).character.id).toBe("small");
});

test("loader rejects junction pack and sheet folders and an oversized sheet", async () => {
  const outside = join(temporary, "outside");
  await makePack(outside, "linked", 1, 128);
  await symlink(outside, join(characters, "linked"), "junction");
  expect(await app.request({ cmd: "setCharacter", character: "linked" })).toMatchObject({ loaded: false });
  const sheetsOutside = join(temporary, "outside-sheets");
  await cp(join(outside, "sheets"), sheetsOutside, { recursive: true });
  const sheetLink = join(characters, "sheet-link");
  await makePack(sheetLink, "sheet-link", 1, 128);
  await cleanupTemporaryPath(join(sheetLink, "sheets"));
  await symlink(sheetsOutside, join(sheetLink, "sheets"), "junction");
  expect(await app.request({ cmd: "setCharacter", character: "sheet-link" })).toMatchObject({ loaded: false });
  const oversize = join(characters, "oversize");
  await makePack(oversize, "oversize", 1, 128);
  await writeFile(join(oversize, "sheets", "idle.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
  expect(await app.request({ cmd: "setCharacter", character: "oversize" })).toMatchObject({ loaded: false });
  await app.request({ cmd: "setCharacter", character: "small" });
});

test("dispose reports an unexpected abnormal exit", async () => {
  const killed = await DesktopApp.launch(join(temporary, "killed-user-data"),
    [`--characters-dir=${characters}`, "--character=small", "--terrain-source=off"]);
  const exited = new Promise<void>((resolveExit) => killed.child.once("exit", () => resolveExit()));
  killed.child.kill("SIGKILL");
  await exited;
  await expect(killed.dispose()).rejects.toThrow(/Electron exited/);
  await killed.dispose({ expectedAbnormalExit: true });
});
