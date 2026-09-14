import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:9151/');
await page.waitForSelector('#population');
// turn on guided
await page.locator('#explore-guided-toggle-input').check();
await page.waitForTimeout(200);
const bar = await page.evaluate(() => {
  const b = document.getElementById('explore-guided-bar');
  const t = document.getElementById('explore-guided-tip-text');
  return {
    barExists: !!b,
    barHidden: b ? b.hidden : null,
    barHTML: b ? b.outerHTML.slice(0,200) : null,
    tipExists: !!t,
    tipText: t ? t.textContent : null,
  };
});
console.log(JSON.stringify(bar, null, 2));
// open chemistry
await page.locator('#explore-toggle-header').click();
await page.locator('#explore-panels .explore-panel-item:has-text("化学反应网络")').click();
await page.waitForTimeout(500);
const bar2 = await page.evaluate(() => {
  const b = document.getElementById('explore-guided-bar');
  const t = document.getElementById('explore-guided-tip-text');
  return {
    barHidden: b ? b.hidden : null,
    tipText: t ? t.textContent : null,
    stepText: document.getElementById('explore-guided-step')?.textContent,
  };
});
console.log(JSON.stringify(bar2, null, 2));
await browser.close();
