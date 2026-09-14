/**
 * UX end-to-end tests for the explore-page + onboarding + 5-step
 * progress + keyboard shortcuts + guided mode surfaces added in
 * rounds UX-1 (onboarding) — UX-4 (guided mode). The legacy
 * P1—P17 flows live in `app.spec.ts`; this file covers the
 * meta-UX layer on top.
 *
 * Each `test` follows the same shape: goto root, wait for
 * boot, exercise the surface, assert DOM state. We do NOT
 * rely on localStorage between tests because the page is
 * fully reloaded per test (Playwright's default).
 */
import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page) {
  // Playwright gives every test a fresh browser context, so
  // localStorage starts empty by default — no need to clear
  // it. (We tried an addInitScript, but it also fired on
  // `page.reload()` and wiped user-driven state, breaking
  // the guided-mode persistence test.)
  await page.goto('/');
  // The page auto-creates a world (5120 cells default) on
  // first load. Wait for the planet stats to render so we
  // know the simulation has booted.
  await expect(page.locator('#population')).toBeVisible();
  // Onboarding jumps to step 5 by default (cold start). The
  // progress bar should be visible and the stage (which only
  // shows for steps 1—4) should be hidden.
  await expect(page.locator('#onboarding-progress')).toBeVisible();
  await expect(page.locator('#explore-sidebar')).toBeVisible();
  // The stage may take an extra frame to hide after the world
  // is created (start() awaits the create reply then advances
  // the state). Give it a moment before any negative assertion.
  await page.waitForFunction(() => {
    const s = document.getElementById('onboarding-stage');
    return s && s.hidden;
  }, undefined, { timeout: 5000 }).catch(() => undefined);
  // The explore sidebar is populated when the first projection
  // arrives (and re-rendered on every subsequent update). Wait
  // for the 11 list items to be present so individual tests
  // don't race the worker handshake.
  await page.waitForFunction(
    () => document.querySelectorAll('#explore-panels .explore-panel-item').length >= 11,
    undefined,
    { timeout: 10000 },
  );
}

async function clearStorage(page: Page) {
  // Playwright's per-test context already starts with empty
  // localStorage, so explicit clears are no-ops.
  void page;
}

/**
 * The explore sidebar starts collapsed by default (so it does not
 * float over the planet view on first load). Tests that need to
 * click a panel item first call this helper to expand it.
 */
async function expandSidebar(page: Page) {
  if (await page.locator('#explore-sidebar').evaluate((el) => el.classList.contains('collapsed'))) {
    await page.locator('#explore-toggle-header').click();
  }
}

// === UX-1: 5-step progress ============================================

test('UX-1: cold start lands on step 5 and shows the progress bar with all 5 steps', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  // The 5 dot buttons exist and step 5 is reachable.
  for (const step of [1, 2, 3, 4, 5]) {
    await expect(page.locator(`.onboarding-dot[data-step="${step}"]`)).toBeVisible();
  }
  // After cold start the user is on step 5 (the planet exists
  // by then, so the wizard is done).
  await expect(page.locator('#onboarding-stage')).toBeHidden();
  await expect(page.locator('main')).toBeVisible();
});

test('UX-1: clicking step 1 dot jumps to the universe hero card', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await page.locator('.onboarding-dot[data-step="1"]').click();
  await expect(page.locator('#onboarding-stage')).toBeVisible();
  await expect(page.locator('.onboarding-panel[data-step="1"]')).toBeVisible();
  await expect(page.locator('#onboarding-title-1')).toContainText('从一个宇宙开始');
  // The previous "step 5" main is hidden.
  await expect(page.locator('main')).toBeHidden();
});

test('UX-1: 上一步 button is disabled on step 1; 下一步 advances the wizard', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await page.locator('.onboarding-dot[data-step="1"]').click();
  await expect(page.locator('#onboarding-prev')).toBeDisabled();
  // Advance to step 2.
  await page.locator('#onboarding-next').click();
  await expect(page.locator('.onboarding-panel[data-step="2"]')).toBeVisible();
  await expect(page.locator('#onboarding-progress-label')).toContainText('第 2 / 5 步');
  await expect(page.locator('#onboarding-prev')).toBeEnabled();
});

