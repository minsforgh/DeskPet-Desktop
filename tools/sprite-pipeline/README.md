# Sprite pipeline

## Build a character pack

From the workspace root:

```sh
pnpm sprites:pack --spec docs/art/pack/wolf-maid.json --out characters/wolf-maid
```

The JSON spec contains `id`, `name`, `cellSize` (`[width,height]`), `anchor` (`[x,y]`), `scale`, `fallbacks`, and `states`. Each state has `frames` (a PNG folder relative to the spec), `offsetX` (integer pixels), `loop`, and optional `next` and `facing` (`left` or `right`). The frame folder contains `frame-01.png`, `frame-02.png`, etc.; its parent contains `frames.json` with that state's `fps` and frame count. The tool copies each frame into a transparent cell at `offsetX`, joins the cells horizontally without gaps, writes `manifest.json` and `sheets/<state>.png`, then applies the same pack checks as `sprites:check`. Inputs and outputs must resolve inside the workspace; absolute paths, escaping traversal or links, and output collisions with inputs are rejected. Repeating the command with the same inputs produces identical bytes.

## Retouch a fixed-palette sprite

```sh
pnpm sprites:retouch input.sprite.png --palette palette.json --edits edits.json --out retouched --preview-scale 4 --name base
```

Run from the workspace root. `--edits` is optional; `--preview-scale` defaults to 4 (integer 1–32, at most 4 million preview pixels). `--name` optionally overrides the input stem; it must be a plain filename stem. The command keeps the input dimensions and transparent pixels, maps each opaque pixel to the closest palette color using squared sRGB distance, then applies edits in array order. Exact color-distance ties choose the first palette entry. Partially transparent input is rejected with its pixel coordinate. Transparent output has zero RGB. No cropping, resampling, or automatic speck removal occurs.

Palette JSON contains `colors`, an ordered array of 1–16 objects with unique `name`, unique six-digit `hex` (`#RRGGBB`), and a nonempty `role`. `transparent` is reserved. For example:

```json
{"colors":[{"name":"outline","hex":"#151a2e","role":"Outer contour"},{"name":"apron","hex":"#fcfaf7","role":"White cloth"}]}
```

Edits JSON contains `edits`. Every edit requires a nonempty `note` explaining why it is needed. Coordinates start at zero. Rectangles include the top-left pixel and extend by `width`/`height`; all coordinates must stay on the canvas. Unknown fields and colors are errors. `color` and `from` refer to palette names or `transparent`; replacements operate on the current image after preceding edits and palette mapping.

```json
{"edits":[
  {"x":2,"y":3,"color":"outline","note":"Close a contour gap"},
  {"type":"rect","region":{"x":4,"y":5,"width":2,"height":1},"color":"apron","note":"Even the cuff"},
  {"type":"replace","from":"outline","color":"apron","region":{"x":1,"y":1,"width":2,"height":2},"note":"Remove an interior dark cluster"},
  {"type":"replace","from":"apron","color":"transparent","note":"Example of a whole-canvas replacement"}
]}
```

The four outputs are `<name>.sprite.png`, `<name>.preview.png` (nearest neighbor), `<name>.check.png` (light/dark backgrounds), and `<name>.json` (dimensions, used palette names/hex values/pixel counts, transparent count). Identical inputs produce identical bytes without timestamps. The result is checked for palette membership and binary alpha. Invalid files/arguments exit nonzero with field or pixel context. Input, palette, edits, output directory, and existing output leaves are checked by real path against the working directory, rejecting absolute paths, parent traversal, and escaping links. Outputs cannot overwrite input files.

The selected q2 art and its companion 2× and before/after images can all be rebuilt from the repository root with `node docs/art/base/rebuild.mjs`. See [the art review](../../docs/art/base/README.md) for palette roles, pixel counts, anchors, and visual limitations.

## Generate state frames from a spec

Run from the workspace root:

```sh
pnpm sprites:frames --spec docs/art/frames/blink.json --out docs/art/frames/out --preview-scale 4
```

`--preview-scale` defaults to 4 (integer 1–32). The spec is a JSON file:

```json
{
  "base": "base_final.png",
  "palette": "palette.json",
  "parts": "parts.json",
  "states": {
    "blink": {
      "fps": 8,
      "frames": [
        { "note": "eyes closed: irises and eye color covered with skin",
          "ops": [
            { "type": "rect", "region": "eye-left", "color": "skin", "note": "left iris to skin" },
            { "type": "rect", "region": "eye-right", "color": "skin", "note": "right iris to skin" }
          ] },
        { "note": "eyes open (base)", "ops": [] }
      ]
    }
  }
}
```

`base`, `palette`, and `parts` are paths relative to the spec file; `parts` follows the [parts.json](../../docs/art/base/parts.json) format (`size`, named `box` parts, `anchor`). State names become directory and file names, so they must be plain filename stems. Each state needs an integer `fps` >= 1 and a nonempty `frames` array; every frame needs a one-line `note`, and `ops` may be empty (the frame is then the base as-is).

Ops are the retouch edits (`pixel`, `rect`, `replace` with the same fields and a required `note`) plus one new op:

