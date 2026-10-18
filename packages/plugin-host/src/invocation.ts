import { randomUUID } from "node:crypto";

interface Invocation {
  pluginId: string;
  actionId: string;
  openedAt: number;
}

export class Invocations {
  private readonly open = new Map<string, Invocation>();

  constructor(private readonly now: () => number, private readonly createId: () => string = randomUUID) {}

  begin(pluginId: string, actionId: string): string {
    const id = this.createId();
    this.open.set(id, { pluginId, actionId, openedAt: this.now() });
    return id;
  }

  permits(id: string | undefined, pluginId: string): boolean {
    if (!id) return false;
    const invocation = this.open.get(id);
    const age = invocation ? this.now() - invocation.openedAt : -1;
    return invocation?.pluginId === pluginId && age >= 0 && age <= 60_000;
  }

  close(id: string): void { this.open.delete(id); }

  closePlugin(pluginId: string): void {
    for (const [id, invocation] of this.open) if (invocation.pluginId === pluginId) this.open.delete(id);
  }
}
