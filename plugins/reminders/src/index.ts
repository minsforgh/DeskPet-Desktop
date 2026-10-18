import type { LinePetEvent } from "@deskpet/core";
import type { PluginDefinition } from "@deskpet/plugin-sdk/v2";
import type { ConfigSchema, Disposable } from "@deskpet/plugin-sdk";
import { evaluateRules } from "./schedule.js";
import type { ReminderRule } from "./schedule.js";

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      title: "알림 규칙",
      description: "각 규칙: id, time(24시간제 HH:MM), 선택 days(0=일요일~6=토요일, 비우면 매일), text, 선택 priority",
      default: [],
      items: {
        type: "object",
        properties: {
          id: { type: "string", title: "ID" },
          time: { type: "string", title: "시각(HH:MM)", description: "24시간제 HH:MM (예: 오후 11시 = 23:00)" },
          days: { type: "array", title: "요일", items: { type: "number" }, enum: [0, 1, 2, 3, 4, 5, 6] },
          text: { type: "string", title: "말풍선 문구" },
          priority: { type: "string", title: "우선순위", enum: ["low", "normal", "high", "urgent"] },
        },
        required: ["id", "time", "text"],
      },
    },
  },
  required: ["rules"],
};

/** Builds the "M H * * D" cron string; days omitted means every day. */
function toCron(rule: ReminderRule): string {
  const days = rule.days === undefined ? "*" : rule.days.join(",");
  return `${rule.time.slice(3, 5)} ${rule.time.slice(0, 2)} * * ${days}`;
}

/** Leaves priority absent when unset: the core rejects events that carry priority: undefined. */
function notifyEvent(rule: ReminderRule): LinePetEvent {
  const message = Array.from(rule.text, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
  }).join("");
  const event: LinePetEvent = { source: "reminders", type: "notify", key: rule.id,
    line: { id: "reminders.rule", vars: { message } } };
  if (rule.priority !== undefined) event.priority = rule.priority;
  return event;
}

let teardown: (() => void) | undefined;

export default {
  configSchema,
  activate(ctx) {
    teardown?.();
    teardown = undefined;
    let schedules: Disposable[] = [];

    const disposeSchedules = (): void => {
      for (const schedule of schedules) schedule.dispose();
      schedules = [];
    };

    const applyRules = (input: unknown): void => {
      disposeSchedules();
      if (!Array.isArray(input)) {
        ctx.log.warn("reminders: config.rules must be an array; no rules registered");
        return;
      }
      evaluateRules(input).forEach((status, index) => {
        if (!status.ok) {
          ctx.log.warn(`reminders: skipping rules[${index}]: ${status.errors.join("; ")}`);
          return;
        }
        const { rule } = status;
        schedules.push(ctx.schedule.at(toCron(rule), async () => {
          ctx.emit(notifyEvent(rule));
        }));
      });
    };

    applyRules(ctx.config.rules);
    const configListener = ctx.onConfigChange((next) => applyRules(next.rules));

    teardown = () => {
      configListener.dispose();
      disposeSchedules();
    };
  },
  deactivate() {
    teardown?.();
    teardown = undefined;
  },
} satisfies PluginDefinition;
