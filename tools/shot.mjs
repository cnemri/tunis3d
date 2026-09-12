// Headless screenshot helper: node tools/shot.mjs <out.png> [lat,lon,alt|landmarkId|overview] [hour] [waitMs]
import puppeteer from 'puppeteer-core';

const [out = '/tmp/shot.png', where = '', hour = '', waitMs = '12000'] = process.argv.slice(2);
const url = `http://127.0.0.1:5180/${/^-?\d/.test(where) ? '#' + where : ''}`;
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,800', '--disable-gpu-sandbox'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (!/vite|hmr/i.test(t)) console.log('[console]', m.type(), t.slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('requestfailed', (r) => { if (!/arcgisonline/.test(r.url())) console.log('[reqfail]', r.url(), r.failure()?.errorText); });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.app && window.app.renderer && document.getElementById('loading').style.display === 'none', { timeout: 90000 }).catch((e) => console.log('load wait:', e.message));
if (where && !/^-?\d/.test(where)) {
  await page.evaluate((w) => { if (w === 'overview') window.app.overview(); else window.app.gotoLandmark(w); }, where);
}
if (hour) await page.evaluate((h) => { window.app.setHour(parseFloat(h)); document.getElementById('hour').value = h; }, hour);
await new Promise((r) => setTimeout(r, parseInt(waitMs)));
if (process.env.PICK) { const [px, py] = process.env.PICK.split(',').map(Number); console.log('pick', JSON.stringify(await page.evaluate((x, y) => window.app.pick(x, y), px, py))); }
const info = await page.evaluate(() => ({ fps: window.app.fps, stats: window.app.world.stats, pos: window.app.camera.position.toArray().map((v) => Math.round(v)), inflight: window.app.world.imagery.inflight }));
console.log('state', JSON.stringify(info));
await page.screenshot(/\.jpe?g$/i.test(out) ? { path: out, type: 'jpeg', quality: 72 } : { path: out });
await browser.close();
console.log('saved', out);
process.exit(0);
