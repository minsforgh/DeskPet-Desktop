import { DEV_CONTROL_NAME_PATTERN } from "../../scripts/control.mjs";

export interface LaunchArgs {
  /** Dev control name (named pipe suffix); set only for an unpackaged run with a valid name. */
  devControl: string | undefined;
  /** Isolated userData folder: `DESKPET_USER_DATA_DIR` always; `--user-data-dir=` only with a valid dev control name. */
  userDataDir: string | undefined;
  pluginsDir: string | undefined;
  charactersDir: string | undefined;
  characterId: string | undefined;
  /** Parsed `--event-port=` (may be NaN or out of range; the caller validates). Undefined when not given. */
  eventPort: number | undefined;
  terrainSource: string | undefined;
  terrainWindows: string | undefined;
  permissionAnswer: string | undefined;
  pluginClock: string | undefined;
  /** The dev control name was given but is not valid (unpackaged run only), so the caller can report it. */
  invalidDevControl: boolean;
}

/**
 * ADR-0010 §5: the only place that reads the process arguments. An installed build (isPackaged) ignores every
 * development argument; only `DESKPET_USER_DATA_DIR` and `--event-port=` are honoured there (ADR-0010 question 7).
 */
export function parseLaunchArgs(argv: readonly string[], options: { isPackaged: boolean; env: Record<string, string | undefined> }): LaunchArgs {
  const value = (name: string): string | undefined => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const envUserData = options.env.DESKPET_USER_DATA_DIR;
  const userDataEnv = envUserData !== undefined && envUserData !== "" ? envUserData : undefined;
  const portArg = value("event-port");
  const eventPort = portArg === undefined ? undefined : Number(portArg);
  const common = { eventPort };
  if (options.isPackaged) {
    return { ...common, devControl: undefined, userDataDir: userDataEnv, pluginsDir: undefined, charactersDir: undefined,
      characterId: undefined, terrainSource: undefined, terrainWindows: undefined, permissionAnswer: undefined,
      pluginClock: undefined, invalidDevControl: false };
  }
  const controlName = value("dev-control");
  const devControl = controlName !== undefined && DEV_CONTROL_NAME_PATTERN.test(controlName) ? controlName : undefined;
  const userDataArg = value("user-data-dir");
  const clock = argv.find((arg) => arg.startsWith("--plugin-clock="))?.slice(15);
  return { ...common, devControl,
    userDataDir: devControl !== undefined && userDataArg ? userDataArg : userDataEnv,
    pluginsDir: value("plugins-dir"), charactersDir: value("characters-dir"),
    characterId: argv.filter((arg) => arg.startsWith("--character=")).at(-1)?.slice(12),
    terrainSource: devControl !== undefined ? value("terrain-source") : undefined,
    terrainWindows: devControl !== undefined ? value("terrain-windows") : undefined,
    permissionAnswer: devControl !== undefined ? value("permission-answer") : undefined,
    pluginClock: devControl !== undefined && clock !== undefined && !Number.isNaN(Date.parse(clock)) ? clock : undefined,
    invalidDevControl: controlName !== undefined && devControl === undefined };
}
