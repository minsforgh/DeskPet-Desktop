import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createOrcaService } from "./orca-service.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(fail = false) {
  const root = await mkdtemp(join(tmpdir(), "deskpet-orca-service-"));
  roots.push(root);
  const userData = join(root, "user-data");
  await mkdir(userData);
  const script = join(root, "fake-orca-cli.mjs");
  await copyFile(new URL("../../e2e/fake-orca-cli.mjs", import.meta.url), script);
  await writeFile(join(root, "state.json"), JSON.stringify({ newWorker: false, gate: false, resolved: false, gateId: "gate_1", fail }));
  await writeFile(join(root, "argv.jsonl"), "");
  const service = createOrcaService(userData, { PATH: "" }, () => 1_000);
  await service.setExecutableForTest(script);
  const calls = async () => (await readFile(join(root, "argv.jsonl"), "utf8")).trim().split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { args: string[] }).args);
  return { root, userData, service, calls };
}

test("coalesces one plugin's snapshots and preserves separate ledger namespaces", async () => {
  const { root, userData, service, calls } = await fixture();
  const [first, second] = await Promise.all([service.snapshot("first"), service.snapshot("first")]);
  expect(first).toEqual(second);
  expect(first.availability).toBe("ready");
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(1);
  expect((await service.snapshot("second")).availability).toBe("ready");
  const ledger = JSON.parse(await readFile(join(userData, "orca-notification-ledger.json"), "utf8")) as { version: number; keys: string[]; gates: unknown[] };
  expect(ledger.version).toBe(2);
  expect(ledger.gates).toEqual([]);
  expect(ledger.keys.some((key) => key.startsWith("first|"))).toBe(true);
  expect(ledger.keys.some((key) => key.startsWith("second|"))).toBe(true);
  expect(JSON.stringify(ledger)).not.toContain("Fixture task");
  expect((await readFile(join(root, "argv.jsonl"), "utf8")).includes("gate-resolve")).toBe(false);
});

test("backs off failed reads without launching another CLI process", async () => {
  const { service, calls } = await fixture(true);
  expect((await service.snapshot("wire")).availability).toBe("unavailable");
  expect((await service.snapshot("wire")).availability).toBe("unavailable");
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(1);
});

test("test clock advances the retry boundary without changing the backoff", async () => {
  const { service, calls } = await fixture(true);
  service.setTimeForTest(1_000);
  expect((await service.snapshot("wire")).availability).toBe("unavailable");
  service.setTimeForTest(30_999);
  expect((await service.snapshot("wire")).availability).toBe("unavailable");
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(1);
  service.setTimeForTest(31_000);
  expect((await service.snapshot("wire")).availability).toBe("unavailable");
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(2);
});

test("returns the gate result from the fake CLI to the plugin boundary", async () => {
  const { root, service, calls } = await fixture();
  await writeFile(join(root, "state.json"), JSON.stringify({ newWorker: false, gate: true,
    resolved: false, gateId: "gate_1" }));
  await service.snapshot("orca");
  expect(await service.resolveGate("orca", "gate_1", "yes")).toBe("resolved");
  expect((await calls()).filter((args) => args[1] === "gate-resolve")).toHaveLength(1);
});

test("migrates v1 keys and pending gate timing into the v2 ledger", async () => {
  const { root, userData, service, calls } = await fixture();
  const gateKey = JSON.stringify(["run_1", "gate_1", "gate"]);
  await writeFile(join(userData, "orca-notification-ledger.json"), JSON.stringify({ version: 1,
    keys: ["orca|" + JSON.stringify(["orca-reader", "baseline"]), "orca|" + gateKey] }));
  await writeFile(join(root, "state.json"), JSON.stringify({ newWorker: false, gate: true, resolved: false, gateId: "gate_1" }));
  service.setTimeForTest(10_000);
  expect((await service.snapshot("orca")).notifications.filter((item) => item.gateId)).toEqual([]);
  const migrated = JSON.parse(await readFile(join(userData, "orca-notification-ledger.json"), "utf8")) as {
    version: number; keys: string[]; gates: Array<{ runId: string; gateId: string; lastAlertedAt: number; repeatCount: number; muted: boolean }> };
  expect(migrated).toMatchObject({ version: 2, gates: [{ runId: "orca|run_1", gateId: "gate_1",
    lastAlertedAt: 10_000, repeatCount: 0, muted: false }] });
  expect(migrated.keys).toContain("orca|" + gateKey);
  expect((await calls()).filter((args) => args[1] === "gate-resolve")).toHaveLength(0);
});