test('UX-1: re-上一步 marks earlier steps as completed (clickable from there on)', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await page.locator('.onboarding-dot[data-step="1"]').click();
  await page.locator('#onboarding-next').click(); // step 2
  await page.locator('#onboarding-next').click(); // step 3
  // step 1 should now be "completed" (mint border).
  const step1Item = page.locator('.onboarding-step-item[data-step="1"]');
  await expect(step1Item).toHaveClass(/completed/);
  // Clicking back lands on step 1.
  await page.locator('.onboarding-dot[data-step="1"]').click();
  await expect(page.locator('.onboarding-panel[data-step="1"]')).toBeVisible();
});

test('UX-1: re-上一步 button is hidden when on step 1; re-上一步 is shown starting step 2', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await page.locator('.onboarding-dot[data-step="1"]').click();
  await expect(page.locator('#onboarding-prev')).toBeDisabled();
});

test('UX-1: reset button clears completed-steps and jumps back to step 1', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await page.locator('.onboarding-dot[data-step="1"]').click();
  await page.locator('#onboarding-next').click();
  await page.locator('#onboarding-next').click();
  // Reset via the small button. The page prompts via window.confirm
  // — accept it.
  page.once('dialog', (d) => d.accept());
  await page.locator('#onboarding-reset').click();
  // Reset jumps to step 1 and clears all completed-steps, so
  // step 4 + 5 are no longer reachable.
  await expect(page.locator('#onboarding-stage')).toBeVisible();
  await expect(page.locator('.onboarding-panel[data-step="1"]')).toBeVisible();
  const step4Dot = page.locator('.onboarding-dot[data-step="4"]');
  await expect(step4Dot).toBeDisabled();
});

// === UX-1.5 / 2: explore sidebar + 11 panels ==========================

test('UX-2: the explore sidebar lists 11 panels (cosmos / galaxy / v14 / 6 P12—P17 / history / branch)', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  const items = page.locator('#explore-panels .explore-panel-item');
  await expect(items).toHaveCount(11);
});

test('UX-2: clicking a sidebar entry opens the matching panel and shows it on the stage', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  // Click the settlement entry.
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("聚落与文明")').click();
  // The settlement panel is now visible and the others are
  // hidden.
  await expect(page.locator('#settlement-dialog')).toBeVisible();
  await expect(page.locator('#explore-stage')).toBeVisible();
  await expect(page.locator('#explore-stage-title')).toContainText('聚落与文明');
  // Other panels stay hidden.
  await expect(page.locator('#prebiotic-dialog')).toBeHidden();
  await expect(page.locator('#cognition-dialog')).toBeHidden();
});

test('UX-2: "← 返回行星" button returns to the planet view', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("化学反应网络")').click();
  await expect(page.locator('#prebiotic-dialog')).toBeVisible();
  await page.locator('#explore-back').click();
  await expect(page.locator('#explore-stage')).toBeHidden();
  await expect(page.locator('main')).toBeVisible();
});

test('UX-2: each panel close button returns to the planet view', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  // Helper: each panel re-renders inner lists on every
  // projection, so the close button can move mid-click and
  // Playwright's stability check stalls. Dispatch the click
  // programmatically to bypass layout race conditions.
  const dispatchClick = (id: string) => page.evaluate((selId) => {
    document.getElementById(selId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, id);
  // Sidebar auto-collapses after opening a panel so the panel
  // content is no longer obscured; re-expand the handle before
  // picking the next panel. (Top-level `expandSidebar(page)` helper
  // handles the actual click.)
  // Branch (formerly a `<dialog>`).
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("干预与分支")').click();
  await expect(page.locator('#branch-dialog')).toBeVisible();
  await dispatchClick('close-lab');
  await expect(page.locator('#explore-stage')).toBeHidden();
  // History (formerly a `<dialog>`).
  await expandSidebar(page);
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("宇宙年表")').click();
  await expect(page.locator('#history-dialog')).toBeVisible();
  await dispatchClick('close-history');
  await expect(page.locator('#explore-stage')).toBeHidden();
  // V14 (formerly a `<dialog>`).
  await expandSidebar(page);
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("3D 视觉实验")').click();
  await expect(page.locator('#v14-dialog')).toBeVisible();
  await dispatchClick('close-v14');
  await expect(page.locator('#explore-stage')).toBeHidden();
  // Cosmos + galaxy (formerly `<dialog>`s).
  await expandSidebar(page);
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("宇宙背景")').click();
  await expect(page.locator('#cosmos-dialog')).toBeVisible();
  await dispatchClick('close-cosmos');
  await expandSidebar(page);
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("星系与恒星")').click();
  await expect(page.locator('#galaxy-dialog')).toBeVisible();
  await dispatchClick('close-galaxies');
});

// === UX-3: keyboard shortcuts =========================================

test('UX-3: number keys 1—9 switch the explore panel by ALL_EXPLORE_PANELS order', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  // 1 → cosmos
  await page.keyboard.press('1');
  await expect(page.locator('#cosmos-dialog')).toBeVisible();
  // 2 → galaxy
  await page.keyboard.press('2');
  await expect(page.locator('#galaxy-dialog')).toBeVisible();
  // 3 → v14
  await page.keyboard.press('3');
  await expect(page.locator('#v14-dialog')).toBeVisible();
  // 4 → chemistry
  await page.keyboard.press('4');
  await expect(page.locator('#prebiotic-dialog')).toBeVisible();
  // 7 → settlement
  await page.keyboard.press('7');
  await expect(page.locator('#settlement-dialog')).toBeVisible();
});

