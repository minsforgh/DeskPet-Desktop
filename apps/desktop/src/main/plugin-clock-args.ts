/**
 * Start arguments for plugin processes that fix the clock plugins see (e2e only). `pluginClock` comes from
 * `parseLaunchArgs`, which yields it only for an unpackaged run with a valid dev control name and a parsable time.
 */
export function pluginClockArgs(pluginClock: string | undefined): string[] {
  return pluginClock === undefined ? [] : [`--plugin-clock=${pluginClock}`];
}
