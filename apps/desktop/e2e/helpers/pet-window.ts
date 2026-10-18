// The default badge placement reserves a transparent strip above the pet art.
export const BADGE_TOP_MARGIN = 70;

export function petWindowY(artY: number): number { return artY + BADGE_TOP_MARGIN; }
