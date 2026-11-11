from pathlib import Path
import sys,hashlib,json
sys.path.insert(0,str(Path(__file__).parent/'_vendor'))
from PIL import Image
b=Path(__file__).resolve().parent; p=b.parent
im=Image.open(p/'spritesheet.webp'); before=json.loads((b/'handedness-before.json').read_text())
lines=['Sheet: '+str(im.size)+' '+im.mode,'Gold test: y in [90,170); exclude x in [85,107); r>185, 110<g<200, b<115, alpha>0.']
assert im.size==(1536,2288) and im.mode=='RGBA'
for row in [0,2,6]:
    counts=[]
    for f in range(8):
        frame=im.crop((f*192,row*208,(f+1)*192,(row+1)*208)); sides=[0,0]
        for y in range(90,170):
            for x in range(192):
                if 85<=x<107: continue
                r,g,blue,a=frame.getpixel((x,y))
                if a and r>185 and 110<g<200 and blue<115: sides[x>=107]+=1
        counts.append(sides)
    letters=['R' if r>l else 'L' if l>r else '=' for l,r in counts]
    lines += [f'row {row}: '+ ' '.join(letters), '  [L,R]: '+str(counts)]
    assert letters==['R']*8
for row in [0,2,6,9]:
    counts=[sum(v>0 for v in im.crop((f*192,row*208,(f+1)*192,(row+1)*208)).getchannel('A').tobytes()) for f in range(8)]
    assert min(counts)>0
    lines.append(f'row {row} nonempty alpha counts: {counts}')
lines.append('SHA-256 over decoded RGBA row bands (before -> after):')
for row in [0,4,6,7,8,9,10]:
    old=before['rows'][str(row)]; new=hashlib.sha256(im.crop((0,row*208,1536,(row+1)*208)).tobytes()).hexdigest()
    assert old==new
    lines.append(f'row {row}: {old} -> {new} MATCH')
for name,old in before['files'].items(): assert hashlib.sha256((p/name).read_bytes()).hexdigest()==old
lines.append('14 unaffected original/normalized pose files: byte-for-byte unchanged. compose.py and anchors unchanged.')
# Actual full eight-frame row strip for visual inspection.
strip=Image.new('RGBA',(1536,208),(25,29,39,255));strip.alpha_composite(im.crop((0,416,1536,624)))
strip.save(b/'run-row2-review.png')
contact=Image.new('RGBA',(768,208),(25,29,39,255))
for i,f in enumerate([0,2,4,6]): contact.alpha_composite(im.crop((192*f,416,192*(f+1),624)),(i*192,0))
contact.resize((1536,416),Image.Resampling.NEAREST).save(b/'run-review.png')
text='\n'.join(lines)+'\n';(b/'handedness-check.txt').write_text(text);print(text)