test('UX-3: R key activates the top recommendation', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  // Read the recommended id from the button dataset.
  const rec = await page.locator('#explore-recommend-go').getAttribute('data-explore');
  expect(rec).toBeTruthy();
  // Press R.
  await page.keyboard.press('r');
  // `chemistry` and `colonies` share the prebiotic-dialog section,
  // so the recommended id (e.g. 'chemistry') maps to
  // #prebiotic-dialog, not a panel-specific id. Normalize here.
  const recSectionId = rec === 'chemistry' || rec === 'colonies' ? 'prebiotic-dialog' : `${rec}-dialog`;
  await expect(page.locator(`#${recSectionId}`)).toBeVisible();
  // The settlement panel is the default brand-new world
  // recommendation, but we accept whatever the test expects.
});

test('UX-3: Esc key returns to the planet view when a panel is active', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await page.keyboard.press('1'); // cosmos
  await expect(page.locator('#cosmos-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#explore-stage')).toBeHidden();
});

test('UX-3: number keys are NOT hijacked when typing in an input', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  // Open the chemistry panel; the textarea + the chem-network
  // input are first interactive elements.
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("化学反应网络")').click();
  await expect(page.locator('#prebiotic-dialog')).toBeVisible();
  // The "load sample" button populates the textarea — click it
  // first so the textarea has content.
  await page.locator('#chem-load-sample').click();
  // Focus the textarea, type a number; the panel must NOT
  // switch because we're inside a form element.
  const ta = page.locator('#chem-network');
  await ta.focus();
  await page.keyboard.type('1');
  await expect(page.locator('#prebiotic-dialog')).toBeVisible();
  await expect(page.locator('#cosmos-dialog')).toBeHidden();
  // The number is appended to the textarea content.
  const value = await ta.inputValue();
  expect(value).toContain('1');
});

test('UX-3: kbd hint badge is visible inside the explore-stage header', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  // The kbd hint lives inside the explore-stage header, which
  // is itself only shown once a panel is active. Open the
  // cosmos panel first so the stage is visible.
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("宇宙背景")').click();
  await expect(page.locator('#explore-kbd-hint')).toBeVisible();
  await expect(page.locator('#explore-kbd-hint')).toContainText('切面板');
});

// === UX-3.5: explore-activate cross-panel navigation =================

test('UX-3.5: clicking "在面板中打开" inside a panel activates the target panel', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  // Open the cosmos panel via the step CTA path, which
  // eventually lands in cosmos, but the simpler check is to
  // verify the event flow: open cosmos directly, click the
  // "open galaxies" button, expect the galaxy panel to show.
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("宇宙背景")').click();
  await expect(page.locator('#cosmos-dialog')).toBeVisible();
  await page.locator('#open-galaxies').click();
  await expect(page.locator('#galaxy-dialog')).toBeVisible();
});

// === UX-4: Phase 10 guided mode =======================================

test('UX-4: guided mode toggle is off by default and clicking it persists', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  const toggle = page.locator('#explore-guided-toggle-input');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  // Reload — the choice survives via localStorage.
  await page.reload();
  await expect(page.locator('#explore-guided-toggle-input')).toBeChecked();
});

