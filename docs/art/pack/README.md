# 늑대 메이드 캐릭터 팩

`out/` 프레임은 커밋되지 않으므로 저장소 루트에서 순서대로 다시 만든다.

```sh
pnpm sprites:frames --spec docs/art/frames/states.json --out docs/art/frames/out
pnpm sprites:frames --spec docs/art/side/states-side.json --out docs/art/side/out
pnpm sprites:pack --spec docs/art/pack/wolf-maid.json --out characters/wolf-maid
```
