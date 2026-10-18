export interface Disposable {
  dispose(): void;
}

export type ActionHandler = (args?: unknown) => Promise<void> | void;

/** ok: the handler ran; not-found: the id is not on the allowlist; failed: the handler threw. */
export type InvokeResult = { ok: true } | { ok: false; reason: "not-found" | "failed"; error?: string };

// Same shape as the plugin-sdk contribution id pattern (ADR-0003), so plugin actions register unchanged in M4.
const actionIdPattern = /^[a-z0-9-]+\.[^.]+$/u;

/** The allowlist behind local HTTP POST /action/:id; only ids registered here can run. */
export class ActionRegistry {
  private readonly handlers = new Map<string, ActionHandler>();

  register(id: string, handler: ActionHandler): Disposable {
    if (!actionIdPattern.test(id)) throw new Error(`Invalid action id '${id}'`);
    if (this.handlers.has(id)) throw new Error(`Action '${id}' is already registered`);
    this.handlers.set(id, handler);
    return { dispose: () => { if (this.handlers.get(id) === handler) this.handlers.delete(id); } };
  }

  async invoke(id: string, args?: unknown): Promise<InvokeResult> {
    const handler = this.handlers.get(id);
    if (!handler) return { ok: false, reason: "not-found" };
    try {
      await handler(args);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Action '${id}' failed:`, message);
      return { ok: false, reason: "failed", error: message };
    }
  }
}
