"""Render the README architecture animation. Requires Pillow; no model calls."""
from pathlib import Path
import math
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/assets'
OUT.mkdir(parents=True, exist_ok=True)
FONT_DIR = Path('/System/Library/Fonts/Supplemental')
def font(size, bold=False):
    candidates = [FONT_DIR / ('Arial Bold.ttf' if bold else 'Arial.ttf'), Path('/usr/share/fonts/truetype/dejavu') / ('DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf')]
    return ImageFont.truetype(str(next(p for p in candidates if p.exists())), size)

BG, INK, MUTED, GREEN, BLUE = '#f5f7f6', '#18392f', '#65756e', '#21866a', '#497bc0'
steps = [
    ('01 / SUBMIT', 'Seal E/I, protocol and budget; approve the exact manifest.'),
    ('02 / CLAIM', 'Runner verifies the lease, fixed environment and authorized limits.'),
    ('03 / PROPOSE', 'Retained I proposes a candidate H. B fixes I; C may evolve E and I.'),
    ('04 / LOOK AHEAD', 'Call candidate I once; use temporary E to learn and score from P0.'),
    ('05 / SELECT', 'Gate compares parent and candidate. Accept H or retain the parent.'),
    ('06 / INHERIT', 'Accepted I becomes the next proposer. Freeze B/C, audit and report.')
]

def frame(index):
    phase, progress = divmod(index, 18)
    im = Image.new('RGB', (1280, 910), BG)
    d = ImageDraw.Draw(im)
    def text(x, y, s, size=18, color=INK, bold=False):
        d.text((x, y), s, font=font(size, bold), fill=color)
    def box(rect, title, lines, active=False, accent=GREEN):
        d.rounded_rectangle(rect, 16, fill='#e7f4ee' if active else 'white', outline=accent if active else '#d7e1dc', width=3 if active else 1)
        x,y,_,_=rect
        text(x+20,y+18,title,21,accent if active else INK,True)
        for n,line in enumerate(lines):text(x+20,y+53+n*25,line,17,MUTED)
    def arrow(points, active=False, color=GREEN):
        d.line(points, fill=color if active else '#aebfb6', width=3, joint='curve')
        x,y=points[-1]; px,py=points[-2]; a=math.atan2(y-py,x-px)
        d.polygon([(x,y),(x-11*math.cos(a-.5),y-11*math.sin(a-.5)),(x-11*math.cos(a+.5),y-11*math.sin(a+.5))], fill=color if active else '#aebfb6')
        if active:
            lengths=[math.dist(points[i],points[i+1]) for i in range(len(points)-1)]
            dist=sum(lengths)*(progress/18)
            for i,L in enumerate(lengths):
                if dist<=L:
                    x=points[i][0]+(points[i+1][0]-points[i][0])*dist/L;y=points[i][1]+(points[i+1][1]-points[i][1])*dist/L
                    d.ellipse((x-6,y-6,x+6,y+6),fill=color);break
                dist-=L
    text(40,24,'GEAR x MONECRAFT',16,GREEN,True)
    text(40,51,'RSI Arena',40,INK,True)
    text(300,69,'Evolve the improver. Evaluate the inherited behavior.',21,MUTED)
    text(40,112,'PLATFORM  /  OUR WEBSITE + INDEPENDENT RUNNER',14,MUTED,True)
    box((40,142,360,253),'Submit & approve',['E/I instructions + sealed manifest','Owner approval + bounded budget'],phase==0)
    box((480,142,800,253),'Independent runner',['Claim / heartbeat / cancellation','Verify environment and invoke Gear'],phase==1)
    box((920,142,1240,253),'Evidence & website',['D1: jobs, leases, usage records','R2: replays, lineage, results'],phase==5)
    arrow([(360,196),(480,196)],phase==1)
    arrow([(800,196),(920,196)],phase==5)
    arrow([(640,253),(640,307)],phase==1)
    d.rounded_rectangle((40,307,1240,716),20,fill='#edf2ef',outline='#cadbd1',width=1)
    text(62,327,'GEAR ARENA  /  OUR PROTOCOL EXTENSION ON GEAR',16,GREEN,True)
    text(62,358,'Fixed model + fixed MoneCraft referee. Only the accepted harness crosses generations.',18,MUTED)
    box((65,404,310,548),'Retained H = (E, I)',['E: task learning instructions','I: improvement instructions','Same initial H for B and C'],phase==5)
    box((365,404,610,548),'Propose H\u2032',['Current I proposes E\u2032 / I\u2032','B: I remains fixed','C: E and I may change'],phase==2)
    box((665,404,910,548),'One-step evaluation',['I\u2032 -> temporary E / I','Run temporary E from P0','Train -> revise -> score'],phase==3,BLUE)
    box((965,404,1215,548),'Gate & selection',['Evaluate parent / candidate','Accept the complete H\u2032','Or keep the parent H'],phase==4)
    arrow([(310,475),(365,475)],phase==2)
    arrow([(610,475),(665,475)],phase==3,BLUE)
    arrow([(910,475),(965,475)],phase==4)
    text(680,566,'Temporary I is discarded.',16,BLUE,True)
    text(680,589,'No recursive expansion inside an episode.',14,MUTED)
    arrow([(1090,548),(1090,650),(188,650),(188,548)],phase==5)
    text(315,665,'INHERIT: the retained I is actually called to propose the next generation.',18,GREEN,True)
    box((40,739,1240,814),'Fixed controls across every external action',[
        'Reserve before use  /  Settle confirmed usage  /  Keep unknown usage reserved  /  Stop at budget or lease limits'
    ],False)
    text(40,840,steps[phase][0],16,GREEN,True)
    text(230,838,steps[phase][1],18,INK)
    text(40,878,'Protocol illustration, not an experiment replay. Current service: one search generation + frozen B/C audit.',15,MUTED)
    for j in range(6):d.rounded_rectangle((1090+j*26,48,1107+j*26,54),3,fill=GREEN if j==phase else '#d4dfd8')
    return im

frames=[frame(i) for i in range(108)]
frames[54].save(OUT/'rsi-architecture.png')
frames[0].save(OUT/'rsi-architecture.gif',save_all=True,append_images=frames[1:],duration=110,loop=0,optimize=True,disposal=2)
print(OUT/'rsi-architecture.gif')
