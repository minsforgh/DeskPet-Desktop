import type { Envelope } from "./envelope.js";

export interface PluginChannel {
  post(message: Envelope): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onExit(listener: (code: number | null) => void): () => void;
  kill(): void;
}

export class MemoryPluginChannel implements PluginChannel {
  private peer: MemoryPluginChannel | undefined;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();
  private exited = false;

  static pair(): [MemoryPluginChannel, MemoryPluginChannel] {
    const first = new MemoryPluginChannel();
    const second = new MemoryPluginChannel();
    first.peer = second;
    second.peer = first;
    return [first, second];
  }

  post(message: Envelope): void {
    if (this.exited || !this.peer || this.peer.exited) return;
    const target = this.peer;
    const copy: unknown = structuredClone(message);
    queueMicrotask(() => {
      if (!target.exited) for (const listener of target.messageListeners) listener(copy);
    });
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  kill(): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(null);
    this.peer?.exitFromPeer();
  }

  private exitFromPeer(): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(null);
  }
}
