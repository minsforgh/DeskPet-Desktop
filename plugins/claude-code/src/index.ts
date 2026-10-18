import { definePlugin } from "@deskpet/plugin-sdk";
import type { ConfigSchema, Disposable } from "@deskpet/plugin-sdk";

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    enabled: {
      type: "boolean",
      title: "Claude Code 알림 사용",
      description: "Claude Code hook 반응 규칙을 사용합니다.",
      default: true,
    },
  },
  required: ["enabled"],
};

let teardown: (() => void) | undefined;

export default definePlugin({
  configSchema,
  activate(ctx) {
    teardown?.();
    teardown = undefined;
    let rules: Disposable[] = [];

    const applyConfig = (enabled: unknown): void => {
      for (const rule of rules) rule.dispose();
      rules = [];
      if (enabled === false) return;
      rules.push(
        ctx.addReactionRule({
          match: { source: "claude-code", type: "notify", mood: "happy" },
          play: "happy",
        }),
        ctx.addReactionRule({
          match: { source: "claude-code", type: "notify", mood: "worried" },
          play: "worried",
        }),
      );
    };

    applyConfig(ctx.config.enabled ?? true);
    const configListener = ctx.onConfigChange((next) => applyConfig(next.enabled ?? true));
    teardown = () => {
      configListener.dispose();
      for (const rule of rules) rule.dispose();
      rules = [];
    };
  },
  deactivate() {
    teardown?.();
    teardown = undefined;
  },
});
