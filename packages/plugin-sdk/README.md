# Plugin SDK test context

Import the test harness from `@deskpet/plugin-sdk/testing`. It records plugin calls and runs callbacks only when the test asks it to. Network and shell calls require explicit substitutes; the defaults throw without contacting external services.

```ts
import { createTestContext } from "@deskpet/plugin-sdk/testing";

const test = createTestContext({
  manifest: { contributes: { actions: ["hello.wave"] }, permissions: { secrets: true } },
});
plugin.activate(test.ctx);
await test.runAction("hello.wave");
expect(test.events).toContainEqual({
  source: "hello", type: "react", mood: "happy", text: "안녕!",
});
```

Use `runEvery`, `runAt`, `runOnResume`, and `changeConfig` to trigger registered callbacks. `windowResponses` provides fake `getJson` results by path, while each test window records its requested `paths`.
Declare `manifest.permissions.secrets: true` before calling `ctx.secrets.get` or `ctx.secrets.set`; the test context rejects undeclared access.