// Seven fake-CLI snapshots reached 5.02 s on this PC under the full unit-file run.
test("mute action changes only local gate state and survives a new service", async () => {
  const { root, userData, service, calls } = await fixture();
  await service.snapshot("orca");
  await service.snapshot("other");
  await writeFile(join(root, "state.json"), JSON.stringify({ newWorker: false, gate: true, resolved: false, gateId: "gate_1" }));
  service.setTimeForTest(31_000);
  expect((await service.snapshot("orca")).notifications.some((item) => item.gateId === "gate_1")).toBe(true);
  expect((await service.snapshot("other")).notifications.some((item) => item.gateId === "gate_1")).toBe(true);
  const before = (await calls()).length;
  await service.muteGate("orca", "gate_1");
  expect((await calls()).length).toBe(before);
  service.setTimeForTest(331_000);
  expect((await service.snapshot("orca")).notifications.some((item) => item.gateId === "gate_1")).toBe(false);
  expect((await service.snapshot("other")).notifications.some((item) => item.gateId === "gate_1")).toBe(true);
  const restarted = createOrcaService(userData, { PATH: "" }, () => 331_000);
  await restarted.setExecutableForTest(join(root, "fake-orca-cli.mjs"));
  expect((await restarted.snapshot("orca")).notifications.some((item) => item.gateId === "gate_1")).toBe(false);
  const ledger = JSON.parse(await readFile(join(userData, "orca-notification-ledger.json"), "utf8")) as {
    gates: Array<{ runId: string; gateId: string; muted: boolean }> };
  expect(ledger.gates.find((gate) => gate.runId === "orca|run_1")).toMatchObject({ gateId: "gate_1", muted: true });
  expect(ledger.gates.find((gate) => gate.runId === "other|run_1")).toMatchObject({ gateId: "gate_1", muted: false });
}, 15_000);

test("damaged v2 ledger stays unavailable instead of resetting pending alerts", async () => {
  const { userData, service } = await fixture();
  const path = join(userData, "orca-notification-ledger.json");
  const damaged = JSON.stringify({ version: 2, keys: [], gates: [{ runId: "orca|run_1", gateId: "gate_1",
    lastAlertedAt: "invalid", repeatCount: 0, muted: false }] });
  await writeFile(path, damaged);
  expect((await service.snapshot("orca")).availability).toBe("unavailable");
  expect(await readFile(path, "utf8")).toBe(damaged);
});

test("WAL change triggers a snapshot after the 3 second limit without replaying cached notifications", async () => {
  const { root, service, calls } = await fixture();
  const directory = join(root, "orca");
  await mkdir(directory);
  const wal = join(directory, "orchestration.db-wal");
  await writeFile(wal, "");
  await service.setWalDirectoryForTest(directory);
  service.setTimeForTest(1_000);
  await service.snapshot("orca");
  expect(service.fastDetectionStatus()).toEqual({ enabled: true });
  await writeFile(join(root, "state.json"), JSON.stringify({ newWorker: true, gate: false, resolved: false, gateId: "gate_1" }));
  await utimes(wal, new Date(10_000), new Date(10_000));
  service.setTimeForTest(1_999);
  expect((await service.snapshot("orca")).notifications).toEqual([]);
  service.setTimeForTest(2_000);
  expect((await service.snapshot("orca")).notifications).toEqual([]);
  service.setTimeForTest(4_000);
  expect((await service.snapshot("orca")).notifications.some((item) => item.dispatchId === "ctx_new")).toBe(true);
  expect((await service.snapshot("orca")).notifications).toEqual([]);
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(2);
  service.setTimeForTest(34_000);
  await service.snapshot("orca");
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(3);
});

