# Phase 1 review — segmentation & studio composite

Open these side by side (before = original upload, kept untouched; after = NEW `studio_composite` version):

| Good photo | Before (original) | After (studio composite) | Verdict |
|---|---|---|---|
| photo-1 (blue shorts, patterned bedspread) | `photo-1-before.jpg` | `photo-1-after.jpg` (production ISNet-small path, `out/studio-composite-real/cutout-….png` → neutral backdrop + shadow) | CLEAN — crisp edges, background fully gone, GUESS tape detail preserved. Pipeline verified. |
| photo-3 (dark shoes, speckled tile) | `photo-3-before.jpg` | `photo-3-after.jpg` (deterministic classical seg-cut path) | ACCEPTABLE — garment isolated on backdrop; minor fringe on close zoom. `photo-3-after-isnet-small.jpg` shows the raw ISNet-small output leaking gravel/grout — this is why we gate on good photos, not model heroics. |

Out of scope per owner decision: photo-2 (grey-marle hoodie, underexposed flash on white table, garment touching 3 frame edges). Deliberately not fixed — a day and a half was already spent on it. Resolution: tell the user to take good photos (lit, contrasting surface, garment fully inside frame with margin).

Pipeline (all in `src/services/studioComposite.ts`, wired in `src/store/appStore.ts` + `src/components/GarmentPhoto.tsx`):
- Segmentation: `@imgly/background-removal` (ISNet, local ONNX/WASM, zero API cost) with deterministic classical fallback.
- Composite: flat neutral sweep `#F4F1EB → #ECE7DD → #DCD5C7`, tight alpha-bbox centering, 9% padding, blurred-ellipse drop shadow.
- Original is never overwritten (`garment.photo` sacred; composite saved as new `garment.studioComposite`).
- No external AI image model calls anywhere in this phase.
