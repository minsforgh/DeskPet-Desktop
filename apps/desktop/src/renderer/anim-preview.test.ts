import { describe, expect, it } from "vitest";
import { createAnimationPreview, frameAt } from "./anim-preview.js";

describe("animation preview frame clock", () => {
  it("advances frames using a supplied elapsed time, loops, and stops on the final non-looping frame", () => {
    const loop = { frames: 4, fps: 10, loop: true };
    expect(frameAt(loop, 0)).toEqual({ frame: 0, ended: false });
    expect(frameAt(loop, 199)).toEqual({ frame: 1, ended: false });
    expect(frameAt(loop, 400)).toEqual({ frame: 0, ended: false });
    expect(frameAt({ ...loop, loop: false }, 299)).toEqual({ frame: 2, ended: false });
    expect(frameAt({ ...loop, loop: false }, 300)).toEqual({ frame: 3, ended: true });
  });
});

it("draws successive canvas frames with a controlled animation clock and stops a finite clip", () => {
  let now = 0;
  let nextHandle = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const drawn: number[] = [];
  class Element {
    children: Element[] = [];
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    className = "";
    textContent = "";
    type = "";
    value = "";
    hidden = false;
    complete = true;
    naturalWidth = 4;
    isConnected = true;
    width = 0;
    height = 0;
    src = "";
    private listeners = new Map<string, () => void>();
    private attrs = new Map<string, string>();
    classList = { toggle: () => {} };
    constructor(readonly tag: string) {}
    append(...children: Element[]): void { this.children.push(...children); }
    replaceChildren(...children: Element[]): void { this.children = children; }
    addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener); }
    setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
    getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
    closest(): null { return null; }
    getContext(): { clearRect(): void; drawImage(image: Element, x: number): void } {
      return { clearRect: () => {}, drawImage: (_image, x) => { drawn.push(x); } };
    }
  }
  const doc = { hidden: false, createElement: (tag: string) => new Element(tag), defaultView: {
    performance: { now: () => now }, requestAnimationFrame: (callback: FrameRequestCallback) => {
      const handle = ++nextHandle; pending.set(handle, callback); return handle;
    }, cancelAnimationFrame: (handle: number) => { pending.delete(handle); },
  } } as unknown as Document;
  const preview = createAnimationPreview(doc, { sheet: "data:image/png;base64,AAAA", frames: 3,
    fps: 10, loop: false, cellSize: [4, 4] });
  const canvas = (preview.element as unknown as Element).children[0];
  expect(canvas?.dataset.frame).toBe("0");
  const advance = (at: number): void => {
    now = at;
    const callbacks = [...pending.values()]; pending.clear();
    callbacks.forEach((callback) => callback(now));
  };
  advance(100);
  expect(canvas?.dataset.frame).toBe("1");
  advance(200);
  expect(canvas?.dataset.frame).toBe("2");
  expect(pending.size).toBe(0);
  expect(drawn).toEqual([0, 4, 8]);
});