test("a WAL change during a CLI read remains pending after coalesced requests", async () => {
  const { root, userData, calls } = await fixture();
  const directory = join(root, "orca");
  await mkdir(directory);
  await writeFile(join(directory, "orchestration.db-wal"), "");
  let probes = 0;
  const service = createOrcaService(userData, { PATH: "" }, () => 1_000, async (path) =>
    Object.assign(await stat(path), { mtimeMs: ++probes === 1 ? 1_000 : 2_000 }));
  await service.setExecutableForTest(join(root, "fake-orca-cli.mjs"));
  await service.setWalDirectoryForTest(directory);
  service.setTimeForTest(1_000);
  await Promise.all([service.snapshot("orca"), service.snapshot("orca")]);
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(1);
  service.setTimeForTest(4_000);
  await service.snapshot("orca");
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(2);
});

test("missing and linked WAL disable fast detection until a 30 second recheck", async () => {
  const { root, service, calls } = await fixture();
  const directory = join(root, "orca");
  await mkdir(directory);
  await service.setWalDirectoryForTest(directory);
  service.setTimeForTest(1_000);
  await service.snapshot("orca");
  expect(service.fastDetectionStatus()).toEqual({ enabled: false, message: "빠른 감지 꺼짐" });
  const wal = join(directory, "orchestration.db-wal");
  await rm(directory, { recursive: true });
  await symlink(root, directory, "junction");
  service.setTimeForTest(31_000);
  await service.snapshot("orca");
  expect(service.fastDetectionStatus().enabled).toBe(false);
  await rm(directory);
  await mkdir(directory);
  await writeFile(wal, "");
  service.setTimeForTest(61_000);
  await service.snapshot("orca");
  expect(service.fastDetectionStatus().enabled).toBe(true);
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(3);
  await rm(wal);
  service.setTimeForTest(62_000);
  await service.snapshot("orca");
  expect(service.fastDetectionStatus().enabled).toBe(false);
});

test("checks an enabled WAL once per second and rechecks a failed path after 30 seconds", async () => {
  const { root, service, calls } = await fixture();
  const directory = join(root, "orca");
  await mkdir(directory);
  const wal = join(directory, "orchestration.db-wal");
  await writeFile(wal, "");
  await service.setWalDirectoryForTest(directory);
  service.setTimeForTest(1_000);
  await service.snapshot("orca");
  await rm(wal);
  service.setTimeForTest(1_999);
  await service.snapshot("orca");
  expect(service.fastDetectionStatus().enabled).toBe(true);
  service.setTimeForTest(2_000);
  await service.snapshot("orca");
  expect(service.fastDetectionStatus().enabled).toBe(false);
  await mkdir(wal);
  service.setTimeForTest(31_999);
  await service.snapshot("orca");
  expect(service.fastDetectionStatus().enabled).toBe(false);
  service.setTimeForTest(32_000);
  await service.snapshot("orca");
  expect(service.fastDetectionStatus().enabled).toBe(false);
  await rm(wal, { recursive: true });
  await writeFile(wal, "");
  service.setTimeForTest(62_000);
  await service.snapshot("orca");
  expect(service.fastDetectionStatus().enabled).toBe(true);
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(3);
});

test("missing APPDATA leaves the 30 second CLI safety check available and recovers", async () => {
  const { root, userData, calls } = await fixture();
  const env: NodeJS.ProcessEnv = { PATH: "" };
  const service = createOrcaService(userData, env, () => 1_000);
  await service.setExecutableForTest(join(root, "fake-orca-cli.mjs"));
  service.setTimeForTest(1_000);
  await service.snapshot("orca");
  expect(service.fastDetectionStatus()).toEqual({ enabled: false, message: "빠른 감지 꺼짐" });
  service.setTimeForTest(30_999);
  await service.snapshot("orca");
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(1);
  service.setTimeForTest(31_000);
  const directory = join(root, "orca");
  await mkdir(directory);
  await writeFile(join(directory, "orchestration.db-wal"), "");
  env.APPDATA = root;
  await service.snapshot("orca");
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(2);
  expect(service.fastDetectionStatus().enabled).toBe(true);
});

