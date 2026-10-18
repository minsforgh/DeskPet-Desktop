import { expect, it } from "vitest";
import { Invocations } from "./invocation.js";

it("permits only an open invocation for its plugin within 60 seconds", () => {
  let time = 100;
  const invocations = new Invocations(() => time, () => "known");
  const id = invocations.begin("one", "one.run");
  expect(invocations.permits(id, "one")).toBe(true);
  expect(invocations.permits(id, "two")).toBe(false);
  expect(invocations.permits("invented", "one")).toBe(false);
  time += 60_000;
  expect(invocations.permits(id, "one")).toBe(true);
  time++;
  expect(invocations.permits(id, "one")).toBe(false);
  invocations.close(id);
  expect(invocations.permits(id, "one")).toBe(false);
  invocations.begin("one", "one.run");
  invocations.closePlugin("one");
  expect(invocations.permits(id, "one")).toBe(false);
});
