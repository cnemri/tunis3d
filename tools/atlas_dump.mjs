import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.app && window.app.shared && window.app.shared.facadeAtlas, { timeout: 60000 });
const data = await page.evaluate(() => {
  const tex = window.app.shared.facadeAtlas; const S = tex.image.width; const L = 2;
  const c = document.createElement('canvas'); c.width = S; c.height = S; const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S); const src = tex.image.data.subarray(L * S * S * 4, (L + 1) * S * S * 4);
  for (let i = 0; i < S * S; i++) { img.data[i * 4] = src[i * 4]; img.data[i * 4 + 1] = src[i * 4 + 1]; img.data[i * 4 + 2] = src[i * 4 + 2]; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0); return c.toDataURL('image/png');
});
const fs = await import('fs'); fs.writeFileSync('/tmp/atlas_office.png', Buffer.from(data.split(',')[1], 'base64'));
await browser.close(); console.log('ok');
