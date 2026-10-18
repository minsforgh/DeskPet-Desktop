interface Window {
  petHitTest(x: number, y: number): { interactive: boolean; alpha: number };
  petBadgeState(): { visible: boolean; text: string | null; tooltip: string | null;
    hovered: boolean; rect: { x: number; y: number; width: number; height: number } | null;
    tooltipRows: Array<{ x: number; y: number; width: number; height: number }> };
  petBadgeClickForTest(x: number, y: number): Promise<{ clicked: boolean }>;
  petBadgeDragForTest(x: number, y: number): Promise<{ clicked: boolean }>;
  pet: {
    getCharacter(): Promise<CharacterPayload>;
    getBadgeDisplay(): Promise<{ badges: DisplayBadge[]; bubbleVisible: boolean; placement: import("../main/settings.js").BadgePlacement;
      workArea: { x: number; y: number; width: number; height: number } }>;
    onBadgePlacement(callback: (placement: import("../main/settings.js").BadgePlacement) => void): void;
    clickBadge(pluginId: string, id: string): Promise<void>;
    onBadges(callback: (badges: DisplayBadge[]) => void): void;
    onBubbleVisible(callback: (visible: boolean) => void): void;
    onCharacter(callback: (payload: CharacterPayload) => void): void;
    onFrame(callback: (payload: { sequence: number; snapshot: AnimationSnapshot }) => void): void;
    onScaleChanged(callback: () => void): void;
    frameRendered(sequence: number): void;
    characterRendered(version: number): void;
    markReady(): void;
    setMousePassThrough(ignore: boolean): void;
    startDrag(): void;
    endDrag(): void;
    showContextMenu(): void;
  };
  bubbleHitTest(x: number, y: number): boolean;
  bubbleMetrics(): unknown;
  bubbleClickText(): Promise<boolean>;
  bubbleClickHint(): Promise<boolean>;
  bubbleContainsText(value: string): boolean;
  bubble: {
    onRender(callback: (payload: { sequence: number; version: number; text: string; detail?: string;
      fullText?: string; parts?: import("@deskpet/core").LineParts;
      side: "above" | "below"; tailX: number; maxWidthDip: number; maxHeightDip: number;
      maxLines: number; labels?: string[] }) => void): void;
    onClear(callback: () => void): void;
    rendered(payload: { sequence: number; width: number; height: number }): void;
    resized(payload: { sequence: number; width: number; height: number }): Promise<void>;
    markReady(): void;
    setMousePassThrough(ignore: boolean): void;
    dismiss(): void;
  };
}

interface CharacterPayload {
  version: number;
  pack?: { manifest: import("@deskpet/core").CharacterManifest; sheets: Record<string, string>;
    contentRect?: { x: number; y: number; width: number; height: number } };
  snapshot: import("@deskpet/core").AnimationSnapshot;
}

type AnimationSnapshot = import("@deskpet/core").AnimationSnapshot;
interface DisplayBadge { pluginId: string; id: string; pluginName: string; text: string;
  tone: "neutral" | "warn" | "ok"; action?: string }
