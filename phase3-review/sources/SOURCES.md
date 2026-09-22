# Phase 3 grid inputs — 9 samples, graded

Source photos: `references/raw-samples/` (old photo_2 excluded per owner
decision). Composites below are the exact files a funded grid run will consume.

| # | file | garment | Phase-1 composite quality (visual) | grid-ready? |
|---|---|---|---|---|
| s1 | s1-shorts-guess.jpg | blue GUESS shorts (bottoms, logos) | CLEAN (ISNet) | YES |
| s2 | s2-shoes-black.jpg | black shoes, speckled tile (hard surface) | acceptable (classical) | YES |
| s3 | s3-tee-jordan.jpg | black Jordan tee (dark, small logo) | left edge + hem chewed (classical) | NO — needs ISNet |
| s4 | s4-trousers-navy.jpg | navy trousers (dark bottoms) | bedspread slab in crotch (classical) | NO — needs ISNet |
| s5 | s5-jacket-ck.jpg | black CK zip jacket (dark, zip, text logo) | bedspread kept top + bottom-left (classical) | NO — needs ISNet |
| s6 | s6-sweater-striped.jpg | grey/white striped quarter-zip (pattern, light) | good, minor fringe at collar (classical) | YES |
| s7 | s7-hoodie-colorblock.jpg | blue/grey zip hoodie (colorblock, hood, strings) | good except sock fragment at hem (classical) | PROBABLY (1 foreign object) |
| s8 | s8-pants-adidas.jpg | navy/red Adidas track pants (stripes = identity) | red stripes lost + crotch slab (classical) | NO — needs ISNet |
| s9 | s9-hoodie-adidas.jpg | grey/black Adidas hoodie (colorblock, logo, snaps) | very good, one white blob above hood (classical) | PROBABLY (1 blob) |

Coverage: tops, bottoms, outer, shoes; dark ×6, light/patterned; logos/text
(GUESS, Jordan, CK, Adidas ×2); zips ×3, hood, drawstrings, snaps.
Missing: white solid top, dress.

## Blockers (both must clear before the grid runs)

1. **Segmentation for s3/s4/s5/s8**: the deterministic classical fallback is
   not enough for dark garments on this bedspread. Production ISNet handled
   the same background cleanly (s1). But the Node onnx runner now segfaults
   (exit 139, deterministic, right after model download — worked Sep 8).
   Cheap workarounds tried: OMP/KMP thread env (no effect). NOT tried (your
   call): onnxruntime reinstall/version pin, browser-WASM path via puppeteer,
   or per-photo classical tuning (vetoed time-sink category).
2. **Generation endpoint**: HF credits still depleted (probed just now),
   Gemini image quota 0, CF paid-gated, Pollinations unreachable here.
   9 clean composites alone don't run a grid.

Either blocker clearing unblocks real progress; both are needed for the full
(a)–(d) verdict.
