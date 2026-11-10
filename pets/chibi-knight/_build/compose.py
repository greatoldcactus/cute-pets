#!/usr/bin/env python3
"""Rebuild with python3 + Pillow; no image-generation service needed."""
from pathlib import Path
import json
import math
import sys
sys.path.insert(0, str(Path(__file__).parent / '_vendor'))
from PIL import Image, ImageDraw
B = Path(__file__).resolve().parent
OUT = B.parent
FW, FH = 192, 208
NAMES = ['master', 'blink', 'run_a', 'run_b', 'run_c', 'run_d', 'wait_left', 'wait_right', 'error']
# Body anchors measured on the generated originals (not bounding-box centers).
ANCHORS = dict(master=560, blink=560, run_a=610, run_b=570,
               run_c=570, run_d=570, wait_left=550, wait_right=550, error=550)
# Shared flat material palette: outline, hair, steel, crimson, brass, skin, sweat.
COLORS = ['24191e','38252a','503033','654039','82574a',
          '48424b','68616b','969199','c7c4cb','eee9ea',
          '501f2b','7c293b','a63b4d','c34b59',
          '866039','bd934f','e0b969','f5d68a',
          'c98b75','e8ad91','ffd0b0','ffe2c9','e9948e',
          'ffffff','8dc6d7','c6eff2']
pal = Image.new('P', (1, 1))
triples = [tuple(bytes.fromhex(c)) for c in COLORS]
pal.putpalette([v for c in (triples + [triples[0]] * (256-len(triples))) for v in c])
poses = {}
for name in NAMES:
    src = Image.open(B/'poses'/f'{name}.png').convert('RGBA')
    # Ignore low-alpha generation specks; preserve the actual character silhouette.
    alpha = src.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
    src.putalpha(alpha)
    box = alpha.getbbox()
    crop = src.crop(box)
    scale = 188 / crop.height
    size = (round(crop.width * scale), 188)
    small = crop.resize(size, Image.Resampling.LANCZOS)
    mask = small.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
    small = small.convert('RGB').quantize(palette=pal, dither=Image.Dither.NONE).convert('RGBA')
    small.putalpha(mask)
    cell = Image.new('RGBA', (FW, FH))
    x = 96 - round((ANCHORS[name] - box[0]) * scale)
    cell.alpha_composite(small, (x, 199 - size[1]))
    poses[name] = cell
    cell.save(B/'poses'/f'{name}-cell.png')

def motion(name, bob=0, sway=0):
    src = poses[name]
    dst = Image.new('RGBA', src.size)
    # Tiny plume motion, leaving its attachment still; cape edge moves separately.
    for y in range(FH):
        dx = round(sway * max(0, (44-y)/44)) if y < 44 else 0
        dst.alpha_composite(src.crop((0,y,FW,y+1)), (dx,y+bob))
    if sway:
        for y in range(137,173):
            strip = src.crop((0,y,64,y+1))
            ImageDraw.Draw(dst).rectangle((0,y+bob,63,y+bob), fill=(0,0,0,0))
            dst.alpha_composite(strip, (round(sway),y+bob))
    return dst

idle = [motion('blink' if f == 5 else 'master',
               [0,0,-1,-1,-2,-1,-1,0][f], [0,1,1,0,-1,-1,0,0][f]) for f in range(8)]
run = [motion(n,b) for n,b in zip(
    ['run_a','run_a','run_b','run_b','run_c','run_c','run_d','run_d'],
    [0,-1,-3,-2,0,-1,-3,-2])]
wait = [motion(n, b, s) for n,b,s in zip(
    ['wait_left','wait_left','master','master','wait_right','wait_right','wait_right','master'],
    [0,0,-1,-1,0,0,0,0], [0,1,0,-1,1,0,-1,0])]
error = []
for f in range(8):
    im = motion('error', [0,0,1,1,0,0,1,0][f], 0)
    d = ImageDraw.Draw(im)
    # Small red exclamation pulse above the helmet, clear of the plume.
    x,y = 137,20
    color = ['#a63b4d','#c34b59','#e65a64','#ff7980','#e65a64','#c34b59','#a63b4d','#a63b4d'][f]
    d.rounded_rectangle((x-1,y-1,x+5,y+12),radius=1,fill='#24191e')
    d.rectangle((x,y,x+4,y+10),fill=color)
    d.rectangle((x,y+15,x+4,y+19),fill='#24191e')
    d.rectangle((x+1,y+16,x+3,y+18),fill=color)
    error.append(im)
rows = [idle,run,run,run,wait,run,wait,wait,idle,error,error]
sheet = Image.new('RGBA',(1536,2288))
for r, frames in enumerate(rows):
    for f, frame in enumerate(frames):
        sheet.alpha_composite(frame,(f*FW,r*FH))
sheet.save(OUT/'spritesheet.webp',lossless=True,exact=True,method=6)
meta = dict(id='chibi-knight', displayName='Chibi Knight',
    description='A watchful brown-haired knight girl in crimson armour with a red plume, round shield and short sword.',
    spriteVersionNumber=2, spritesheetPath='spritesheet.webp')
(OUT/'pet.json').write_text(json.dumps(meta,indent=2)+'\n')
preview = Image.new('RGBA',(FW*3*4,FH*3),(25,29,39,255))
for i,r in enumerate([0,2,6,9]):
    preview.alpha_composite(rows[r][0].resize((FW*3,FH*3),Image.Resampling.NEAREST),(i*FW*3,0))
preview.save(OUT/'preview.png')
print('Built spritesheet.webp 1536x2288 RGBA; 88 complete cells; preview.png 2304x624')
print('Secondary row repeats: 1,3,5 -> running; 4,7 -> waiting; 8 -> idle; 10 -> error')
