"""Launcher icons and splash screens for Android from the TimelinerX brand assets.
    python scripts/make_android_assets.py <desktop-assets/brand>
"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter
BRAND = sys.argv[1] if len(sys.argv) > 1 else '../assets/brand'
RES = 'android/app/src/main/res'
NAVY = (11, 16, 32, 255)

mark = Image.open(os.path.join(BRAND, 'mark_dark.png')).convert('RGBA')
mark = mark.crop(mark.getbbox())
lockup = Image.open(os.path.join(BRAND, 'lockup_dark.png')).convert('RGBA')
lockup = lockup.crop(lockup.getbbox())

def fit(img, box_w, box_h):
    s = min(box_w / img.width, box_h / img.height)
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)

def centered(canvas, img):
    canvas.alpha_composite(img, ((canvas.width - img.width) // 2, (canvas.height - img.height) // 2))
    return canvas

def glow_bg(size):
    """Navy with a soft blue radial glow (brand gradient) for legacy icons and splash."""
    w, h = size
    bg = Image.new('RGBA', size, NAVY)
    g = Image.new('L', size, 0)
    d = ImageDraw.Draw(g)
    r = int(min(w, h) * 0.42)
    d.ellipse([w // 2 - r, h // 2 - r, w // 2 + r, h // 2 + r], fill=70)
    g = g.filter(ImageFilter.GaussianBlur(r * 0.55))
    tint = Image.new('RGBA', size, (20, 99, 230, 255))
    bg.paste(tint, (0, 0), g)
    return bg

DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for d, k in DENS.items():
    fg_size = round(108 * k)
    fg = Image.new('RGBA', (fg_size, fg_size), (0, 0, 0, 0))
    centered(fg, fit(mark, fg_size * 0.60, fg_size * 0.60))      # inside the 66 dp safe zone
    fg.save(f'{RES}/mipmap-{d}/ic_launcher_foreground.png')
    ls = round(48 * k)
    icon = glow_bg((ls, ls))
    centered(icon, fit(mark, ls * 0.74, ls * 0.74))
    mask = Image.new('L', (ls, ls), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, ls - 1, ls - 1], radius=round(ls * 0.22), fill=255)
    out = Image.new('RGBA', (ls, ls), (0, 0, 0, 0)); out.paste(icon, (0, 0), mask)
    out.save(f'{RES}/mipmap-{d}/ic_launcher.png')
    mask = Image.new('L', (ls, ls), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, ls - 1, ls - 1], fill=255)
    out = Image.new('RGBA', (ls, ls), (0, 0, 0, 0)); out.paste(icon, (0, 0), mask)
    out.save(f'{RES}/mipmap-{d}/ic_launcher_round.png')

for folder in os.listdir(RES):
    p = os.path.join(RES, folder, 'splash.png')
    if not os.path.exists(p): continue
    w, h = Image.open(p).size
    sp = glow_bg((w, h))
    centered(sp, fit(lockup, w * 0.62, h * 0.16))
    sp.convert('RGB').save(p, optimize=True)

# Android 12+ system splash icon (240 dp canvas, icon inside the 160 dp circle)
os.makedirs(f'{RES}/drawable', exist_ok=True)
ic = Image.new('RGBA', (960, 960), (0, 0, 0, 0))
centered(ic, fit(mark, 520, 520))
ic.save(f'{RES}/drawable/splash_icon.png')
print('icons + splash written')
