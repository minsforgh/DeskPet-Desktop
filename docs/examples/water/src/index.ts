import type { PetEvent } from "@deskpet/core";
import type { ConfigSchema, Disposable, PluginDefinition } from "@deskpet/plugin-sdk";

const DEFAULT_INTERVAL = 60;
const DEFAULT_GOAL = 8;

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    intervalMinutes: {
      type: "number",
      title: "알림 간격(분)",
      description: "1 이상. 바꾸면 바로 적용된다",
      default: DEFAULT_INTERVAL,
    },
    dailyGoal: {
      type: "number",
      title: "하루 목표(잔)",
      description: "1 이상의 정수",
      default: DEFAULT_GOAL,
    },
  },
};

const remindEvent: PetEvent = {
  source: "water",
  type: "notify",
  key: "water",
  text: "물 한 잔 어때요?",
  mood: "neutral",
  priority: "normal",
  ttlMs: 10 * 60 * 1000,
  actions: [{ label: "마셨어", action: "water.drank" }],
};

function readSettings(config: Readonly<Record<string, unknown>>) {
  const minutes =
    typeof config.intervalMinutes === "number" && config.intervalMinutes >= 1 ? config.intervalMinutes : DEFAULT_INTERVAL;
  const goal =
    typeof config.dailyGoal === "number" && Number.isInteger(config.dailyGoal) && config.dailyGoal >= 1
      ? config.dailyGoal
      : DEFAULT_GOAL;
  return { ms: Math.max(1000, Math.round(minutes * 60_000)), goal };
}

const today = (): string => new Date().toDateString();

const plugin: PluginDefinition = {
  configSchema,
  activate(ctx) {
    let current = readSettings(ctx.config);
    let day = today();
    let count = 0;
    let celebrated = false;
    let timer: Disposable | undefined;

    const rollDay = (): void => {
      if (today() !== day) {
        day = today();
        count = 0;
        celebrated = false;
      }
    };

    const start = (): void => {
      timer?.dispose();
      timer = ctx.schedule.every(current.ms, async () => {
        ctx.emit(remindEvent);
      });
    };
    start();

    ctx.onConfigChange((next) => {
      const prev = current;
      current = readSettings(next);
      if (current.ms !== prev.ms) start();
    });

    ctx.registerAction("water.drank", () => {
      rollDay();
      count += 1;
      ctx.emit({ source: "water", type: "react", mood: "happy" });
      if (count >= current.goal && !celebrated) {
        celebrated = true;
        ctx.emit({
          source: "water",
          type: "notify",
          key: "water-goal",
          text: `목표 ${current.goal}잔 달성! 대단해요`,
          mood: "happy",
          priority: "high",
          ttlMs: 60_000,
        });
      }
    });
    ctx.registerAction("water.today", () => {
      rollDay();
      ctx.emit({
        source: "water",
        type: "notify",
        key: "water-today",
        text: `오늘 ${count}잔 마셨어요 (목표 ${current.goal}잔)`,
        mood: "neutral",
        ttlMs: 60_000,
      });
    });
    ctx.addTrayItem({ id: "water.tray-today", label: "오늘 마신 물", action: "water.today" });
    ctx.log.info("water: activated");
  },
};

export default plugin;
