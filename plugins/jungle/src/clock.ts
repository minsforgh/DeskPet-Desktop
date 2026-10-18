const CLOCK_ARG = "--plugin-clock=";

/**
 * Returns a now() that starts at the ISO time given by a `--plugin-clock=` start argument and then advances with the
 * real elapsed time. Without a valid argument it is the plain system clock. Only the desktop main process decides
 * whether to pass the argument (unpackaged run with a valid dev control name), so installed builds never see it.
 */
export function createPluginClock(argv: readonly string[], realNow: () => number = Date.now): () => Date {
  const raw = argv.find((arg) => arg.startsWith(CLOCK_ARG))?.slice(CLOCK_ARG.length);
  const base = raw === undefined ? Number.NaN : Date.parse(raw);
  if (Number.isNaN(base)) return () => new Date(realNow());
  const startedAt = realNow();
  return () => new Date(base + (realNow() - startedAt));
}
