import type { Disposable, PluginContext as V1PluginContext, PluginContributions,
  PluginManifest as V1PluginManifest, PluginPermissions as V1PluginPermissions,
  ConfigSchema } from "../v1/contracts.js";
import type { LinePetEvent } from "@deskpet/core";

export interface PluginPermissions extends V1PluginPermissions {
  socketMode?: string[];
  orcaRead?: boolean;
  orcaGateResolve?: boolean;
  orcaOpenTerminal?: boolean;
}

export interface PluginManifest extends Omit<V1PluginManifest, "apiVersion" | "permissions"> {
  apiVersion: "2";
  permissions: PluginPermissions;
  contributes: PluginContributions & { lines?: string };
}

export interface PluginBadge { text: string; tone?: "neutral" | "warn" | "ok"; action?: string }

export type SocketModeStatus =
  | "connecting" | "connected" | "reconnecting"
  | "token-required" | "permission-required";

export interface SocketModeEvent {
  type: string;
  event: Readonly<Record<string, unknown>>;
}

export interface OrcaSnapshot {
  availability: "ready" | "unavailable";
  runs: readonly {
    id: string;
    coordinatorHandle: string | null;
    coordinatorWaiting: boolean | null;
    tasks: readonly { id: string; title: string; status: "pending" | "running" | "succeeded" | "failed" | "unknown" }[];
    workers: readonly { dispatchId: string; taskId: string; terminalHandle: string | null;
      state: "working" | "succeeded" | "failed" | "exited" | "unknown";
      liveness: "live" | "exited" | "unverifiable" | "unknown"; lastActivityAt: string | null }[];
    gates: readonly { id: string; taskId: string | null; status: "pending" | "resolved"; options: readonly string[] }[];
    messages: readonly { id: string; taskId: string | null; type: "question" | "escalation" }[];
  }[];
  /** Main has already claimed these candidates in its local notification ledger. */
  notifications: readonly { kind: "worker-succeeded" | "worker-failed" | "attention" |
    "coordinator-waiting" | "worker-exited" | "unavailable";
    runId: string; taskId: string | null; dispatchId: string | null; gateId: string | null;
    messageId: string | null; messageType: "question" | "escalation" | null;
    terminalHandle: string | null; title: string }[];
}

export interface PluginContext extends Omit<V1PluginContext, "secrets" | "emit" | "setBadge"> {
  emit(event: LinePetEvent): void;
  setBadge(id: string, badge: PluginBadge | null): void;
  orca: {
    snapshot(): Promise<OrcaSnapshot>;
    muteGate(gateId: string): Promise<void>;
    resolveGate(gateId: string, resolution: string): Promise<"resolved" | "already-resolved" | "unconfirmed">;
    openTerminal(handle: string): Promise<void>;
  };
  slack: {
    connect(options: {
      appTokenSecret: string;
      onEvent(event: SocketModeEvent): Promise<void> | void;
      onStatus(status: SocketModeStatus): void;
    }): Promise<Disposable>;
    get(options: {
      userTokenSecret: string;
      method: "users.info" | "conversations.info";
      query?: Readonly<Record<string, string>>;
    }): Promise<{ status: number; body: unknown }>;
  };
}

export interface PluginDefinition {
  configSchema?: ConfigSchema;
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}
