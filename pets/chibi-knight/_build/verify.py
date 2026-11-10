from pathlib import Path
import sys,json
sys.path.insert(0,str(Path(__file__).parent/'_vendor'))
from PIL import Image
p=Path(__file__).resolve().parent.parent
im=Image.open(p/'spritesheet.webp')
assert im.size==(1536,2288) and im.mode=='RGBA'
print('sheet:',im.size,im.mode)
assert set(im.getchannel('A').tobytes())=={0,255}
print('alpha: binary 0/255; fully transparent background')
for r in range(11):
    counts=[]
    for f in range(8):
        a=im.crop((f*192,r*208,(f+1)*192,(r+1)*208)).getchannel('A')
        counts.append(sum(v>0 for v in a.tobytes()))
        assert counts[-1]>0
        x0,y0,x1,y1=a.getbbox()
        assert x0>0 and y0>0 and x1<192 and y1<208
        if r in (0,2,6,9):
            assert 196<=y1<=200
    if r in (0,2,6,9): print(f'row {r} alpha>0:',counts)
print('88/88 nonempty cells; transparent cell margins; main-row baseline y=195..199')
m=json.loads((p/'pet.json').read_text())
assert set(m)=={'id','displayName','description','spriteVersionNumber','spritesheetPath'}
assert m['id']=='chibi-knight' and m['spriteVersionNumber']==2
assert m['displayName']=='Chibi Knight' and m['spritesheetPath']=='spritesheet.webp'
print('pet.json: parses; exactly five required keys; values OK')
prev=Image.open(p/'preview.png')
assert prev.size==(2304,624)
print('preview:',prev.size,'rows 0,2,6,9 frame 0 at 3x')
print('colours:',len(im.convert('RGB').getcolors(1000))-1,'colours including the exclamation effect (excluding transparent black)')
assert not (p.parents[1]/'scripts/make-pet-knight.py').exists()
print('superseded scripts/make-pet-knight.py: deleted')
