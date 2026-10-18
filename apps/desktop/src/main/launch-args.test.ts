import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseLaunchArgs, type LaunchArgs } from "./launch-args.js";

const TIME = "2026-10-08T15:00:00+09:00";
const NONE: LaunchArgs = { devControl: undefined, userDataDir: undefined, pluginsDir: undefined, charactersDir: undefined,
  characterId: undefined, eventPort: undefined, terrainSource: undefined, terrainWindows: undefined,
  permissionAnswer: undefined, pluginClock: undefined, invalidDevControl: false };

// One row per argument: [argument, field it feeds, value when honoured].
const ROWS: Array<[string, keyof LaunchArgs, LaunchArgs[keyof LaunchArgs], boolean]> = [
  ["--dev-control=check", "devControl", "check", false],
  ["--user-data-dir=C:/tmp/u", "userDataDir", "C:/tmp/u", false],
  ["--plugins-dir=C:/tmp/p", "pluginsDir", "C:/tmp/p", false],
  ["--characters-dir=C:/tmp/c", "charactersDir", "C:/tmp/c", false],
  ["--character=wolf-maid", "characterId", "wolf-maid", false],
  ["--terrain-source=test", "terrainSource", "test", false],
  ["--terrain-windows=[]", "terrainWindows", "[]", false],
  ["--permission-answer=allow", "permissionAnswer", "allow", false],
  [`--plugin-clock=${TIME}`, "pluginClock", TIME, false],
  ["--event-port=0", "eventPort", 0, true],
];

describe("parseLaunchArgs when installed (isPackaged)", () => {
  test.each(ROWS)("%s", (arg, field, value, allowed) => {
    const parsed = parseLaunchArgs(["app", "--dev-control=check", arg], { isPackaged: true, env: {} });
    expect(parsed).toEqual({ ...NONE, ...(allowed ? { [field]: value } : {}) });
  });

  test("DESKPET_USER_DATA_DIR is honoured", () => {
    expect(parseLaunchArgs(["app"], { isPackaged: true, env: { DESKPET_USER_DATA_DIR: "C:/tmp/iso" } }))
      .toEqual({ ...NONE, userDataDir: "C:/tmp/iso" });
  });

  test("--user-data-dir does not override DESKPET_USER_DATA_DIR", () => {
    expect(parseLaunchArgs(["app", "--user-data-dir=C:/other"], { isPackaged: true, env: { DESKPET_USER_DATA_DIR: "C:/tmp/iso" } }).userDataDir)
      .toBe("C:/tmp/iso");
  });

  test("every development argument together leaves only the event port and user data env", () => {
    const argv = ["app", ...ROWS.map(([arg]) => arg)];
    expect(parseLaunchArgs(argv, { isPackaged: true, env: { DESKPET_USER_DATA_DIR: "X" } }))
      .toEqual({ ...NONE, eventPort: 0, userDataDir: "X" });
  });
});

describe("parseLaunchArgs in development", () => {
  const dev = (argv: string[], env: Record<string, string> = {}) => parseLaunchArgs(["app", ...argv], { isPackaged: false, env });

  test("reads every argument with a valid dev control name", () => {
    expect(dev(["--dev-control=check", ...ROWS.slice(1).map(([arg]) => arg)])).toEqual({
      devControl: "check", userDataDir: "C:/tmp/u", pluginsDir: "C:/tmp/p", charactersDir: "C:/tmp/c",
      characterId: "wolf-maid", eventPort: 0, terrainSource: "test", terrainWindows: "[]",
      permissionAnswer: "allow", pluginClock: TIME, invalidDevControl: false });
  });

  test("test-only arguments and --user-data-dir need a valid dev control name", () => {
    const parsed = dev(["--user-data-dir=U", "--terrain-source=test", "--terrain-windows=[]", "--permission-answer=allow", `--plugin-clock=${TIME}`]);
    expect(parsed).toEqual(NONE);
  });

  test("an invalid dev control name is reported and disables the controls", () => {
    expect(dev(["--dev-control=a b", "--user-data-dir=U"])).toEqual({ ...NONE, invalidDevControl: true });
  });

  test("the last --character wins and an unparsable clock is dropped", () => {
    const parsed = dev(["--dev-control=check", "--character=a", "--character=b", "--plugin-clock=yesterday-ish"]);
    expect(parsed.characterId).toBe("b");
    expect(parsed.pluginClock).toBeUndefined();
  });

  test("--user-data-dir wins over the environment, which works alone", () => {
    expect(dev(["--dev-control=check", "--user-data-dir=U"], { DESKPET_USER_DATA_DIR: "E" }).userDataDir).toBe("U");
    expect(dev([], { DESKPET_USER_DATA_DIR: "E" }).userDataDir).toBe("E");
  });
});

describe("index.ts", () => {
  test("reads process.argv only through parseLaunchArgs", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source.match(/process\.argv/g)).toEqual(["process.argv"]);
    expect(source).toContain("parseLaunchArgs(process.argv");
  });
});