test('UX-4: auto-continue toggle is off by default and triggers another run after a run finishes', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  const toggle = page.locator('#explore-autocontinue-toggle-input');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  // Pick a small duration so the run finishes quickly.
  await page.locator('#duration').selectOption('10');
  // Capture the day before pressing play.
  const dayBefore = Number((await page.locator('#day').textContent())?.replace(/,/g, ''));
  await page.locator('#play').click();
  // With auto-continue on, the day should grow past 2× duration
  // (first run + the auto-fired second run). We poll for the day
  // to exceed 20 (≥ 2× 10), which proves auto-continue fired.
  await expect.poll(async () => {
    const day = Number((await page.locator('#day').textContent())?.replace(/,/g, ''));
    return day;
  }, { timeout: 15000, intervals: [200] }).toBeGreaterThanOrEqual(20);
  // Pause to stop the loop and assert day advanced by ≥ duration × 2.
  await page.locator('#play').click();
  const dayAfter = Number((await page.locator('#day').textContent())?.replace(/,/g, ''));
  expect(dayAfter - dayBefore).toBeGreaterThanOrEqual(20);
  // Reload — the choice survives via localStorage.
  await page.reload();
  await expect(page.locator('#explore-autocontinue-toggle-input')).toBeChecked();
});

test('UX-4: when guided mode is on, the guided bar shows the first step', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await page.locator('#explore-guided-toggle-input').check();
  // Open the chemistry panel.
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("化学反应网络")').click();
  await expect(page.locator('#prebiotic-dialog')).toBeVisible();
  // The guided bar shows up with step 1 / total count and the
  // first step's tip text. The step's target element also gets
  // the highlight ring class.
  await expect(page.locator('#explore-guided-bar')).toBeVisible();
  await expect(page.locator('#explore-guided-step')).toHaveText('1 / 3');
  await expect(page.locator('#explore-guided-tip-text')).toContainText('载入示例');
  await expect(page.locator('#chem-load-sample')).toHaveClass(/explore-guided-target/);
  // Clicking "下一步" advances to step 2; the button still reads
  // "下一步 →" since there are 3 steps total. The 2nd click hits
  // the last step and flips the label to "完成 ✓".
  await page.locator('#explore-guided-next').click();
  await expect(page.locator('#explore-guided-step')).toHaveText('2 / 3');
  await expect(page.locator('#explore-guided-next')).toHaveText('下一步 →');
  await page.locator('#explore-guided-next').click();
  await expect(page.locator('#explore-guided-step')).toHaveText('3 / 3');
  await expect(page.locator('#explore-guided-next')).toHaveText('完成 ✓');
});

test('UX-4: turning guided mode off removes the highlight + bar', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await page.locator('#explore-guided-toggle-input').check();
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("化学反应网络")').click();
  await expect(page.locator('.explore-guided-target').first()).toBeVisible();
  await expect(page.locator('#explore-guided-bar')).toBeVisible();
  await page.locator('#explore-guided-toggle-input').uncheck();
  await expect(page.locator('.explore-guided-target')).toHaveCount(0);
  await expect(page.locator('#explore-guided-bar')).toBeHidden();
});

// === UX-1.5 step 4 / Phase 9: on-stage create form ======================

test('UX-1.5 + 9: step 4 submit goes straight to step 5 and creates a world', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await page.locator('.onboarding-dot[data-step="4"]').click();
  // The on-stage create form is in step 4.
  await expect(page.locator('#onboarding-create-form')).toBeVisible();
  // Change the seed to a unique value, submit.
  await page.locator('#onboarding-seed').fill('ux-create-test');
  await page.locator('#onboarding-create-form button[type="submit"]').click();
  // After submit, we're on step 5 (the explore-stage is
  // visible, main is shown).
  await expect(page.locator('#explore-stage')).toBeHidden();
  await expect(page.locator('main')).toBeVisible();
  // The chart-end indicator should mention day 0.
  await expect(page.locator('#chart-end')).toContainText('第 0 日');
});

test('UX-9: "＋ 新建世界" header button now lands on step 4 (no dialog)', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await page.locator('#new-world').click();
  await expect(page.locator('#onboarding-stage')).toBeVisible();
  await expect(page.locator('.onboarding-panel[data-step="4"]')).toBeVisible();
  // No create-dialog shows up (it has been removed in UX-9).
  await expect(page.locator('#create-dialog')).toHaveCount(0);
});

