import type { Disposable } from "@deskpet/plugin-sdk";
import type { PluginDefinition } from "@deskpet/plugin-sdk/v2";
import { createMonitor } from "./monitor.js";

let teardown: (() => void) | undefined;

export default {
  activate(ctx) {
    teardown?.();
    const monitor = createMonitor(ctx);
    const disposables: Disposable[] = [];

    disposables.push(ctx.registerAction("jungle.show-login", () => monitor.showLogin()));
    disposables.push(ctx.registerAction("jungle.check-now", () => monitor.checkNow(true)));
    disposables.push(ctx.registerAction("jungle.open-attendance", () => monitor.openAttendance()));

    disposables.push(ctx.addTrayItem({ id: "jungle.show-login", label: "정글 LMS 로그인…", action: "jungle.show-login" }));
    disposables.push(ctx.addTrayItem({ id: "jungle.check-now", label: "정글 출석 지금 확인", action: "jungle.check-now" }));
    disposables.push(ctx.addTrayItem({ id: "jungle.open-attendance", label: "정글 출석 페이지 열기", action: "jungle.open-attendance" }));

    teardown = () => {
      for (const disposable of disposables) disposable.dispose();
      monitor.dispose();
    };
  },
  deactivate() {
    teardown?.();
    teardown = undefined;
  },
} satisfies PluginDefinition;
