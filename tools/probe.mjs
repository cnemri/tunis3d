// node tools/probe.mjs lat,lon,alt,heading,pitch x,z radius  -> dump wall vertices near (x,z)
import puppeteer from 'puppeteer-core';
const [where, xz, rad = '6'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:5180/#${where}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app && window.app.world && window.app.world.stats.chunksLoaded > 3, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 8000));
const out = await page.evaluate((xz, rad) => {
  const [X, Z] = xz.split(',').map(Number); const R = Number(rad); const res = {};
  window.app.scene.traverse((o) => {
    if (o.name !== 'walls') return;
    const p = o.geometry.attributes.position, c = o.geometry.attributes.color, s = o.geometry.attributes.style;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      if (Math.abs(x - X) < R && Math.abs(z - Z) < R) {
        const k = `${o.parent.name} col=${c.getX(i).toFixed(2)},${c.getY(i).toFixed(2)},${c.getZ(i).toFixed(2)} style=${s ? s.getX(i) : '?'} y=${Math.round(p.getY(i))}`;
        res[k] = (res[k] || 0) + 1;
      }
    }
  });
  return res;
}, xz, rad);
console.log(JSON.stringify(out, null, 1));
await browser.close();