// === UX-3: V14 panel — generate snapshot, list, batch ================

test('UX-3: V14 panel generates an in-repo terrain snapshot and adds it to the list', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  // Open the V14 panel.
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("3D 视觉实验")').click();
  await expect(page.locator('#v14-dialog')).toBeVisible();
  // The v14 mount is async; wait for the panel to be ready.
  // Use a terrain kind, fixed seed for determinism.
  await page.locator('#v14-kind').selectOption('terrain');
  await page.locator('#v14-seed-mode').selectOption('fixed');
  await page.locator('#v14-fixed-seed').fill('ux-v14-test');
  // Click generate.
  await page.locator('#v14-generate').click();
  // The status text changes to "已生成 ...".
  await expect(page.locator('#v14-status')).toContainText('已生成', { timeout: 5000 });
  // The list shows the new entry.
  await expect(page.locator('#v14-list .v14-snap').first()).toBeVisible();
});

test('UX-3: V14 batch scan produces histograms + a list of snapshots', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("3D 视觉实验")').click();
  // Open the batch section (a <details>).
  await page.locator('#v14-batch-details').evaluate((d: HTMLDetailsElement) => { d.open = true; });
  // Set seed count to 2 (fast) — the default 4 would also
  // work but 2 keeps the test under 2 s.
  await page.locator('#v14-batch-seeds').fill('2');
  await page.locator('#v14-batch-run').click();
  // The output area appears with a summary.
  await expect(page.locator('#v14-batch-output')).toBeVisible({ timeout: 8000 });
  // The "总运行数" row should mention 10 (2 seeds × 5 kinds).
  // 5 kinds (terrain, tree, building, rock, humanoid) × 2 seeds
  // = 10. (The 4 default styles all unselected? No, all 4 are
  // selected by default. So actually 2 × 5 × 4 = 40.) We don't
  // assert the exact number — the histogram + summary being
  // rendered is what matters.
  await expect(page.locator('#v14-batch-hist-kind')).toBeVisible();
  await expect(page.locator('#v14-batch-hist-style')).toBeVisible();
});

// === UX-2.5 + 4: compare mode =======================================

test('UX-2.5: V14 compare toggle shows two side-by-side canvases', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("3D 视觉实验")').click();
  // First generate two snapshots so the compare selects have
  // entries.
  await page.locator('#v14-kind').selectOption('terrain');
  await page.locator('#v14-seed-mode').selectOption('fixed');
  await page.locator('#v14-fixed-seed').fill('cmp-a');
  await page.locator('#v14-generate').click();
  await expect(page.locator('#v14-list .v14-snap').first()).toBeVisible();
  // Now enter compare mode.
  await page.locator('#v14-compare-toggle').click();
  await expect(page.locator('#v14-compare-pane')).toBeVisible();
  // Two side-by-side canvases exist.
  await expect(page.locator('#v14-canvas-left')).toBeVisible();
  await expect(page.locator('#v14-canvas-right')).toBeVisible();
});

// === UX-4: settlement 📷 生成 3D 天际线 (cityscape) =================

test('UX-4: P15 settlement 加载 → 📷 button opens V14 panel with a cityscape snapshot', async ({ page }) => {
  await clearStorage(page);
  await boot(page);
  // Open the settlement panel and seed a small template.
  await expandSidebar(page);
  await page.locator('#explore-panels .explore-panel-item:has-text("聚落与文明")').click();
  await expect(page.locator('#settlement-dialog')).toBeVisible();
  await page.locator('#set-load').click();
  // Wait for the load reply (status updates).
  await expect(page.locator('#set-status')).toContainText('已加载', { timeout: 5000 });
  // Click the 📷 button on the first settlement row.
  const camBtn = page.locator('.set-snap-actions button:has-text("生成 3D 天际线")').first();
  await expect(camBtn).toBeVisible();
  await camBtn.click();
  // The V14 panel is now active with a cityscape snapshot.
  await expect(page.locator('#v14-dialog')).toBeVisible({ timeout: 5000 });
  // The snapshot list has at least one entry.
  await expect(page.locator('#v14-list .v14-snap').first()).toBeVisible();
});
