import { test, expect } from '@playwright/test';
import {writeFile}from'node:fs/promises';
test('capacity control creates a recoverable larger branch and can continue',async({page})=>{
  await page.goto('/');await expect(page.locator('#population')).toHaveText('2,000');
  await expect(page.locator('#cohort-capacity')).toContainText('/ 10,000');
  await page.locator('#expand-capacity').click();await expect(page.locator('#cohort-capacity')).toContainText('/ 20,000');
  await expect(page.locator('#branch-label')).toContainText('扩容');
  await page.locator('#step').click();await expect(page.locator('#day')).toHaveText('1');
  await page.locator('#save').click();await expect(page.locator('#save-status')).toContainText('已保存');
  await page.reload();await expect(page.locator('#cohort-capacity')).toContainText('/ 20,000');await expect(page.locator('#day')).toHaveText('1');
});
test('cosmic background can be explored without changing the ecological world',async({page})=>{
  await page.goto('/');await expect(page.locator('#population')).toHaveText('2,000');
  await page.locator('#open-cosmos').click();await expect(page.locator('#cosmos-dialog')).toBeVisible();
  await expect(page.locator('#cosmos-scale')).toHaveText('1.000');
  await page.locator('#cosmos-linked').uncheck();
  await page.locator('#cosmos-age').evaluate((el:HTMLInputElement)=>{el.value='1';el.dispatchEvent(new Event('input',{bubbles:true}));});
  const earlier=await page.locator('#cosmos-scale').textContent();expect(Number(earlier)).toBeLessThan(1);
  await page.locator('#cosmos-play').click();await expect(page.locator('#cosmos-play')).toContainText('暂停');
  await expect.poll(async()=>Number(await page.locator('#cosmos-scale').textContent())).toBeGreaterThan(Number(earlier));
  await page.locator('#cosmos-now').click();await expect(page.locator('#cosmos-hubble')).toHaveText('67.4');
  await page.screenshot({path:'reports/P8-cosmos.png',fullPage:true});
  await page.locator('#cosmos-planet').click();await expect(page.locator('#day')).toHaveText('0');await expect(page.locator('#population')).toHaveText('2,000');
  await expect(page.locator('#toast')).toBeHidden();
  await page.setViewportSize({width:390,height:844});await page.locator('#open-cosmos').click();
  expect(await page.locator('#cosmos-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await page.locator('#close-cosmos').click();
});
test('20480 real regions can run, zoom, inspect and restore',async({page})=>{
  await page.goto('/');await expect(page.locator('#population')).toHaveText('2,000');
  await page.locator('#new-world').click();await page.locator('#resolution').selectOption('20480');
  await page.locator('#scenario').selectOption('empty-planet');await page.getByRole('button',{name:'建立世界',exact:true}).click();
  await expect(page.locator('#cell-count')).toHaveText('20,480 个观察区域');await expect(page.locator('#population')).toHaveText('0');
  await page.locator('#duration').selectOption('10');await page.locator('#play').click();await expect(page.locator('#day')).toHaveText('10');
  const canvas=page.locator('#globe canvas'),box=(await canvas.boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-1100);
  await canvas.click({position:{x:box.width/2,y:box.height/2}});await expect(page.locator('#inspection')).toContainText('km²');
  await page.locator('#save').click();await expect(page.locator('#save-status')).toContainText('已保存');
  await page.screenshot({path:'reports/P8-fine-planet.png',fullPage:true});
  await page.reload();await expect(page.locator('#cell-count')).toHaveText('20,480 个观察区域');await expect(page.locator('#day')).toHaveText('10');
  await expect(page.locator('#toast')).toBeHidden();
});
test('planet loads, runs, pauses, switches layers and inspects a region',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#population')).toHaveText('2,000');
  await expect(page.locator('#globe canvas')).toBeVisible();
  await expect(page.locator('#history-storage')).toContainText('历史检查点');
  await page.locator('#step').click();await expect(page.locator('#day')).toHaveText('1');
  await page.locator('#duration').selectOption('10');await page.locator('#play').click();
  await expect(page.locator('#day')).toHaveText('11');await expect(page.locator('#run-status')).toHaveText('已暂停');
  await page.getByRole('button',{name:'温度',exact:true}).click();await expect(page.locator('#legend')).toContainText('260 K');
  await page.locator('#inspect-first').click();await expect(page.locator('#inspection h3')).toHaveText('区域 0');
  const before=await page.locator('#day').textContent();
  await page.mouse.move(400,350);await page.mouse.down();await page.mouse.move(550,380,{steps:8});await page.mouse.up();
  await expect(page.locator('#day')).toHaveText(before!);
  await page.screenshot({path:'reports/P3-desktop.png',fullPage:true});
  expect(errors).toEqual([]);await expect(page.locator('#toast')).toBeHidden();
});
test('creates an empty world and remains usable on a narrow screen',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  await expect(page.locator('#population')).toHaveText('2,000');
  await page.locator('#new-world').click();await page.locator('#scenario').selectOption('empty-planet');
  await page.getByRole('button',{name:'建立世界',exact:true}).click();await expect(page.locator('#population')).toHaveText('0');
  await page.locator('#step').click();await expect(page.locator('#day')).toHaveText('1');await expect(page.locator('#population')).toHaveText('0');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'reports/P3-mobile.png',fullPage:true});
});
test('save survives reload, rewind reproduces history, and export imports',async({page})=>{
  await page.goto('/');await expect(page.locator('#population')).toHaveText('2,000');
  await page.locator('#duration').selectOption('10');await page.locator('#play').click();await expect(page.locator('#day')).toHaveText('10');
  const count=await page.locator('#population').textContent();
  await page.locator('#save').click();await expect(page.locator('#save-status')).toContainText('已保存 · 第 10 日');
  await page.reload();await expect(page.locator('#day')).toHaveText('10');await expect(page.locator('#population')).toHaveText(count!);
  await page.locator('#seek').fill('0');await page.locator('#seek').dispatchEvent('change');await expect(page.locator('#day')).toHaveText('0');
  await page.locator('#play').click();await expect(page.locator('#day')).toHaveText('100');
  await page.locator('#seek').fill('10');await page.locator('#seek').dispatchEvent('change');await expect(page.locator('#population')).toHaveText(count!);
  const download=page.waitForEvent('download');await page.locator('#export').click();const file=await download;const path=await file.path();
  await page.locator('#import-file').setInputFiles(path!);await expect(page.locator('#day')).toHaveText('10');
});
test('storage failure is visible and does not destroy the in-memory world',async({page})=>{
  await page.goto('/');await expect(page.locator('#population')).toHaveText('2,000');await expect(page.locator('#save-status')).toContainText('已保存');
  await page.evaluate(()=>{IDBFactory.prototype.open=()=>{throw new DOMException('Test quota failure','QuotaExceededError');};});
  await page.locator('#save').click();await expect(page.locator('#save-status')).toContainText('保存失败');await expect(page.locator('#population')).toHaveText('2,000');
  await page.locator('#step').click();await expect(page.locator('#day')).toHaveText('1');
});
test('intervention forks a world, comparison works and all branches survive reload',async({page})=>{
  await page.goto('/');await expect(page.locator('#population')).toHaveText('2,000');
  await page.locator('#open-lab').click();await page.locator('#intervention-value').fill('1000');await page.locator('#apply-intervention').click();
  await expect(page.locator('.branch-row')).toHaveCount(2);await expect(page.locator('#branch-label')).toContainText('营养补给');
  await page.locator('#compare-run').click();await expect(page.locator('#comparison-result')).toContainText('第 10 日');await expect(page.locator('.comparison-row')).toHaveCount(4);
  await page.screenshot({path:'reports/P5-comparison.png',fullPage:true});
  await page.locator('#close-lab').click();await page.locator('#save').click();await expect(page.locator('#save-status')).toContainText('已保存 · 第 10 日');
  await page.reload();await expect(page.locator('#day')).toHaveText('10');await page.locator('#open-lab').click();await expect(page.locator('.branch-row')).toHaveCount(2);
  await page.locator('#branch-select').selectOption('main');await expect(page.locator('#branch-label')).toHaveText('主时间线');
});
test('cosmic guide and philosophical lenses are read-only and clearly labelled',async({page})=>{
  await page.goto('/');await expect(page.locator('#population')).toHaveText('2,000');
  await page.locator('#open-history').click();await expect(page.locator('#history-detail')).toContainText('知识导览 · 非模拟状态');
  await page.getByRole('button',{name:'智人的出现',exact:true}).click();await expect(page.locator('#history-detail')).toContainText('约 30 万年前');
  await expect(page.locator('#history-detail a')).toHaveAttribute('href',/humanorigins.si.edu/);
  await page.screenshot({path:'reports/P6-history.png',fullPage:true});await page.locator('#close-history').click();
  await page.locator('aside .model-notes summary').click();await page.locator('#lens').selectOption('wuyan');await expect(page.locator('#lens-description')).toContainText('不证明');
  await expect(page.locator('#day')).toHaveText('0');await expect(page.locator('#population')).toHaveText('2,000');
});
test('standard 1280-cell UI meets measured frame and pause responsiveness targets',async({page})=>{
  await page.goto('/');await expect(page.locator('#population')).toHaveText('2,000');await page.locator('#new-world').click();await page.locator('#resolution').selectOption('1280');await page.getByRole('button',{name:'建立世界',exact:true}).click();await expect(page.locator('#cell-count')).toHaveText('1,280 个观察区域');
  const canvas=page.locator('#globe canvas');await expect(canvas).toBeVisible();
  const start=performance.now(),before=Number(await canvas.getAttribute('data-rendered-frames'));
  await page.waitForTimeout(1500);const frames=Number(await canvas.getAttribute('data-rendered-frames'))-before,fps=frames*1000/(performance.now()-start);
  await page.locator('#duration').selectOption('1000');await page.locator('#play').click();await expect(page.locator('#run-status')).toHaveText('演化中');
  const pauseStart=performance.now();await page.locator('#play').click();await expect(page.locator('#run-status')).toHaveText('已暂停');const pauseMs=performance.now()-pauseStart;
  const heap=await page.evaluate(()=>(performance as any).memory?.usedJSHeapSize??null);
  await writeFile('reports/P6-browser-performance.json',JSON.stringify({viewport:{width:1440,height:1000},cells:1280,frames,fps,pauseMs,chromiumReportedJsHeapMB:heap?heap/1024**2:null,limitations:'Headless Chrome with software fallback allowed; JS heap is not complete browser/GPU RSS.'},null,2));
  expect(fps).toBeGreaterThanOrEqual(30);expect(pauseMs).toBeLessThanOrEqual(250);
  await page.getByRole('button',{name:'地表',exact:true}).click();await page.screenshot({path:'reports/P6-desktop.png',fullPage:true});
});
test('invalid import is rejected without replacing the live world',async({page})=>{
  await page.goto('/');await expect(page.locator('#population')).toHaveText('2,000');await page.locator('#step').click();await expect(page.locator('#day')).toHaveText('1');
  const population=await page.locator('#population').textContent();
  await page.locator('#import-file').setInputFiles({name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{"format":"broken"}')});
  await expect(page.locator('#toast')).toBeVisible();await expect(page.locator('#day')).toHaveText('1');await expect(page.locator('#population')).toHaveText(population!);
});

test('restored 1280 regions upgrade in place through a preserved branch',async({page})=>{
  await page.goto('/');await expect(page.locator('#population')).toHaveText('2,000');
  await page.locator('#new-world').click();await page.locator('#resolution').selectOption('1280');await page.getByRole('button',{name:'建立世界',exact:true}).click();
  await page.locator('#step').click();await expect(page.locator('#day')).toHaveText('1');const population=await page.locator('#population').textContent();
  await page.locator('#refine-world').click();await expect(page.locator('#cell-count')).toHaveText('5,120 个观察区域');
  await expect(page.locator('#day')).toHaveText('1');await expect(page.locator('#population')).toHaveText(population!);
  await page.locator('#save').click();await expect(page.locator('#save-status')).toContainText('已保存');await page.reload();
  await expect(page.locator('#cell-count')).toHaveText('5,120 个观察区域');await expect(page.locator('#day')).toHaveText('1');
});
test('cosmic playback advances the planet using the same completed day',async({page})=>{
  await page.goto('/');await expect(page.locator('#population')).toHaveText('2,000');await page.locator('#open-cosmos').click();
  await expect(page.locator('#cosmos-linked')).toBeChecked();await expect(page.locator('#cosmos-age')).toBeDisabled();
  await page.locator('#cosmos-play').click();await expect.poll(async()=>Number(await page.locator('#day').textContent())).toBeGreaterThan(1);
  await page.locator('#cosmos-play').click();await expect(page.locator('#cosmos-play')).toContainText('▶');await expect(page.locator('#cosmos-play')).toBeEnabled();
  await expect.poll(async()=>await page.locator('#cosmos-sync-status').textContent()).toContain('同步时刻');
  const day=await page.locator('#day').textContent();await expect(page.locator('#cosmos-sync-status')).toContainText(`星球第 ${day} 日`);
  await page.locator('#cosmos-planet').click();await expect(page.locator('#day')).toHaveText(day!);
});

test('galaxy gas forms stars, returns matter and survives full experiment reload',async({page})=>{
  await page.goto('/');await expect(page.locator('#population')).toHaveText('2,000');
  await page.locator('#open-cosmos').click();await page.locator('#open-galaxies').click();
  await expect(page.locator('#galaxy-age')).toHaveText('模型宇宙年龄 100 百万年');
  await expect(page.locator('#galaxy-summary')).toContainText('有恒星的气体晕 0 / 8');
  await page.getByRole('button',{name:'前进 1 亿年',exact:true}).click();
  await expect(page.locator('#galaxy-age')).toHaveText('模型宇宙年龄 200 百万年');
  await expect(page.locator('#galaxy-summary')).toHaveText(/有恒星的气体晕 [1-8] \/ [1-8]/);
  await expect(page.locator('#gravity-summary')).toContainText('局部孤立引力系统');
  await expect(page.locator('#galaxy-flux')).toContainText('质量账残差');
  await page.locator('.halo-node').first().click();await expect(page.locator('#galaxy-detail')).toContainText('估算总光度');
  for(const id of await page.locator('#galaxy-select option').evaluateAll(options=>options.map(o=>(o as HTMLOptionElement).value))){await page.locator('#galaxy-select').selectOption(id);await expect(page.locator('#galaxy-detail h3')).toHaveText(id);}
  await page.screenshot({path:'reports/P10B-galaxies.png',fullPage:true});
  await page.locator('#close-galaxies').click();await page.locator('#close-cosmos').click();
  await expect(page.locator('#day')).toHaveText('0');await page.locator('#save').click();await expect(page.locator('#save-status')).toContainText('已保存');
  await page.reload();await expect(page.locator('#population')).toHaveText('2,000');await page.locator('#open-cosmos').click();await page.locator('#open-galaxies').click();
  await expect(page.locator('#galaxy-age')).toHaveText('模型宇宙年龄 200 百万年');
  await page.setViewportSize({width:390,height:844});expect(await page.locator('#galaxy-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
});
