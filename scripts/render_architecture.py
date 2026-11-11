"""README diagram: python -m pip install Pillow; python scripts/render_architecture.py."""
from pathlib import Path
import math
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / 'docs/assets'
OUT.mkdir(parents=True, exist_ok=True)
def font(size, bold=False):
    names = [Path('/System/Library/Fonts/Supplemental') / ('Arial Bold.ttf' if bold else 'Arial.ttf'), Path('/usr/share/fonts/truetype/dejavu') / ('DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf')]
    return ImageFont.truetype(str(next(p for p in names if p.exists())), size)

INK, MUTED, GREEN, BLUE = '#18392f', '#687c72', '#21866a', '#497bc0'
def frame(i):
    phase, tick = divmod(i, 12)
    im = Image.new('RGB', (1100, 620), '#f6f8f7'); d = ImageDraw.Draw(im)
    def text(x,y,s,size=20,color=INK,bold=False): d.text((x,y),s,font=font(size,bold),fill=color)
    def card(rect,title,sub='',active=False,color=GREEN):
        d.rounded_rectangle(rect,16,fill='#e7f4ee' if active else 'white',outline=color if active else '#d8e2dd',width=3 if active else 1)
        x,y,x2,y2=rect
        for s,yy,size,bold,c in [(title,y+20,23,True,color if active else INK),(sub,y+57,17,False,MUTED)]:
            if s:text((x+x2-d.textlength(s,font=font(size,bold)))/2,yy,s,size,c,bold)
    def arrow(points,active=False,color=GREEN):
        color=color if active else '#b0c1b8';d.line(points,fill=color,width=3,joint='curve')
        x,y=points[-1];px,py=points[-2];a=math.atan2(y-py,x-px)
        d.polygon([(x,y),(x-10*math.cos(a-.5),y-10*math.sin(a-.5)),(x-10*math.cos(a+.5),y-10*math.sin(a+.5))],fill=color)
        if active:
            lengths=[math.dist(a,b) for a,b in zip(points,points[1:])];dist=sum(lengths)*tick/12
            for j,L in enumerate(lengths):
                if dist<=L:
                    x=points[j][0]+(points[j+1][0]-points[j][0])*dist/L;y=points[j][1]+(points[j+1][1]-points[j][1])*dist/L
                    d.ellipse((x-6,y-6,x+6,y+6),fill=color);break
                dist-=L
    text(35,25,'RSI Arena',36,INK,True)
    text(260,39,'Improve the improver.',22,MUTED)
    text(35,96,'PLATFORM',13,MUTED,True)
    card((35,123,285,190),'Website',active=phase==0)
    card((425,123,675,190),'Runner',active=phase==1)
    card((815,123,1065,190),'Results',active=phase==5)
    arrow([(285,157),(425,157)],phase==1)
    arrow([(675,157),(815,157)],phase==5)
    arrow([(550,190),(550,244)],phase==1)
    d.rounded_rectangle((35,244,1065,528),20,fill='#edf2ef',outline='#d4e0d9')
    text(55,262,'GEAR ARENA',14,GREEN,True)
    card((55,308,265,412),'H = (E, I)','retained harness',phase==5)
    card((315,308,525,412),'Propose','I → E′ / I′',phase==2)
    card((575,308,785,412),'Learn & play','one-step · MoneCraft',phase==3,BLUE)
    card((835,308,1045,412),'Select','accept / retain',phase==4)
    arrow([(265,360),(315,360)],phase==2)
    arrow([(525,360),(575,360)],phase==3,BLUE)
    arrow([(785,360),(835,360)],phase==4)
    arrow([(940,412),(940,465),(160,465),(160,412)],phase==5)
    text(380,481,'Inherit accepted E / I',22,GREEN,True)
    text(35,558,'FIXED',14,MUTED,True)
    text(110,552,'Model   ·   Referee   ·   Budget',22,INK)
    labels=['Submit & approve','Claim & verify','Propose','One-step evaluation','Gate','Inherit & report']
    s=labels[phase];text(1065-d.textlength(s,font=font(18,True)),556,s,18,GREEN,True)
    for j in range(6):d.rounded_rectangle((914+j*26,47,929+j*26,52),2,fill=GREEN if j==phase else '#d4dfd8')
    return im

frames=[frame(i) for i in range(72)]
frames[36].save(OUT/'rsi-architecture.png')
frames[0].save(OUT/'rsi-architecture.gif',save_all=True,append_images=frames[1:],duration=140,loop=0,optimize=True,disposal=2)
print(OUT/'rsi-architecture.gif')
