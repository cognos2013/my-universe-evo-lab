import { chromium } from '@playwright/test';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:9150/');
await page.evaluate(async () => {
  await new Promise((r) => { const req = indexedDB.deleteDatabase('my-universe'); req.onsuccess = r; req.onerror = r; req.onblocked = r; });
  localStorage.clear();
});
await page.reload();
await page.waitForSelector('#population', { timeout: 10000 });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const step5 = document.querySelector('.onboarding-dot[data-step="5"]');
  if (step5) step5.click();
});
await page.waitForTimeout(800);
await page.locator('#globe').scrollIntoViewIfNeeded();
await page.waitForTimeout(500);
const box = await page.locator('#globe').boundingBox();
if (box) await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(5000);

// ALL OFF baseline
async function set(name, on) {
  await page.evaluate(({n, v}) => {
    const cb = document.querySelector(`input[data-layer="${n}"]`);
    if (cb && cb.checked !== v) cb.click();
  }, {n: name, v: on});
  await page.waitForTimeout(600);
}

await set('settlement', false);
await set('biomass', false);
await set('weather', false);
await set('vegetation', false);
await page.screenshot({ path: '/tmp/toggle-A-all-off.png' });
console.log('A: all off');

await set('settlement', true);
await page.screenshot({ path: '/tmp/toggle-B-only-settle.png' });
console.log('B: only settlement');

await set('settlement', false);
await set('biomass', true);
await page.screenshot({ path: '/tmp/toggle-C-only-biomass.png' });
console.log('C: only biomass');

await set('biomass', false);
await set('weather', true);
await page.screenshot({ path: '/tmp/toggle-D-only-weather.png' });
console.log('D: only weather');

await set('weather', false);
await set('vegetation', true);
await page.screenshot({ path: '/tmp/toggle-E-only-vegetation.png' });
console.log('E: only vegetation');

await browser.close();
