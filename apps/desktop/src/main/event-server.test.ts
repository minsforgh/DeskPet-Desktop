import { describe, expect, test } from "vitest";
import { decideRequest, shouldClearAuthOnClose, shouldClearAuthOnStart } from "./event-server.js";

const token = "a".repeat(64);
const headers = { authorization: `Bearer ${token}`, host: "127.0.0.1:7777", "content-type": "application/json" };
const decide = (method: string, path: string, overrides: Partial<typeof headers & { origin: string }> = {}) =>
  decideRequest(method, path, { ...headers, ...overrides }, 7777, token).status;

describe("HTTP request decision", () => {
  test("requires the exact bearer token", () => {
    expect(decide("POST", "/event", { authorization: "" })).toBe(401);
    expect(decide("POST", "/event", { authorization: "Bearer wrong" })).toBe(401);
    expect(decide("POST", "/event", { authorization: `Bearer ${token}` })).toBe(200);
  });
  test("rejects browser and DNS rebinding requests", () => {
    expect(decide("POST", "/event", { origin: "https://example.com" })).toBe(403);
    expect(decide("POST", "/event", { host: "evil.test:7777" })).toBe(403);
    expect(decide("POST", "/event", { host: "localhost:7777" })).toBe(200);
  });
  test("routes methods and content types", () => {
    expect(decide("POST", "/event")).toBe(200);
    expect(decide("GET", "/status")).toBe(200);
    expect(decide("POST", "/action/x")).toBe(200);
    expect(decide("GET", "/event")).toBe(405);
    expect(decide("POST", "/status")).toBe(405);
    expect(decide("POST", "/event", { "content-type": "text/plain" })).toBe(415);
    expect(decide("GET", "/missing")).toBe(404);
  });
});

describe("event auth file cleanup", () => {
  const ownPid = 100;
  const otherPid = 200;

  test("startup preserves another live process's port", () => {
    expect(shouldClearAuthOnStart(otherPid, ownPid, () => true)).toBe(false);
    expect(shouldClearAuthOnStart(otherPid, ownPid, () => false)).toBe(true);
    expect(shouldClearAuthOnStart(undefined, ownPid, () => true)).toBe(true);
    expect(shouldClearAuthOnStart(0, ownPid, () => true)).toBe(true);
    expect(shouldClearAuthOnStart(ownPid, ownPid, () => true)).toBe(true);
  });

  test("close clears only a port written by its own pid", () => {
    expect(shouldClearAuthOnClose(ownPid, ownPid)).toBe(true);
    expect(shouldClearAuthOnClose(otherPid, ownPid)).toBe(false);
    expect(shouldClearAuthOnClose(undefined, ownPid)).toBe(false);
  });
});
