import { expect, test } from "vitest";
import { DEV_CONTROL_NAME_PATTERN } from "../../scripts/control.mjs";

test("dev control names accept lowercase letters, digits and hyphens for 1–32 characters", () => {
  for (const name of ["a", "0", "a-1", "x".repeat(32)]) {
    expect(DEV_CONTROL_NAME_PATTERN.test(name)).toBe(true);
  }
  for (const name of ["", "A", "a_b", "a.b", "with space", "x".repeat(33)]) {
    expect(DEV_CONTROL_NAME_PATTERN.test(name)).toBe(false);
  }
});
