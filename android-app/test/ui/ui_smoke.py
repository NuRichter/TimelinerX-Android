# Browser UI smoke test (Playwright): serve dist/ (npx vite preview), then: URL=http://127.0.0.1:4173/index.html python test/ui/ui_smoke.py en
# UI end-to-end on a phone-sized viewport: home -> demo import -> analysis -> studio tabs -> render -> library.
import asyncio, sys, json, time
from playwright.async_api import async_playwright
import os
CHROME = os.environ.get('CHROME') or None
OUT = os.environ.get('OUT', './')
LANG = sys.argv[1] if len(sys.argv) > 1 else 'en'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=['--disable-gpu', '--disable-accelerated-2d-canvas', '--disable-gpu-compositing'])
        ctx = await b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True, locale=LANG)
        pg = await ctx.new_page()
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        pg.on('pageerror', lambda e: logs.append('PAGEERROR: ' + str(e)))
        await pg.goto(os.environ.get('URL', 'http://127.0.0.1:4173/index.html'))
        await pg.wait_for_selector('.headline', timeout=30000)
        await pg.wait_for_timeout(4000)
        await pg.screenshot(path=OUT + f'01_home_{LANG}.png')
        # demo import
        await pg.click('.cta .btn:not(.primary)')
        await pg.wait_for_selector('.sheet', timeout=60000)
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=OUT + f'02_analysis_{LANG}.png')
        await pg.click('.sheet .btn.primary')
        await pg.wait_for_selector('.player canvas', timeout=30000)
        await pg.wait_for_timeout(6000)
        await pg.screenshot(path=OUT + f'03_studio_journey_{LANG}.png')
        for i, name in enumerate(['camera', 'look', 'titles', 'video'], start=1):
            await pg.click(f'.tabs button:nth-child({i + 1})')
            await pg.wait_for_timeout(1500)
            await pg.screenshot(path=OUT + f'04_tab_{name}_{LANG}.png', full_page=True)
        # shorten the video so the render test is quick: set duration slider to 6 s
        await pg.evaluate("""() => { const s=[...document.querySelectorAll('input[type=range]')].find(x=>x.max==='300'); s.value='6'; s.dispatchEvent(new Event('input',{bubbles:true})); }""")
        await pg.evaluate("""() => { [...document.querySelectorAll('.chip')].find(x=>x.textContent.trim()==='720p').click(); }""")
        await pg.wait_for_timeout(1500)
        t0 = time.time()
        await pg.click('.renderbar .btn.primary')
        await pg.wait_for_timeout(4000)
        await pg.screenshot(path=OUT + f'05_rendering_{LANG}.png')
        await pg.wait_for_selector('video', timeout=600000)
        print('render seconds', round(time.time() - t0, 1))
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=OUT + f'06_done_{LANG}.png')
        info = await pg.evaluate("""async () => { const v=document.querySelector('video'); return {src: v.src.slice(0,30), dur: v.duration, w: v.videoWidth, h: v.videoHeight}; }""")
        print('video element', info)
        await pg.click('.btn.ghost.block')
        await pg.wait_for_timeout(800)
        await pg.click('.nav button:nth-child(3)')
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=OUT + f'07_library_{LANG}.png')
        await pg.click('.nav button:nth-child(4)')
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=OUT + f'08_settings_{LANG}.png', full_page=True)
        await pg.click('.nav button:nth-child(1)')
        await pg.wait_for_timeout(500)
        await pg.click('.topbar .iconbtn')
        await pg.wait_for_timeout(800)
        await pg.screenshot(path=OUT + f'09_about_{LANG}.png', full_page=True)
        print('\n'.join(logs[-25:]) or 'no console errors')
        await b.close()
asyncio.run(main())