test.each(["EACCES", "EIO"])("WAL stat %s disables fast detection without losing CLI safety checks", async (code) => {
  const { root, userData, calls } = await fixture();
  const directory = join(root, "orca");
  await mkdir(directory);
  await writeFile(join(directory, "orchestration.db-wal"), "");
  const service = createOrcaService(userData, { PATH: "" }, () => 1_000,
    async () => { throw Object.assign(new Error("wal-stat-failed"), { code }); });
  await service.setExecutableForTest(join(root, "fake-orca-cli.mjs"));
  await service.setWalDirectoryForTest(directory);
  service.setTimeForTest(1_000);
  await service.snapshot("orca");
  expect(service.fastDetectionStatus()).toEqual({ enabled: false, message: "빠른 감지 꺼짐" });
  service.setTimeForTest(31_000);
  await service.snapshot("orca");
  expect((await calls()).filter((args) => args[1] === "run-list")).toHaveLength(2);
});

test("WAL override rejects traversal and a directory link", async () => {
  const { root, service } = await fixture();
  const directory = join(root, "orca");
  await mkdir(directory);
  await expect(service.setWalDirectoryForTest(join(root, "..", "orca"))).rejects.toThrow();
  await expect(service.setWalDirectoryForTest(join(root, "outside"))).rejects.toThrow();
  await expect(service.setWalDirectoryForTest(join(tmpdir(), "orca"))).rejects.toThrow();
  const link = join(root, "linked");
  await symlink(directory, link, "junction");
  await expect(service.setWalDirectoryForTest(link)).rejects.toThrow();
});

test("a WAL change reads only active runs, and the safety check or a failure goes back to every run", async () => {
  const { root, service, calls } = await fixture();
  const extraRuns = [{ id: "run_old", active: false }, { id: "run_busy", active: true }];
  const state = (extra: object = {}) => writeFile(join(root, "state.json"), JSON.stringify({ newWorker: false, gate: false, resolved: false, gateId: "gate_1", extraRuns, ...extra }));
  await state();
  const directory = join(root, "orca");
  await mkdir(directory);
  const wal = join(directory, "orchestration.db-wal");
  await writeFile(wal, "");
  await service.setWalDirectoryForTest(directory);
  const count = async (id: string) => (await calls()).filter((args) => args.includes(id)).length;
  service.setTimeForTest(1_000);
  await service.snapshot("orca");
  const fullOld = await count("run_old");
  expect(fullOld).toBe(3);
  expect(await count("run_busy")).toBe(3);
  await utimes(wal, new Date(10_000), new Date(10_000));
  service.setTimeForTest(5_000);
  expect((await service.snapshot("orca")).runs.map((run) => run.id)).toEqual(["run_1", "run_completed", "run_old", "run_busy"]);
  expect(await count("run_old")).toBe(fullOld);
  expect(await count("run_busy")).toBe(6);
  await utimes(wal, new Date(20_000), new Date(20_000));
  service.setTimeForTest(32_000);
  await service.snapshot("orca");
  expect(await count("run_old")).toBe(fullOld + 3);
  await state({ fail: true });
  await utimes(wal, new Date(30_000), new Date(30_000));
  service.setTimeForTest(36_000);
  expect((await service.snapshot("orca")).availability).toBe("unavailable");
  await state();
  service.setTimeForTest(70_000);
  await service.snapshot("orca");
  expect(await count("run_old")).toBe(fullOld + 6);
  expect((await calls()).some((args) => args[1] === "gate-resolve")).toBe(false);
});
