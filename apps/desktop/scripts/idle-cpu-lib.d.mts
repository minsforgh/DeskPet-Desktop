export interface IdleCpuOptions { seconds: number; withJungle: boolean; terrainOff: boolean; pollBurst: boolean; burstSeconds: number; installedExe: string | null }
export interface IdleProcess {
  pid: number; ppid: number; cpuSeconds: number; workingSetMb: number; privateMb: number; commandLine: string; role: string;
}
export interface SampleSummary { count: number; average: number; max: number; maxIndex: number }
export interface RoleMemory { count: number; workingSetMb: number; privateMb: number }
export declare const DEFAULT_SECONDS: number;
export declare const MIN_SECONDS: number;
export declare const MAX_SECONDS: number;
export declare const DEFAULT_BURST_SECONDS: number;
export declare function parseOptions(arguments_: readonly string[]): IdleCpuOptions;
export declare function roleOf(commandLine: unknown): string;
export declare function setAppExeName(name: string): void;
export declare function roleOfProcess(name: unknown, commandLine: unknown): string;
export declare function descendantsOf(processes: readonly IdleProcess[], rootPid: number): IdleProcess[];
export declare function launchSettingsOf(options: IdleCpuOptions): Record<string, unknown>;
export declare function labelPlugins(tree: IdleProcess[], pluginPids: ReadonlySet<number>): IdleProcess[];
export declare function labelCheckerRenderers(tree: IdleProcess[], knownRendererPids: ReadonlySet<number>): IdleProcess[];
export declare function rendererPidsOf(tree: readonly IdleProcess[]): Set<number>;
export declare function summarizeSamples(percents: readonly number[]): SampleSummary;
export declare function summarizeBurst(percents: readonly number[], burstSeconds: number): SampleSummary;
export declare function roleAveragesOf(roleTotals: ReadonlyMap<string, number>, sampleCount: number): Map<string, number>;
export declare function memoryByRoleOf(tree: readonly IdleProcess[]): Map<string, RoleMemory>;
export declare function memoryTotalOf(memory: ReadonlyMap<string, RoleMemory>): RoleMemory;
export declare function sortRoles<T>(entries: Iterable<[string, T]>): Array<[string, T]>;
export declare function summarizeRoles(tree: readonly IdleProcess[]): string;
export declare function conditionsOf(options: IdleCpuOptions, extra: Record<string, unknown>): Record<string, unknown>;
