# Render/encode test in a real browser: run `npx vite` then: python test/browser/run_render.py render:neon_dark_blue:1280:720:30:12
import asyncio, base64, json, sys, os
from playwright.async_api import async_playwright
CHROME = os.environ.get('CHROME') or None
OUT = os.environ.get('OUT', '.')
async def main(what):
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=(os.environ.get('CARGS') or '').split())
        pg = await b.new_page()
        logs = []
        pg.on('console', lambda m: logs.append(m.type + ': ' + m.text))
        pg.on('pageerror', lambda e: logs.append('PAGEERROR: ' + str(e)))
        await pg.goto('http://127.0.0.1:5173/test/browser/e2e.html' + (os.environ.get('Q') or ''))
        await pg.wait_for_function('window.__ready === true', timeout=60000)
        if what == 'caps':
            print(json.dumps(await pg.evaluate('window.__caps()'), indent=1))
        elif what.startswith('frames'):
            _, theme, w, h, lang, layout, mode = (what.split(':') + ['','1280','720','en','corner','active'])[:7] if ':' in what else ['', 'neon_dark_blue', '1280', '720', 'en', 'corner', 'active']
            res = await pg.evaluate(f'window.__frames({json.dumps(theme)}, [0.0, 0.15, 0.4, 0.62, 0.8, 0.97], {w}, {h}, {json.dumps(lang)}, {json.dumps(layout)}, {json.dumps(mode)})')
            for r in res:
                fn = f'{OUT}/{theme}_{w}x{h}_{lang}_{layout}_f{r["f"]}.png'
                open(fn, 'wb').write(base64.b64decode(r['png'].split(',')[1]))
                print(fn, 'prep %.0f ms draw %.1f ms' % (r['prep'], r['draw']))
        elif what.startswith('render'):
            _, theme, w, h, fps, dur = what.split(':')
            res = await pg.evaluate(f'window.__render({json.dumps(theme)}, {w}, {h}, {fps}, {dur})', )
            fn = f'{OUT}/render_{theme}_{w}x{h}.mp4'
            open(fn, 'wb').write(base64.b64decode(res.pop('b64')))
            print(fn, json.dumps(res))
        for l in logs[-15:]: print('LOG', l)
        await b.close()
asyncio.run(main(sys.argv[1]))