```json
{ "type": "shift", "region": "ear-left", "dx": 0, "dy": -2, "fill": "outline", "note": "ear perks up" }
```

Every `region` (and `replace` bounds) is either `{x, y, width, height}` or a parts.json part name covering that part's whole box. `shift` moves all pixels inside the region by `(dx, dy)`, overwriting destinations: pixels whose destination leaves the image are dropped, destinations outside the region but inside the image are kept, and region cells left empty become transparent — or the `fill` palette color when given. Each frame restarts from the original base; edits never accumulate across frames.

Every frame is validated before anything is written; a failure exits nonzero naming the state, frame number, and reason. The frame must use only palette colors and fully transparent pixels (partial alpha is an error), keep the base dimensions, keep its lowest opaque row on `anchor.foot-row`, and keep the horizontal center of opaque pixels inside the `legs` part box within ±2 px of `anchor.foot-center-x`. Unknown part names, unknown colors, and out-of-canvas coordinates are errors.

Outputs per state: `<state>/frame-NN.png` at actual size, `<state>.strip.png` (frames joined horizontally with no gaps), and `<state>.strip.preview.png` (nearest-neighbor enlargement shown on light and dark background rows). A shared `frames.json` records each state's fps, frame count, and per-frame note and used color count. The scaled strip must stay under 4 million pixels; reduce `--preview-scale` for long strips. Identical inputs produce byte-identical outputs without timestamps. Spec-relative paths may climb with `..` but must stay inside the workspace by real path: absolute paths, escaping parent traversal, and escaping links are rejected for the spec, its referenced files, `--out`, and existing output leaves, and outputs cannot overwrite the spec, base, palette, or parts files.

## Pixelize a concept PNG

Run from the repository root with paths inside that workspace:

```sh
pnpm sprites:pixelize docs/art/concepts/2026-10-06/a-pixel.png --out .pixelize-preview --height 96 --colors 16 --preview-scale 4
```

`--height`, `--colors`, and `--preview-scale` default to 96, 16, and 4. `--no-remove-specks` keeps isolated one-pixel marks. The command rejects absolute paths, parent traversal, and links leading outside the workspace. The input must be an 8-bit RGB or RGBA PNG supported by the existing PNG codec; the requested height cannot exceed the cropped source height.

The command removes a solid or fully opaque outer background by flood fill, preserving enclosed areas of the same color. It crops to visible bounds, scales the content to the requested height by choosing each target cell's most frequent source color, and makes alpha binary at 128. A deterministic median-cut palette reduction keeps the darkest and most saturated source colors, then isolated opaque pixels are removed unless disabled. The enlarged preview uses nearest-neighbor scaling. An existing transparent background is preserved.

Four files use the input stem: `<name>.sprite.png` at actual size, `<name>.preview.png` enlarged, `<name>.check.png` showing the preview on light and dark backgrounds side by side, and `<name>.json` with dimensions, actual color count, hex palette, original crop bounds, and pixels made transparent by background removal. The output is deterministic for identical input and options. If the original dots are already blurred or merged, selecting the most frequent colors may still leave an untidy sprite; manual cleanup may be needed.

From the repository root:

```sh
pnpm sprites:placeholder
pnpm sprites:check characters/placeholder characters/placeholder-alt
pnpm --silent sprites:check --json characters/placeholder
```

The generator recreates both committed placeholder packs deterministically. The checker validates each manifest, real paths, sheet limits, dimensions, and every frame. Alpha 128–255 is opaque; alpha 1–127 is translucent. Opaque pixels form 8-connected components. Components with at least 1% of the frame's opaque pixels (minimum 4 pixels) are body components. A frame without a body is empty. The lowest body row must be within 2 px of `anchor.y`, and the horizontal center of all opaque body pixels in the lowest eight rows (including both feet and a raised foot) must be within 2 px of `anchor.x`. Small components with any pixel below `anchor.y - 2` are rejected as foot-area specks; other small components are counted as upper decorations. Translucent pixels below `anchor.y + 2` are rejected. Errors name the state, frame, measurement, and expected value. `--json` writes machine-readable results. Any issue exits with a nonzero status.

### Moving only some colors

`shift` takes an optional `"only": ["<palette color>", ...]`. Just the pixels of those colors inside the region move; every other pixel stays, and the moved pixels pass behind them (a moved pixel is dropped where a pixel that stayed already is). Cells the moved pixels left become transparent, or `fill`. Use it to sway a tail that overlaps the skirt: `{"type":"shift","region":"tail","dx":-1,"dy":0,"only":["hair-light","hair-mid","hair-shadow","shoe"],"note":"..."}`.

### Moving several parts at once: `shift-set`

`{"type":"shift-set","note":"...","moves":[{"region":"back-leg","dx":4,"dy":0,"only":["outline","stocking"]}, ...]}` runs every move against the same original pixels, so a pixel that one move lands on is never picked up again by another move (two feet that cross each other, a tail swaying while the legs step). Each move needs `only`; `fill` is not supported. Moved pixels pass behind pixels that stay put, and when two moves land on the same cell the earlier move in the list wins.
