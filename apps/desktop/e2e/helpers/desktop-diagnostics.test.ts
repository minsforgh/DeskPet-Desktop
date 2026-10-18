import { expect, test } from "vitest";
import { descendantsOf, DesktopDiagnostics, type ProcessRow } from "./desktop-diagnostics.js";

test("failure messages include fake child PID, phase times, and the last control command", async () => {
  const diagnostics = new DesktopDiagnostics({ pid: 1234 }, 1000);
  diagnostics.markLaunch(7);
  await diagnostics.measure("waitReady", async () => {});
  diagnostics.control("checkerWindowsForTest", 3000, false);
  diagnostics.setDescendants([1235, 1236]);
  const message = diagnostics.failure("Dev control timed out").message;
  expect(message).toContain("Dev control timed out");
  expect(message).toContain("main PID=1234; descendant PIDs=1235,1236");
  expect(message).toContain("launch=7ms");
  expect(message).toContain("waitReady=");
  expect(message).toContain("quit=-ms, forceStop=-ms");
  expect(message).toContain("last control: checkerWindowsForTest=3000ms (failed)");
  for (const failure of ["Electron did not quit", "connect ENOENT"]) {
    expect(diagnostics.failure(failure).message).toContain(`${failure}; main PID=1234`);
    expect(diagnostics.failure(failure).message).toContain("last control: checkerWindowsForTest=3000ms (failed)");
  }
});

test("remaining process tree excludes a user's separate DeskPet and older reused PIDs", () => {
  const rows: ProcessRow[] = [
    { pid: 11, ppid: 10, startedAt: 1010, name: "electron.exe" },
    { pid: 12, ppid: 11, startedAt: 1020, name: "electron.exe" },
    { pid: 13, ppid: 10, startedAt: 900, name: "electron.exe" },
    { pid: 50, ppid: 49, startedAt: 1100, name: "electron.exe" },
  ];
  expect(descendantsOf(rows, 10, 1000).map((row) => row.pid)).toEqual([11, 12]);
});

test("failure keeps the original error code, errno, syscall and cause", () => {
  const diagnostics = new DesktopDiagnostics({ pid: 1234 }, 1000);
  const original = Object.assign(new Error("connect ENOENT"), { code: "ENOENT", errno: -4058, syscall: "connect" });
  const wrapped = diagnostics.failure(original.message, original) as NodeJS.ErrnoException;
  expect(wrapped.code).toBe("ENOENT");
  expect(wrapped.errno).toBe(-4058);
  expect(wrapped.syscall).toBe("connect");
  expect(wrapped.cause).toBe(original);
  expect(wrapped.message).toContain("main PID=1234");
  expect(diagnostics.failure("plain").cause).toBeUndefined();
});
