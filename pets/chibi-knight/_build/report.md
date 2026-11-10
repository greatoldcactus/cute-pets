# Chibi Knight build report

Generated with built-in image_gen: nine original transparent key poses. Exact prompts and source mappings are in prompts.json; full-resolution originals and normalized cells are in poses/.

## Review and limitations

The first-frame preview and four-key run contact strip were visually inspected. The HTML viewer uses the actual sheet at 6/11/5/4 fps, has pause and frame scrubbing, and works without a server. Its relative asset links were checked; it was not browser-render tested.

Main rows have eight complete frames. Running uses four generated key poses held for two frames, with bounce; this is a stylized, somewhat choppy cycle, not eight unique in-betweens. Generated poses retain small silhouette/proportion differences. The waiting gaze change is subtle. Outlines are approximately 1px but vary locally; this is quantized image-generated art rather than hand-pixelled art. The plume increases the apparent head-to-body ratio. Standing silhouettes are narrower than 140px; the running silhouette reaches about 149px wide. Character height is 188px, with deliberate 0–3px bounce. Opaque colours are flattened into a shared material palette, plus pulsing error-effect colours.

Repeated secondary rows: 1,3,5 = running; 4,7 = waiting; 8 = idle; 10 = error. No attack or cheer was added.

The old procedural art was not reused. scripts/make-pet-knight.py was deleted as requested. No Git commands were used. All other project writes are inside pets/chibi-knight/.

## Build environment and regeneration

Pillow 13.0.0 was installed temporarily inside _build/_vendor using:

```bash
python3 -m pip install --no-cache-dir --target pets/chibi-knight/_build/_vendor Pillow
```

Output: `Successfully installed Pillow-13.0.0`.

The temporary dependency directory was removed after verification; it is not part of the pack. To reproduce in a Python environment with Pillow installed, run:

```bash
python3 pets/chibi-knight/_build/compose.py
python3 pets/chibi-knight/_build/verify.py
```

Alternatively rerun the isolated install command above. The saved original poses make composition reproducible without calling image generation again. Image-generation prompts themselves do not promise identical regenerated artwork.

Deletion command executed successfully (no output):

```bash
rm scripts/make-pet-knight.py
```

## Exact final build/check commands and output

```bash
python3 pets/chibi-knight/_build/compose.py
```
```text
Built spritesheet.webp 1536x2288 RGBA; 88 complete cells; preview.png 2304x624
Secondary row repeats: 1,3,5 -> running; 4,7 -> waiting; 8 -> idle; 10 -> error
```

```bash
PYTHONPATH=pets/chibi-knight/_build/_vendor python3 -c 'from PIL import Image; im=Image.open("pets/chibi-knight/spritesheet.webp"); print(im.size, im.mode); assert im.size==(1536,2288) and im.mode=="RGBA"'
```
```text
(1536, 2288) RGBA
```

```bash
python3 pets/chibi-knight/_build/verify.py
```
```text
sheet: (1536, 2288) RGBA
alpha: binary 0/255; fully transparent background
row 0 alpha>0: [12396, 12363, 12363, 12396, 12396, 12225, 12396, 12396]
row 2 alpha>0: [14766, 14766, 12121, 12121, 12716, 12716, 12814, 12814]
row 6 alpha>0: [11196, 11160, 12396, 12396, 10938, 10974, 10974, 12396]
row 9 alpha>0: [11390, 11390, 11390, 11390, 11390, 11390, 11390, 11390]
88/88 nonempty cells; transparent cell margins; main-row baseline y=195..199
pet.json: parses; exactly five required keys; values OK
preview: (2304, 624) rows 0,2,6,9 frame 0 at 3x
colours: 28 colours including the exclamation effect (excluding transparent black)
superseded scripts/make-pet-knight.py: deleted
```

Local HTML links: PASS.

## File list (bytes)

| File | Bytes |
|---|---:|
| _build/compose.py | 4581 |
| _build/poses/blink-cell.png | 13403 |
| _build/poses/blink.png | 1091813 |
| _build/poses/error-cell.png | 13540 |
| _build/poses/error.png | 1006601 |
| _build/poses/master-cell.png | 13854 |
| _build/poses/master.png | 1076406 |
| _build/poses/run_a-cell.png | 16095 |
| _build/poses/run_a.png | 1152182 |
| _build/poses/run_b-cell.png | 12934 |
| _build/poses/run_b.png | 1004391 |
| _build/poses/run_c-cell.png | 14170 |
| _build/poses/run_c.png | 1057904 |
| _build/poses/run_d-cell.png | 13903 |
| _build/poses/run_d.png | 1023890 |
| _build/poses/wait_left-cell.png | 13510 |
| _build/poses/wait_left.png | 988926 |
| _build/poses/wait_right-cell.png | 13066 |
| _build/poses/wait_right.png | 1007370 |
| _build/prompts.json | 8734 |
| _build/report.md | 4659 |
| _build/review.html | 2219 |
| _build/run-review.png | 63863 |
| _build/verify.py | 1592 |
| pet.json | 251 |
| preview.png | 77184 |
| spritesheet.webp | 65566 |
