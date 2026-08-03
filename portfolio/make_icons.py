from PIL import Image, ImageDraw

BG=(15,20,32,255)
GREEN=(34,197,94,255)
RED=(239,68,68,255)
ACC=(79,140,255,255)
MUT=(139,147,167,255)

def candle(d, cx, w, top, bot, col):
    d.rectangle([cx-w//2, top, cx+w//2, bot], fill=col)
    d.rectangle([cx-1, top-8, cx+1, bot+8], fill=col)

def render(size, maskable=False):
    img=Image.new('RGBA',(size,size),(0,0,0,0))
    d=ImageDraw.Draw(img)
    m=int(size*0.04)
    d.rounded_rectangle([m,m,size-m,size-m], radius=int(size*0.18), fill=BG)
    pad=int(size*0.22) if maskable else int(size*0.16)
    x0,x1,y0,y1=pad,size-pad,pad,size-pad
    cy=(y0+y1)//2
    cw=int(size*0.045)
    # baseline
    d.line([x0, y1, x1, y1], fill=MUT, width=max(1,int(size*0.008)))
    # candles: red down, green up, green up
    w1=int((x1-x0)*0.28); w2=int((x1-x0)*0.30); w3=int((x1-x0)*0.26)
    c1x=x0+w1; c2x=x0+w1+w2+int(size*0.05); c3x=x0+w1+w2+w3+int(size*0.08)
    candle(d,c1x,cw,y1-int(size*0.42),y1,RED)
    candle(d,c2x,cw,y1-int(size*0.60),y1-int(size*0.18),GREEN)
    candle(d,c3x,cw,y0,y1-int(size*0.46),GREEN)
    # trend line
    pts=[(c1x+int(size*0.05), y1-int(size*0.46)), (c2x+int(size*0.04), y1-int(size*0.64)), (c3x, y0+int(size*0.10))]
    d.line(pts, fill=ACC, width=max(2,int(size*0.02)))
    return img

for s in (192,512):
    render(s).save(f'/tmp/intervals-icu-repo/portfolio/icons/icon-{s}.png')
render(512, maskable=True).save('/tmp/intervals-icu-repo/portfolio/icons/icon-maskable-512.png')
print('icons done')
