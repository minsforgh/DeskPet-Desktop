export class InvalidArgumentError extends Error {
  readonly code = "E_INVALID_ARGUMENT";

  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

export interface CronSchedule {
  readonly minute: number;
  readonly hour: number;
  readonly days: readonly number[] | undefined;
  readonly timeZone: string;
}

const cronPattern = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:-[0-6]|(?:,[0-6](?:-[0-6])?)*)?)$/u;

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new InvalidArgumentError(`Unknown time zone: ${timeZone}`);
  }
}

function parseDays(value: string): readonly number[] | undefined {
  if (value === "*") return undefined;
  const days = new Set<number>();
  for (const item of value.split(",")) {
    const [startText, endText] = item.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (end < start) throw new InvalidArgumentError(`Invalid weekday range: ${item}`);
    for (let day = start; day <= end; day += 1) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

export function parseCron(cron: string, timeZone?: string): CronSchedule {
  const match = cronPattern.exec(cron);
  if (!match) throw new InvalidArgumentError(`Unsupported cron expression: ${cron}`);
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) throw new InvalidArgumentError(`Unsupported cron expression: ${cron}`);
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  validateTimeZone(zone);
  return { minute, hour, days: parseDays(match[3] ?? "*"), timeZone: zone };
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function partsAt(instant: Date, timeZone: string): WallParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")), weekday: weekdays.indexOf(get("weekday")) };
}

function sameWallTime(actual: WallParts, target: WallParts): boolean {
  return actual.year === target.year && actual.month === target.month && actual.day === target.day && actual.hour === target.hour && actual.minute === target.minute;
}

function targetForDay(day: Date, schedule: CronSchedule): WallParts {
  return { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: schedule.hour, minute: schedule.minute, weekday: day.getUTCDay() };
}

function instantsForWallTime(target: WallParts, timeZone: string): Date[] {
  const nominal = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  // The zone's UTC offset can change within a day or two of the nominal time (DST). Probe the offsets in that window,
  // then keep only the instants whose wall clock in the zone really reads the target time.
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const probe = nominal + hours * 3_600_000;
    const wall = partsAt(new Date(probe), timeZone);
    offsets.add(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - Math.floor(probe / 60_000) * 60_000);
  }
  const matches = new Map<number, Date>();
  for (const offset of offsets) {
    const candidate = new Date(nominal - offset);
    if (sameWallTime(partsAt(candidate, timeZone), target)) matches.set(candidate.getTime(), candidate);
  }
  return [...matches.values()].sort((left, right) => left.getTime() - right.getTime());
}

export function nextCronOccurrence(schedule: CronSchedule, after: Date): Date {
  const start = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate()));
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = new Date(start.getTime() + offset * 86_400_000);
    const target = targetForDay(day, schedule);
    if (schedule.days !== undefined && !schedule.days.includes(target.weekday)) continue;
    const afterParts = partsAt(after, schedule.timeZone);
    if (sameWallTime(afterParts, target)) continue;
    const candidates = instantsForWallTime(target, schedule.timeZone).filter((candidate) => candidate.getTime() > after.getTime());
    if (candidates.length > 0) return candidates[0] as Date;
  }
  throw new Error("Cron expression has no matching occurrence");
}
