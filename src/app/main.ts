import {mountGalaxies} from './galaxies.ts';
import { mountCosmos } from './cosmos.ts';
import { mountPrebiotic } from './prebiotic.ts';
import { mountCognition } from './cognition.ts';
import { mountSettlement } from './settlement.ts';
import { mountEarth } from './earth.ts';
import { mountBatch } from './batch.ts';
import { mountV14 } from './v14.ts';
import {
  loadOnboardingState,
  saveOnboardingState,
  advanceOnboardingState,
  isStepReachable,
  loadBootChoice,
  saveBootChoice,
  clearBootChoice,
  ALL_ROLES,
  ROLE_META,
  STEP_COMPLETION,
  nextStepAfterCompletion,
  setStep5Phase,
  step5aComplete,
  step5bComplete,
  STEP_5A_DONE_TICK,
  STEP_5B_DONE_TICK,
  type OnboardingStep,
  type Role,
  type BootChoice,
  type Step5Phase,
} from './onboarding.ts';
import {
  buildExploreState,
  recommendExploration,
  type ExplorePanelId,
  PANEL_META,
  ALL_EXPLORE_PANELS,
} from './explore.ts';
import { historyGuide } from '../knowledge/history.ts';
import { LocalWorldStore } from '../persistence/local-store.ts';
import { PlanetView } from '../rendering/planet.ts';
import type { Layer } from '../rendering/planet.ts';
import { LevelManager, DEFAULT_WAYPOINTS, type Level } from '../rendering/level-manager.ts';
import { SurfaceView } from '../rendering/surface-view.ts';
import {
  SettlementMarkerLayer,
  BiomassLayer,
  WeatherLayer,
  SurfaceVegetationLayer,
  lineageIdToColor,
  type SettlementLike,
  type BiomassPayload,
  type WeatherPayload,
  type VegetationPayload,
  type VegetationSpec,
} from '../rendering/surface-layer.ts';
import { fromProjection } from '../simulation/terrain.ts';
import type { ComparisonPayload, ExportPayload, InspectionPayload, Projection, Reply, RequestType } from '../workers/controller.ts';
import { VirtualList } from './virtual-list.ts';

const $=<T extends HTMLElement=HTMLElement>(id:string):T=>document.getElementById(id) as T;
// Onboarding state (UX-1). The 5-step progress bar drives the
// initial cognitive journey from "宇宙" to "演化". Step 5 hides
// the stage and shows the planet-view / sidebar / timeline that
// were always the main screen; the rest of the steps render a
// hero card on the stage and link to the existing dialog
// panels (cosmos / galaxies / create) so the user can drill in
// without losing context.
let onboarding = loadOnboardingState();
function persistOnboarding() { saveOnboardingState(onboarding); }
const onboardingStage = $('onboarding-stage') as HTMLElement;
// PR-C: steps 5 and 6 share the `<main>` planet view rather
// than living inside the onboarding-stage wizard, so they
// have no `data-step` panel element to look up. The lookup
// table still has to enumerate every step (TypeScript
// `Record<OnboardingStep, …>`), so we put `null` for the
// two stages that own their content elsewhere and rely on
// the `if (panel)` guard in `renderOnboarding` to skip them.
const onboardingPanelByStep: Record<OnboardingStep, HTMLElement | null> = {
  1: document.querySelector<HTMLElement>('.onboarding-panel[data-step="1"]')!,
  2: document.querySelector<HTMLElement>('.onboarding-panel[data-step="2"]')!,
  3: document.querySelector<HTMLElement>('.onboarding-panel[data-step="3"]')!,
  4: document.querySelector<HTMLElement>('.onboarding-panel[data-step="4"]')!,
  5: null,
  6: null,
};
const onboardingDots = document.querySelectorAll<HTMLButtonElement>('.onboarding-dot');
const onboardingStepItems = document.querySelectorAll<HTMLElement>('.onboarding-step-item');
const onboardingPrev = $('onboarding-prev') as HTMLButtonElement;
const onboardingNext = $('onboarding-next') as HTMLButtonElement;
const onboardingProgressLabel = $('onboarding-progress-label')!;
const onboardingReset = $('onboarding-reset') as HTMLButtonElement;
const mainEl = document.querySelector('main') as HTMLElement;
// Explore sidebar (UX-2). Right-anchored panel that lists
// the 6 P12—P17 sub-experiments with their loaded state and
// the next recommended one. Clicking an entry opens the
// corresponding dialog (the dialogs are kept for now; this
// phase is about the sidebar + recommendation, not a wholesale
// dialog refactor).
const exploreSidebar = $('explore-sidebar') as HTMLElement;
const exploreStage = $('explore-stage') as HTMLElement;
const exploreStageTitle = $('explore-stage-title')!;
const exploreBackBtn = $('explore-back') as HTMLButtonElement;
const exploreListEl = $('explore-panels')!;
const exploreRecommendTextEl = $('explore-recommend-text')!;
const exploreRecommendBtn = $('explore-recommend-go') as HTMLButtonElement;
const exploreContextEl = $('explore-context')!;
const exploreHeaderToggle = $('explore-toggle-header') as HTMLButtonElement | null;
// Virtualized scroll container for the explore panel list. The
// item height (58px) matches the CSS layout of `.explore-panel-item`
// (9px padding + ~40px content + 9px padding + 6px gap). If you
// change the item styling, update this constant too.
const PANEL_ITEM_HEIGHT = 58;
const explorePanelList = new VirtualList({
  container: exploreListEl,
  itemHeight: PANEL_ITEM_HEIGHT,
  overscan: 2,
});
let exploreActive: ExplorePanelId | null = null;

/**
 * Single source of truth for the sidebar's collapsed state. Updates
 * the `.collapsed` class, the persisted localStorage entry, and the
 * header toggle button's label so the three never drift apart.
 */
function setSidebarCollapsed(collapsed: boolean) {
  exploreSidebar.classList.toggle('collapsed', collapsed);
  try { localStorage.setItem('my-universe-explore-collapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
  if (exploreHeaderToggle) exploreHeaderToggle.textContent = collapsed ? 'EXPLORE ◀' : 'EXPLORE ▶';
}

// Phase 10: guided mode. When on, every panel activation
// highlights the first interactive element + shows a one-line
// tooltip ("试试看这个") so new users know what to click first.
// Persisted to localStorage so the choice survives reloads.
let guidedMode = (() => {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('my-universe-guided-v1') === 'on';
  } catch { return false; }
})();
/**
 * Auto-continue: when the simulation finishes a `run` of N ticks,
 * automatically fire another `run` of N ticks. The user only has
 * to press the play button once; the experiment keeps rolling
 * until they pause. Useful for "leave the world running
 * overnight" scenarios or for letting a long batch play out
 * without supervision.
 */
let autoContinue = (() => {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem('my-universe-autocontinue-v1') === 'on';
  } catch { return false; }
})();
function setAutoContinue(on: boolean) {
  autoContinue = on;
  try { localStorage.setItem('my-universe-autocontinue-v1', on ? 'on' : 'off'); } catch {}
  const toggle = $('explore-autocontinue-toggle-input') as HTMLInputElement | null;
  if (toggle && toggle.checked !== on) toggle.checked = on;
}
function setGuidedMode(on: boolean) {
  guidedMode = on;
  try { localStorage.setItem('my-universe-guided-v1', on ? 'on' : 'off'); } catch {}
  // Reset per-panel step cursor so toggling on/off restarts the tutorial.
  resetGuidedStep();
  renderExploreSidebar();
  applyGuidedHighlight();
}

/**
 * Per-panel guided tutorial steps. Each step is shown in the
 * `#explore-guided-bar` (rendered by `applyGuidedHighlight`).
 * `selector` is an optional CSS selector within the panel; when
 * present, the matching element gets a highlight ring.
 */
const GUIDED_STEPS: Partial<Record<ExplorePanelId, { tip: string; selector?: string }[]>> = {
  cosmos: [
    { tip: '这是宇宙背景面板。先看一眼 ΛCDM 简化背景：标度因子 a、膨胀率 H、物质/暗能量占比。', selector: '#cosmos-scale' },
    { tip: '取消勾选"同步推进星球"可以独立调整亿年尺度，单独看宇宙演化。', selector: '#cosmos-linked' },
    { tip: '点 ▶ 推进宇宙背景按钮播放，或拖动下方滑块精确到 0.1 亿年。', selector: '#cosmos-play' },
  ],
  galaxy: [
    { tip: '这里 8 个预置气体晕，孤立系统，不叠加哈勃流。从 1 亿年开始。', selector: '#galaxy-map' },
    { tip: '点任意气体晕查看局部恒星形成 + 引力装配详情。', selector: '.halo-node' },
    { tip: '点"前进 1 亿年"看装配演化；按"前进 5 亿年"快进。', selector: '[data-galaxy-steps="20"]' },
  ],
  chemistry: [
    { tip: '点"载入示例网络"填入起点网络 JSON（ORL / GARD / Markov 任一）。', selector: '#chem-load-sample' },
    { tip: '点"加载网络"解析，状态会显示"已加载"和当前物种。', selector: '#chem-load' },
    { tip: '点"推进 1 步"运行单步；能量来自 addExternalEnergyInJ，余额不足会自动停。', selector: '#chem-step' },
  ],
  history: [
    { tip: '左侧是 8 个宇宙历史时期，点任一时期在右侧查看详情 + 数据来源。', selector: '#history-entries button' },
    { tip: '点时期文章中的"来源 ↗"外链会跳到公开科学资料。', selector: '#history-detail a' },
  ],
  branch: [
    { tip: '左侧时间分支列表显示所有已创建的分支。点任一分支可切换观察。', selector: '#branch-list' },
    { tip: '"复制当前世界"创建新分支；选"干预方式"+"作用范围"+"数值"点"应用并创建分支"。', selector: '#apply-intervention' },
    { tip: '选两条分支 + 推进天数，点"开始对照"并行推进并显示 B − A 差值。', selector: '#compare-run' },
  ],
};
const guidedStep: { panelId: ExplorePanelId | null; index: number; skipped: Set<ExplorePanelId> } = {
  panelId: null,
  index: 0,
  skipped: new Set(),
};
// Allow `setGuidedMode` to reset the cursor by reassigning the
// object's properties instead of the binding itself.
type GuidedStepState = typeof guidedStep;
function resetGuidedStep(): void {
  guidedStep.panelId = null;
  guidedStep.index = 0;
  guidedStep.skipped = new Set();
}
// Wire the "下一步 / 跳过" buttons once.
const guidedNextBtn = $('explore-guided-next');
const guidedSkipBtn = $('explore-guided-skip');
if (guidedNextBtn) {
  guidedNextBtn.addEventListener('click', () => {
    const steps = exploreActive ? GUIDED_STEPS[exploreActive] : undefined;
    if (!steps) return;
    guidedStep.index += 1;
    applyGuidedHighlight();
  });
}
if (guidedSkipBtn) {
  guidedSkipBtn.addEventListener('click', () => {
    if (exploreActive) guidedStep.skipped.add(exploreActive);
    applyGuidedHighlight();
  });
}
function applyGuidedHighlight() {
  // Reset any previous highlight / tooltip.
  document.querySelectorAll('.explore-guided-target').forEach((el) => {
    el.classList.remove('explore-guided-target');
  });
  // Remove any legacy inline tooltips (the old implementation
  // inserted a `<div class="explore-guided-tip">` after the target;
  // the current implementation lives in `#explore-guided-bar`).
  // Match by id to avoid clobbering the bar's tip-text span,
  // which shares the class name.
  const oldTip = document.getElementById('explore-guided-legacy-tip');
  if (oldTip) oldTip.remove();
  const bar = $('explore-guided-bar');
  if (!bar) return;
  // Hide the bar when guided mode is off or no panel is active.
  if (!guidedMode || !exploreActive) {
    bar.hidden = true;
    return;
  }
  const steps = GUIDED_STEPS[exploreActive];
  if (!steps || steps.length === 0) {
    bar.hidden = true;
    return;
  }
  // Reset to the first step whenever the panel changes.
  if (guidedStep.panelId !== exploreActive) {
    guidedStep.panelId = exploreActive;
    guidedStep.index = 0;
    guidedStep.skipped.delete(exploreActive);
  }
  // Already finished this panel's tutorial.
  if (guidedStep.skipped.has(exploreActive) || guidedStep.index >= steps.length) {
    bar.hidden = true;
    return;
  }
  const step = steps[guidedStep.index];
  if (!step) { bar.hidden = true; return; }
  const section = document.getElementById(exploreSectionId(exploreActive)!);
  const target = step.selector && section
    ? section.querySelector<HTMLElement>(step.selector)
    : null;
  if (target) target.classList.add('explore-guided-target');
  bar.hidden = false;
  const stepEl = $('explore-guided-step');
  const tipEl = $('explore-guided-tip-text');
  if (stepEl) stepEl.textContent = `${guidedStep.index + 1} / ${steps.length}`;
  if (tipEl) tipEl.textContent = step.tip;
  const nextBtn = $('explore-guided-next') as HTMLButtonElement | null;
  if (nextBtn) nextBtn.textContent = guidedStep.index + 1 >= steps.length ? '完成 ✓' : '下一步 →';
}
/**
 * Map an explore panel id to the underlying DOM id. The
 * `prebiotic-dialog` section hosts both `chemistry` and
 * `colonies` — the sidebar shows them as two entries but they
 * share the same UI surface (different forms within the
 * panel). V14 has its own dialog and is intentionally not in
 * the explore-stage.
 */
function exploreSectionId(id: ExplorePanelId): string | null {
  if (id === 'cosmos') return 'cosmos-dialog';
  if (id === 'galaxy') return 'galaxy-dialog';
  if (id === 'v14') return 'v14-dialog';
  if (id === 'chemistry' || id === 'colonies') return 'prebiotic-dialog';
  if (id === 'cognition') return 'cognition-dialog';
  if (id === 'settlement') return 'settlement-dialog';
  if (id === 'earth') return 'earth-dialog';
  if (id === 'batch') return 'batch-dialog';
  if (id === 'history') return 'history-dialog';
  if (id === 'branch') return 'branch-dialog';
  return null;
}
function mountExplorePanel(id: ExplorePanelId) {
  exploreActive = id;
  // Two panel ids (`chemistry` and `colonies`) share the same
  // `<section id="prebiotic-dialog">` in the DOM, so iterating
  // ALL_EXPLORE_PANELS and toggling each section would un-hide
  // it for `chemistry` then re-hide it for `colonies`. Dedupe
  // by sectionId and decide visibility once per unique section
  // (`false` if any of its panel ids is the active one).
  const visibleSectionIds = new Set<string>();
  for (const pid of ALL_EXPLORE_PANELS) {
    const sectionId = exploreSectionId(pid);
    if (sectionId && pid === id) visibleSectionIds.add(sectionId);
  }
  for (const pid of ALL_EXPLORE_PANELS) {
    const sectionId = exploreSectionId(pid);
    const section = sectionId ? document.getElementById(sectionId) : null;
    if (section && sectionId) section.hidden = !visibleSectionIds.has(sectionId);
  }
  // Reflect the active state in the sidebar and stage title.
  exploreStageTitle.textContent = `${PANEL_META[id].eyebrow} · ${PANEL_META[id].title}`;
  refreshExplore();
  applyGuidedHighlight();
}
function activateExplore(id: ExplorePanelId | null) {
  if (id === null) {
    exploreActive = null;
    exploreStage.hidden = true;
    if (mainEl) mainEl.hidden = false;
    // Dedupe by sectionId — `chemistry` and `colonies` share
    // `prebiotic-dialog`, so iterating ALL_EXPLORE_PANELS would
    // re-write the same hidden flag twice.
    const seen = new Set<string>();
    for (const pid of ALL_EXPLORE_PANELS) {
      const sectionId = exploreSectionId(pid);
      if (!sectionId || seen.has(sectionId)) continue;
      seen.add(sectionId);
      const section = document.getElementById(sectionId);
      if (section) section.hidden = true;
    }
    // PR-B: closing an explore panel can also complete a wizard
    // step. We track which panel was last opened (via the
    // `id !== null` branch below) and, if it matches the
    // "completion action" for the current step, advance to the
    // next step. The user can still press the "下一步 →" button
    // by hand, so this is purely additive.
    maybeAdvanceFromExploreClose();
  } else {
    if (mainEl) mainEl.hidden = true;
    exploreStage.hidden = false;
    mountExplorePanel(id);
    // Remember the panel we just opened so the close path can
    // decide whether to advance the wizard.
    lastExplorePanel = id;
  }
}

/**
 * PR-B: track the most recently opened explore panel so the
 * close path can correlate it with the current onboarding step.
 * `null` when no panel is active or after a cold start.
 */
let lastExplorePanel: ExplorePanelId | null = null;

function maybeAdvanceFromExploreClose(): void {
  if (lastExplorePanel === null) return;
  // Only handle wizard steps 1—4. Step 5 is the "演化" stage,
  // where closing the explore sidebar must NOT teleport the
  // user anywhere — they're already on the terminal step.
  if (onboarding.step < 1 || onboarding.step > 4) {
    lastExplorePanel = null;
    return;
  }
  const expectedPanel = STEP_COMPLETION[onboarding.step].panel;
  if (expectedPanel !== lastExplorePanel) {
    lastExplorePanel = null;
    return;
  }
  const next = nextStepAfterCompletion(onboarding.step);
  lastExplorePanel = null;
  if (next === null) return;
  // `goToStep` already calls `advanceOnboardingState` so the
  // current step is marked completed; we then advance to `next`.
  goToStep(next);
  // Briefly signal that the wizard auto-progressed, so the
  // user understands why the hero card changed.
  toast(`已自动进入第 ${next} 步`);
}
exploreBackBtn.addEventListener('click', () => activateExplore(null));
exploreRecommendBtn.addEventListener('click', () => {
  const id = exploreRecommendBtn.dataset.explore as ExplorePanelId;
  if (id) {
    activateExplore(id);
    // Auto-collapse so the explore-stage panel (full width) is
    // not covered by the sidebar.
    setSidebarCollapsed(true);
  }
});

// Phase 10: guided-mode toggle in the sidebar header.
const guidedToggleInput = $('explore-guided-toggle-input') as HTMLInputElement | null;
if (guidedToggleInput) {
  guidedToggleInput.checked = guidedMode;
  guidedToggleInput.addEventListener('change', () => {
    setGuidedMode(guidedToggleInput.checked);
  });
}
// Auto-continue toggle in the sidebar header. When the simulation
// finishes a `run` and this flag is on, fire another `run`.
const autoContinueInput = $('explore-autocontinue-toggle-input') as HTMLInputElement | null;
if (autoContinueInput) {
  autoContinueInput.checked = autoContinue;
  autoContinueInput.addEventListener('change', () => {
    setAutoContinue(autoContinueInput.checked);
  });
}
function renderExploreSidebar() {
  if (!projection) return;
  // `exploreActive` is null when the user is on the planet view
  // (no explore panel selected). The build helper expects a
  // concrete panel id; fall back to the top recommendation so the
  // sidebar reflects "what would be opened next" rather than the
  // stale previous selection.
  const state = buildExploreState(projection, exploreActive ?? recommendExploration(projection));
  // Collapsed / expanded state. We start collapsed so the
  // sidebar doesn't cover the right edge of `<main>` (the planet
  // view + header). The user clicks the handle to expand and
  // click again (or a panel) to collapse. State is persisted
  // in localStorage so the choice survives reloads.
  if (!exploreSidebar.dataset.initialised) {
    // Restore the persisted collapsed state on first render.
    // New users (no localStorage entry) default to collapsed so the
    // sidebar does not float over the planet view; users who have
    // explicitly expanded it keep the expanded state across reloads.
    let collapsed = true;
    try {
      const saved = localStorage.getItem('my-universe-explore-collapsed');
      if (saved !== null) collapsed = saved === '1';
    } catch { /* ignore */ }
    setSidebarCollapsed(collapsed);
    // Wire the header toggle button (sits in `.header-actions` next
    // to "新建世界"). Living in the header keeps it in the root
    // stacking context, so no panel content can ever cover it. It
    // also revives the sidebar if it was hidden by an onboarding
    // reset (step 1—4 hides the sidebar), so the click is always
    // observable.
    if (exploreHeaderToggle && !exploreHeaderToggle.dataset.wired) {
      exploreHeaderToggle.addEventListener('click', () => {
        if (exploreSidebar.hidden) {
          exploreSidebar.hidden = false;
          if (onboarding.step !== 5) goToStep(5);
        }
        setSidebarCollapsed(!exploreSidebar.classList.contains('collapsed'));
        refreshExplore();
      });
      exploreHeaderToggle.dataset.wired = '1';
    }
    exploreSidebar.dataset.initialised = '1';
  }
  // Recommendation card
  exploreRecommendTextEl.textContent = state.topReason;
  const topId = state.recommendations[0];
  if (topId) {
    const meta = PANEL_META[topId];
    exploreRecommendBtn.dataset.explore = topId;
    exploreRecommendBtn.textContent = `打开 ${meta.title}`;
    exploreRecommendBtn.disabled = false;
  } else {
    exploreRecommendBtn.disabled = true;
    exploreRecommendBtn.textContent = '已全部加载';
  }
  // Per-panel list — build all `<li>` nodes first, then hand the
  // array to the virtualized list. For the current 11 panels
  // the total height (638px) is small enough that we just
  // mount every node; VirtualList still applies the spacer so
  // the scroll geometry stays correct if more panels are
  // added later. All rows are always interactive.
  const items: HTMLElement[] = [];
  for (const id of ALL_EXPLORE_PANELS) {
    const meta = PANEL_META[id];
    const loaded = state.loaded[id];
    const recommended = state.recommendations[0] === id;
    const li = document.createElement('li');
    li.className = 'explore-panel-item' + (loaded ? ' loaded' : '') + (recommended ? ' recommended' : '');
    li.tabIndex = 0;
    const icon = document.createElement('span'); icon.className = 'explore-icon';
    icon.textContent = loaded ? '✓' : id[0]!.toUpperCase();
    const text = document.createElement('div'); text.className = 'explore-text';
    const title = document.createElement('span'); title.className = 'explore-title';
    title.textContent = meta.title;
    const blurb = document.createElement('span'); blurb.className = 'explore-blurb';
    blurb.textContent = meta.blurb;
    text.append(title, blurb);
    const status = document.createElement('span'); status.className = 'explore-status';
    status.textContent = loaded ? '已加载' : (recommended ? '推荐' : '未开始');
    li.append(icon, text, status);
    li.addEventListener('click', () => {
      activateExplore(id);
      // Auto-collapse the sidebar so the explore-stage panel
      // (full-width) is visible. The user can re-open the
      // sidebar any time via the toggle handle.
      setSidebarCollapsed(true);
    });
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateExplore(id); setSidebarCollapsed(true); } });
    items.push(li);
  }
  // All items are always interactive (sidebar handles its own
  // overflow). VirtualList.setItems mounts every node in the
  // document flow so the existing `.explore-panels` flex + gap
  // styles apply. Switching to windowed virtualize is a
  // constructor flag flip once the panel count grows past the
  // visible window.
  explorePanelList.setItems(items);
  // Footer context
  const loaded = state.recommendations.length;
  const total = ALL_EXPLORE_PANELS.length;
  exploreContextEl.textContent = `${loaded - (ALL_EXPLORE_PANELS.every((i) => state.loaded[i]) ? total : 0)} / ${total} 已加载 · tick ${projection.tick ?? 0} · ${projection.branches.length} branch`;
}
const refreshExplore = renderExploreSidebar;
const store=new LocalWorldStore();let saving=false,lastSavedAstronomyStep='none',lastSavedTick=-1,lastSavedTime=0,autoEnabled=true,lastSavedBranch='';
const worker=new Worker(new URL('../workers/simulation.worker.ts',import.meta.url),{type:'module'});
let requestId=0, projection:Projection|null=null, selected=-1, world='', chart:{tick:number;population:number}[]=[];
// Tracks the previous `running` flag so the projection handler
// can detect a running→paused transition and trigger auto-continue.
let wasRunning = false;
const pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void}>();
// `send` is overloaded so that typed-payload callers (`inspect` / `compare` /
// `export`) get a precise return type without casts. The implementation
// signature returns `Promise<unknown>` and the call site is narrowed by the
// overload that matched.
function send(type:'inspect',payload:{cell:number}):Promise<InspectionPayload>;
function send(type:'compare',payload:{a:string;b:string;ticks:number}):Promise<ComparisonPayload>;
function send(type:'export'):Promise<ExportPayload>;
function send(type:RequestType,payload?:Record<string,unknown>):Promise<unknown>;
function send(type:RequestType,payload?:Record<string,unknown>):Promise<unknown>{return new Promise((resolve,reject)=>{const id=++requestId;pending.set(id,{resolve,reject});worker.postMessage({id,type,payload});});}
let toastTimer:ReturnType<typeof setTimeout>|undefined;
function toast(message:string,level:'info'|'error'='info'){const el=$('toast');el.textContent=message;el.hidden=false;if(toastTimer!==undefined)clearTimeout(toastTimer);const ms=level==='error'?6000:3000;toastTimer=setTimeout(()=>{el.hidden=true;toastTimer=undefined;},ms);}
const action=(promise:Promise<unknown>)=>void promise.catch(e=>toast(e instanceof Error?e.message:String(e)));
let view:PlanetView;
try{view=new PlanetView($('globe'),cell=>inspect(cell));}catch(error){toast(`无法建立三维画面：${error instanceof Error?error.message:String(error)}`);}

/**
 * Phase 11.1: Cosmic-to-Ground Zoom — level manager + level pill.
 *
 * The level manager owns the current zoom level (COSMOS →
 * GALAXY → PLANET → SURFACE) and runs a cubic-eased camera
 * transition between levels. P1 only wires PLANET ↔ SURFACE
 * because those are the two levels that share an existing 3D
 * scene (PlanetView). The COSMOS / GALAXY click-through is
 * P1 follow-up.
 *
 * User entry points into SURFACE:
 *   1. Double-click on the planet globe.
 *   2. The "← 上一级" pill (shown only when level is SURFACE).
 *
 * Real terrain / rivers / biomes / settlements 3D rendering
 * is Phase 11.2 (P2). The current surface view is a
 * placeholder that documents the roadmap.
 */
const levelManager = new LevelManager();
const LEVEL_LABEL: Record<Level, string> = {
  cosmos: '宇宙', galaxy: '星系', planet: '行星', surface: '地表',
};
const levelPill = $('level-pill');
const levelPillLabel = $('level-pill-label');
const levelPillUp = $('level-pill-up') as HTMLButtonElement | null;
const surfaceContainer = $('surface-view') as HTMLElement | null;

// Phase 11.2: SurfaceView (Three.js scene with the heightmap
// mesh + biome colors). Lazily constructed on first entry to
// SURFACE so the planet scene's animation loop isn't paying
// for an idle render target.
let surfaceView: SurfaceView | null = null;
const surfaceCanvas = $('surface-canvas');
// P3 — surface layers. The settlement marker, biomass, and
// weather layers are installed once the cell-centre lookup
// arrives from the controller; subsequent projection updates
// forward `projection.settlement.bySettlement`,
// `projection.biomass` / `projection.dominant`, and
// `projection.temperature` / `projection.land` to the layers.
let settlementLayer: SettlementMarkerLayer | null = null;
let biomassLayer: BiomassLayer | null = null;
let weatherLayer: WeatherLayer | null = null;
let vegetationLayer: SurfaceVegetationLayer | null = null;
let cellCentersCache: ReadonlyArray<readonly [number, number, number]> | null = null;
// P3.6 — temporary Playwright diag.
(globalThis as unknown as { __surfaceView?: () => unknown; __layerStats?: () => unknown }).__surfaceView = () => {
  if (!surfaceView) return null;
  const cam = surfaceView.camera;
  return { cameraPosition: cam.position.toArray(), cameraFov: cam.fov };
};
(globalThis as unknown as { __layerStats?: () => unknown }).__layerStats = () => {
  const lg = surfaceView?.getLayerGroup?.();
  const out: { name: string; visible: boolean; instCount?: number; first3?: { pos: [number, number, number]; scale: [number, number, number] }[] }[] = [];
  if (lg) {
    for (const child of lg.children) {
      const grp = child as unknown as { name: string; visible: boolean; children: { count: number; instanceMatrix: { array: Float32Array } }[] };
      const inst = grp.children[0] as unknown as { count: number; instanceMatrix: { array: Float32Array } } | undefined;
      if (!inst) { out.push({ name: grp.name, visible: grp.visible }); continue; }
      const arr = inst.instanceMatrix.array;
      const first3: { pos: [number, number, number]; scale: [number, number, number] }[] = [];
      for (let k = 0; k < Math.min(3, inst.count); k++) {
        const o = k * 16;
        // Decompose T*R*S: each column's length is the
        // scale factor along that local axis. Position
        // is in (m41, m42, m43).
        const sx = Math.hypot(arr[o + 0]!, arr[o + 1]!, arr[o + 2]!);
        const sy = Math.hypot(arr[o + 4]!, arr[o + 5]!, arr[o + 6]!);
        const sz = Math.hypot(arr[o + 8]!, arr[o + 9]!, arr[o + 10]!);
        const px = arr[o + 12]!, py = arr[o + 13]!, pz = arr[o + 14]!;
        first3.push({ pos: [px, py, pz], scale: [sx, sy, sz] });
      }
      out.push({ name: grp.name, visible: grp.visible, instCount: inst.count, first3 });
    }
  }
  return out;
};

function applyLevelChrome(level: Level): void {
  // Level pill: hidden at COSMOS / GALAXY (P1 follow-up), shown
  // at PLANET (as a label) and SURFACE (as a back button).
  if (levelPill) {
    if (level === 'surface') {
      levelPill.hidden = false;
      if (levelPillLabel) levelPillLabel.textContent = LEVEL_LABEL[level];
    } else if (level === 'planet') {
      levelPill.hidden = false;
      if (levelPillLabel) levelPillLabel.textContent = LEVEL_LABEL[level];
    } else {
      levelPill.hidden = true;
    }
  }
  // Surface view: only at SURFACE.
  if (surfaceContainer) surfaceContainer.hidden = level !== 'surface';
  // Globe canvas: visible at COSMOS / GALAXY / PLANET, hidden
  // at SURFACE (the surface view covers it).
  const globe = $('globe');
  if (globe) globe.style.visibility = level === 'surface' ? 'hidden' : 'visible';
}

function ensureSurfaceView(): SurfaceView {
  if (surfaceView) return surfaceView;
  if (!surfaceCanvas) throw new Error('#surface-canvas not found');
  surfaceView = new SurfaceView(surfaceCanvas, levelManager);
  if (cellCentersCache) surfaceView.setCellCenters(cellCentersCache);
  // Install the settlement marker layer. It only needs the
  // cell-centre lookup to position its cones; the data
  // payload arrives later through `updateSettlementMarkers`.
  // P3.5 — pass a `markerLayerRadius` of 1.02 (=
  // BASE_RADIUS + ELEVATION_DISPLACEMENT + small gap) so the
  // layer's objects sit *above* the surface mesh rather than
  // being hidden inside the terrain's peak displacement.
  const markerLayerRadius = 1.02;
  settlementLayer = new SettlementMarkerLayer(
    surfaceView.getLayerGroup(),
    cellCentersCache ?? [],
    markerLayerRadius,
  );
  surfaceView.addNamedLayer('settlement', settlementLayer);
  // P3.2 — install the biomass layer. Same cell-centre lookup;
  // data payload arrives through `updateBiomassMarkers`.
  biomassLayer = new BiomassLayer(
    surfaceView.getLayerGroup(),
    cellCentersCache ?? [],
    markerLayerRadius,
  );
  surfaceView.addNamedLayer('biomass', biomassLayer);
  // P3.3 — install the weather layer. Same lookup; data
  // payload arrives through `updateWeatherMarkers`.
  weatherLayer = new WeatherLayer(
    surfaceView.getLayerGroup(),
    cellCentersCache ?? [],
    markerLayerRadius,
  );
  surfaceView.addNamedLayer('weather', weatherLayer);
  // P3.6 — install the vegetation layer. The host derives a
  // sparse list of (cell, variant) placements via a
  // deterministic noise over the icosphere cell map; the
  // layer just packs them into an InstancedMesh.
  vegetationLayer = new SurfaceVegetationLayer(
    surfaceView.getLayerGroup(),
    cellCentersCache ?? [],
    markerLayerRadius,
  );
  surfaceView.addNamedLayer('vegetation', vegetationLayer);
  // P3.4 — wire up the layer-toggle checkboxes so the user
  // can flip each layer on/off without leaving the surface
  // view. The handler is a no-op for any layer name that
  // isn't registered, so it's safe to bind unconditionally.
  for (const cb of Array.from(document.querySelectorAll<HTMLInputElement>('.surface-layer-toggles input[type="checkbox"]'))) {
    cb.addEventListener('change', () => {
      const name = cb.dataset.layer as 'settlement' | 'biomass' | 'weather' | 'vegetation' | undefined;
      if (name) surfaceView!.setLayerVisible(name, cb.checked);
    });
  }
  if (projection) {
    surfaceView.update(fromProjection(projection));
    updateSettlementMarkers(projection);
    updateBiomassMarkers(projection);
    updateWeatherMarkers(projection);
    updateVegetationMarkers(projection);
  }
  return surfaceView;
}

/** P3 — forward P15 settlement data from the latest projection
 *  to the marker layer. Called on every projection tick so the
 *  markers track population / dissolution changes. */
function updateSettlementMarkers(d: Projection): void {
  if (!settlementLayer) return;
  const list = d.settlement?.bySettlement ?? [];
  // Projection.bySettlement uses a wider Settlement type than
  // the layer's SettlementLike; both share the same shape on
  // the fields the layer reads.
  const settlements: SettlementLike[] = list.map((s) => ({
    id: s.id,
    cellIndex: s.cellIndex,
    population: s.population,
    dissolved: s.dissolved,
    institution: { kind: s.institutionKind },
  }));
  settlementLayer.update(settlements);
}

/** P3.2 — forward per-cell biomass + dominant lineage to the
 *  biomass layer. The host derives a stable colour for each
 *  lineage id via `lineageIdToColor`, so a given lineage
 *  always paints the same hue even as cohorts split. */
function updateBiomassMarkers(d: Projection): void {
  if (!biomassLayer) return;
  const palette: number[] = new Array(d.lineageIds.length);
  for (let i = 0; i < d.lineageIds.length; i++) {
    palette[i] = lineageIdToColor(d.lineageIds[i]!);
  }
  const payload: BiomassPayload = {
    biomass: d.biomass,
    dominant: d.dominant,
    palette,
  };
  biomassLayer.update(payload);
}

/** P3.3 — forward per-cell temperature + land fraction to the
 *  weather layer. The layer paints a translucent ring on
 *  every cell, hot=red / cold=blue, fading over ocean. */
function updateWeatherMarkers(d: Projection): void {
  if (!weatherLayer) return;
  const payload: WeatherPayload = {
    temperature: d.temperature,
    land: d.land,
    landOpacity: 0.7,
  };
  weatherLayer.update(payload);
}

/** P3.6 — derive a sparse `VegetationSpec[]` for the surface
 *  view. We hash each land cell, pick a subset (~6% of land
 *  cells), and assign a variant by temperature (cold →
 *  rocks, temperate → trees, hot → grass). The host
 *  re-runs this on every projection so the spec list
 *  tracks cell changes (refine, new world, etc.). */
function updateVegetationMarkers(d: Projection): void {
  if (!vegetationLayer) return;
  const land = d.land;
  const temp = d.temperature;
  if (land.length === 0) {
    vegetationLayer.update({ specs: [], totalLandCells: 0 });
    return;
  }
  const landCount = land.length;
  const specs: VegetationSpec[] = [];
  // P3.6 visual budget: ~3% of land cells get a piece of
  // vegetation, with a deterministic per-cell threshold so
  // the pattern is stable across rebuilds.
  const TARGET_FRACTION = 0.03;
  for (let i = 0; i < landCount; i++) {
    if ((land[i] ?? 0) < 0.5) continue;
    const h = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    const f = h - Math.floor(h);
    if (f > TARGET_FRACTION) continue;
    const t = temp[i] ?? 288;
    // 260 K → rock; 285 K → tree; 305 K → grass tuft;
    // outside that band we mix in shrubs. The exact
    // mapping is just a visual heuristic.
    let variant: number;
    if (t < 270) variant = 1;
    else if (t < 295) variant = 0;
    else if (t < 305) variant = 3;
    else variant = 2;
    // Deterministic lat/lon from the cellIndex hash so the
    // host can place the object inside the cell.
    const lat = ((i * 0.314) % 1) * Math.PI;
    const lon = ((i * 0.271) % 1) * 2 * Math.PI;
    specs.push({ cellIndex: i, lat, lon, variant, size: 0.8 + f * 0.4 });
  }
  vegetationLayer.update({ specs, totalLandCells: landCount });
}

/** P3 — fetch the cell-centre lookup from the controller and
 *  install it on the surface view. Called once after world
 *  creation (or lazily when the surface view is first
 *  constructed if the world already exists). */
async function loadCellCenters(): Promise<void> {
  // P3.6 — re-fetch when the world's cell count no longer
  // matches the cache. The cache exists to avoid the round-trip
  // when the world hasn't changed, but `refine` and
  // `expandCapacity` change the underlying cell count without
  // a new "create". Checking the projection's temperature
  // array length (which is per-cell) gives us the current
  // cell count for free — no extra RPC.
  const currentCellCount = projection?.temperature.length ?? 0;
  if (cellCentersCache && cellCentersCache.length === currentCellCount) {
    if (surfaceView) surfaceView.setCellCenters(cellCentersCache);
    return;
  }
  // Cache miss or stale — refetch from the controller.
  try {
    const payload = (await send('getCellCenters')) as { centers: number[]; cellCount: number };
    const out: Array<readonly [number, number, number]> = new Array(payload.cellCount);
    for (let i = 0; i < payload.cellCount; i++) {
      out[i] = [
        payload.centers[i * 3 + 0]!,
        payload.centers[i * 3 + 1]!,
        payload.centers[i * 3 + 2]!,
      ] as const;
    }
    cellCentersCache = out;
    if (surfaceView) surfaceView.setCellCenters(out);
  } catch (err) {
    // Surface view is optional; missing centres just means
    // no settlement markers. Don't block the rest of the UI.
    console.warn('failed to load cell centres', err);
  }
}

function teardownSurfaceView(): void {
  if (!surfaceView) return;
  surfaceView.destroy();
  surfaceView = null;
}

levelManager.onLevelChange((level) => {
  applyLevelChrome(level);
  if (level === 'surface') {
    const sv = ensureSurfaceView();
    // Apply the surface waypoint as the camera "from" so a
    // manual orbit doesn't snap when the user transitions back.
    levelManager.setCurrentCamera({
      position: { x: DEFAULT_WAYPOINTS.surface.position.x, y: DEFAULT_WAYPOINTS.surface.position.y, z: DEFAULT_WAYPOINTS.surface.position.z },
      lookAt: { x: 0, y: 0, z: 0 },
      fov: DEFAULT_WAYPOINTS.surface.fov,
    });
    if (projection) sv.update(fromProjection(projection));
  } else if (level === 'planet') {
    teardownSurfaceView();
  }
});

// User entry points.
if (levelPillUp) {
  levelPillUp.addEventListener('click', () => {
    if (levelManager.current === 'surface') {
      void levelManager.requestTransition({ to: 'planet' });
    }
  });
}
const globeEl = $('globe');
if (globeEl) {
  globeEl.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (levelManager.current === 'planet' && !levelManager.isTransitioning) {
      // Snapshot the current camera so the transition starts
      // from wherever the user has orbited to.
      if (view) levelManager.setCurrentCamera(view.getCameraState());
      void levelManager.requestTransition({ to: 'surface' });
    }
  });
}

// Render loop for the level manager. Calls into PlanetView
// every frame to apply the interpolated camera state.
function levelTick(): void {
  levelManager.tick((state) => {
    if (view) view.setCameraState(state.position, state.lookAt, state.fov);
  });
  requestAnimationFrame(levelTick);
}
requestAnimationFrame(levelTick);
// Initialize chrome (planet level, pill shown, surface hidden).
applyLevelChrome(levelManager.current);
const format=(n:number)=>n.toLocaleString('zh-CN',{maximumFractionDigits:0});
function inspect(cell:number){selected=cell;view?.select(cell);action(send('inspect',{cell}).then(showInspection));}
function showInspection(data:InspectionPayload){
  if(data.cell!==selected)return;
  const container=$('inspection');container.replaceChildren();
  const h=document.createElement('h3');h.textContent=`区域 ${data.cell}`;container.append(h);
  const dl=document.createElement('dl');
  for(const [label,value]of [['面积',`${format(data.area/1_000_000)} km²`],['温度',`${data.temperature.toFixed(2)} K`],['营养',`${format(data.nutrient)} MU`],['碎屑',`${format(data.detritus)} MU`],['种群',`${data.cohorts.length} 个队列`]]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label!;dd.textContent=value!;dl.append(dt,dd);}container.append(dl);
  for(const cohort of data.cohorts.slice(0,3)){const p=document.createElement('div');p.className='inspection-lineage';p.textContent=`${cohort.lineage.id} · ${format(cohort.count)} 个体`;container.append(p);}
  if(data.cohorts.length>3){const p=document.createElement('p');p.className='muted small';p.textContent=`另有 ${data.cohorts.length-3} 个队列`;container.append(p);}
}
function drawChart(){
  const max=Math.max(1,...chart.map(p=>p.population)),minTick=chart[0]?.tick??0,maxTick=chart.at(-1)?.tick??1;
  const points=chart.map((p,i)=>`${(p.tick-minTick)/Math.max(1,maxTick-minTick)*1000},${80-p.population/max*72}`);
  const path=points.length===1?`M 0,${80-(chart[0]?.population??0)/max*72} L 1000,${80-(chart[0]?.population??0)/max*72}`:points.map((p,i)=>`${i?'L':'M'} ${p}`).join(' ');
  $('chart-line').setAttribute('d',path);$('chart-area').setAttribute('d',`${path} L 1000,85 L 0,85 Z`);
}
worker.onmessage=(event:MessageEvent<Reply>)=>{
  const reply=event.data;
  if(reply.type==='projection'){
    const d=reply.payload;projection=d;
    // Auto-continue: when a `run` just finished (running was
    // true, now false) and the toggle is on, queue another
    // `run` for the same tick count. Use a microtask so we
    // don't fire the next run before this projection renders.
    if (wasRunning && !d.running && autoContinue) {
      const ticks = Number($<HTMLSelectElement>('duration').value);
      queueMicrotask(() => { void send('run', { ticks }); });
    }
    wasRunning = d.running;
    if(world!==d.worldId){world=d.worldId;chart=[];selected=-1;lastSavedTick=-1;lastSavedBranch='';}
    chart=d.samples.map(s=>({tick:s.tick,population:s.population}));
    const stride=Math.max(1,Math.ceil(chart.length/300));chart=chart.filter((_,i)=>i%stride===0||i===chart.length-1);
    $('population').textContent=format(d.summary.population);$('temperature').textContent=`${d.summary.temperatureK.toFixed(1)} K`;$('lineages').textContent=format(d.summary.activeLineages);$('nutrient').textContent=`${format(d.summary.nutrientMu)} MU`;$('diversity').textContent=d.summary.diversity.toFixed(2);
    $('day').textContent=format(d.tick);$('run-status').textContent=d.running?'演化中':'已暂停';$('play').textContent=d.running?'Ⅱ 暂停':'▶ 开始演化';($('play') as HTMLButtonElement).disabled=false;($('step') as HTMLButtonElement).disabled=d.running;
    $('cell-count').textContent=`${format(d.temperature.length)} 个观察区域`;$('event').textContent=d.lastEvent;$('chart-end').textContent=`第 ${d.tick} 日`;$('integrity').textContent=`物质收支误差 ${d.summary.matterResidualMu.toExponential(1)} MU`;
    $<HTMLButtonElement>('refine-world').disabled=d.running||d.temperature.length>=20480;
    $('refine-world').textContent=d.temperature.length>=20480?'已达到 20,480 区域':`细分至 ${format(d.temperature.length*4)} 区域（新分支）`;
    $('cohort-capacity').textContent=`种群队列 ${format(d.summary.cohorts)} / ${format(d.cohortLimit)}`;
    $<HTMLButtonElement>('expand-capacity').disabled=d.cohortLimit>=100000||d.running;
    $('history-storage').textContent=`历史检查点 ${d.historyStorage.checkpoints} · ${(d.historyStorage.checkpointBytes/1_000_000).toFixed(1)} MB · ${d.historyStorage.sampled?'趋势已抽样，任意历史日仍可重放':'趋势逐日记录'}`;
    $('loading').hidden=true;view?.update(d);surfaceView?.update(fromProjection(d));updateSettlementMarkers(d);updateBiomassMarkers(d);updateWeatherMarkers(d);updateVegetationMarkers(d);drawChart();
    // PR-C: tick-driven 5a → 5b → 6 sub-phase promotion.
    // Cheap, idempotent; the function early-returns when the
    // sub-phase has already been advanced or the user isn't
    // on step 5 yet, so it adds no work to step 1—4 traffic.
    maybeAutoAdvancePhase5(d.tick);
    // P3.6 — refresh the cell-centre cache when the world
    // changes (create / import / refine). loadCellCenters is
    // a no-op when the cache is fresh, so calling it on every
    // projection only pays the round-trip cost on actual
    // world changes. The early-return inside loadCellCenters
    // compares the cache length to the projection's cell
    // count, so a refine from 5120 → 20480 cells triggers a
    // re-fetch and rebuilds the surface view's cellMap.
    void loadCellCenters();
    renderPrebiotic(d);
    renderCognition(d);
    renderSettlement(d, d.temperature.length);
    renderEarth(d);
    renderBatch(d);
    renderV14(d);
    refreshExplore();
    if(selected>=0)inspect(selected);
    $<HTMLInputElement>('seek').min=String(d.forkTick);$<HTMLInputElement>('seek').max=String(d.headTick);$<HTMLInputElement>('seek').value=String(d.tick);$('seek-label').textContent=`第 ${d.tick} 日`;
    if(autoEnabled&&(d.tick!==lastSavedTick||d.branchId!==lastSavedBranch||d.astronomyRevision!==lastSavedAstronomyStep))$('save-status').textContent='尚有未保存进展';
    $('branch-label').textContent=d.branches.find(b=>b.id===d.branchId)?.label??d.branchId;updateBranches(d);
    if(autoEnabled&&!saving&&(d.tick!==lastSavedTick||d.branchId!==lastSavedBranch||d.astronomyRevision!==lastSavedAstronomyStep)&&(d.astronomyRevision!==lastSavedAstronomyStep||d.branchId!==lastSavedBranch||Math.floor(d.tick/100)>Math.floor(lastSavedTick/100)||performance.now()-lastSavedTime>30000))void saveWorld();
  }
  if(reply.type==='progress'){if(reply.payload.operation==='compare')$('comparison-result').textContent=`正在对照：第 ${reply.payload.tick} / ${reply.payload.target} 日`;else $('seek-label').textContent=`恢复 ${reply.payload.tick}/${reply.payload.target}`;}
  if(reply.type==='error')toast(reply.error??'操作失败','error');
  const call=pending.get(reply.id);
  if(call){pending.delete(reply.id);
    if(reply.type==='error')call.reject(new Error(reply.error));
    else if(reply.type==='ack')call.resolve(undefined);
    else call.resolve(reply.payload);
  }
};
worker.onerror=event=>{toast(`模拟进程停止：${event.message}`,'error');for(const item of pending.values())item.reject(new Error(event.message));pending.clear();};
$('toast').addEventListener('click',()=>{$('toast').hidden=true;});
$('play').addEventListener('click',()=>action(send(projection?.running?'pause':'run',{ticks:Number($<HTMLSelectElement>('duration').value)})));
$('step').addEventListener('click',()=>action(send('step')));
$('inspect-first').addEventListener('click',()=>inspect(0));
const legends:Record<Layer,string>={terrain:'海洋 · 蓝色 / 陆地 · 绿色',temperature:'260 K 蓝色 → 320 K 红色',biomass:'暗 → 亮：生物量增加（MU）',nutrient:'暗 → 亮：营养增加（MU）',lineage:'不同颜色代表优势谱系'};
// Inline swatches: 5-layer color signal for 色盲 redundancy. Each gradient
// matches the HSL/HSV range used by `src/rendering/planet.ts` for that layer.
const layerSwatches:Record<Layer,string>={
  terrain:'linear-gradient(90deg,#1b6878 0 50%,#7b9460 50% 100%)',
  temperature:'linear-gradient(90deg,#2563c0 0%,#d4a574 50%,#dc2626 100%)',
  biomass:'linear-gradient(90deg,#1a3320 0%,#5ce1c1 100%)',
  nutrient:'linear-gradient(90deg,#3d2f1a 0%,#d4a574 100%)',
  lineage:'linear-gradient(90deg,#ef4444 0 20%,#fbbf24 20% 40%,#34d399 40% 60%,#60a5fa 60% 80%,#c084fc 80% 100%)',
};
document.querySelectorAll<HTMLButtonElement>('[data-layer]').forEach(button=>{
  const layer=button.dataset.layer as Layer;
  const swatch=document.createElement('i');
  swatch.className='layer-swatch';
  swatch.setAttribute('aria-hidden','true');
  swatch.style.background=layerSwatches[layer];
  button.prepend(swatch);
  button.addEventListener('click',()=>{document.querySelectorAll('[data-layer]').forEach(b=>b.classList.remove('active'));button.classList.add('active');view?.setLayer(layer);$('legend').textContent=legends[layer];});
});
// Legacy create-dialog was removed in Phase 9. The on-stage create
// form (#onboarding-create-form, see line ~597) owns the form
// submission. The header "新建世界" button just lands the user on
// step 4 of the onboarding wizard where that form lives.
$('new-world').addEventListener('click',()=>{action(send('pause'));goToStep(4);});
async function saveWorld(){
  if(saving||!projection)return;saving=true;$('save-status').textContent='保存中…';
  let savedIdentity:{worldId:string;branchId:string}|null=null;
  try{const saved=await send('export');await store.save(saved.worldId,saved.content);savedIdentity=saved;
    if(projection?.worldId===saved.worldId&&projection.branchId===saved.branchId){lastSavedAstronomyStep=saved.astronomyRevision;lastSavedTick=saved.tick;lastSavedBranch=saved.branchId;lastSavedTime=performance.now();$('save-status').textContent=projection.tick===saved.tick&&projection.astronomyRevision===saved.astronomyRevision?`已保存 · 第 ${lastSavedTick} 日`:`已保存至第 ${lastSavedTick} 日 · 后续尚未保存`;}
  }catch(error){autoEnabled=false;$('save-status').textContent='保存失败 · 世界仍在内存中';toast(`保存失败，可使用导出保留世界：${error instanceof Error?error.message:String(error)}`,'error');}
  finally{saving=false;}
  if(autoEnabled&&savedIdentity&&projection&&(projection.worldId!==savedIdentity.worldId||projection.branchId!==savedIdentity.branchId||projection.astronomyRevision!==lastSavedAstronomyStep))void saveWorld();
}
$('save').addEventListener('click',()=>{autoEnabled=true;void saveWorld();});
$('export').addEventListener('click',()=>action(send('export').then(saved=>{const blob=new Blob([saved.content],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`我的宇宙-第${projection?.tick??0}日.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);})));
$('import').addEventListener('click',()=>$<HTMLInputElement>('import-file').click());
$('import-file').addEventListener('change',()=>{const input=$<HTMLInputElement>('import-file'),file=input.files?.[0];if(!file)return;if(file.size>100_000_000){toast('存档超过 100 MB 上限');return;}action(file.text().then(content=>send('import',{content})).then(()=>saveWorld()));input.value='';});
$('seek').addEventListener('change',()=>{$('cancel-history').hidden=false;action(send('seek',{tick:Number($<HTMLInputElement>('seek').value)}).finally(()=>{$('cancel-history').hidden=true;}));});
$('cancel-history').addEventListener('click',()=>action(send('pause')));
$('cancel-operation').addEventListener('click',()=>action(send('pause')));
$('seek').addEventListener('input',()=>{$('seek-label').textContent=`第 ${$<HTMLInputElement>('seek').value} 日`;});
/**
 * Start (or restore) the planet simulation. The caller decides
 * which onboarding `step` the user should land on — `5` is the
 * legacy "skip the wizard, go straight to the evolve screen"
 * used by the restore path, while the boot modal hands the user
 * over to `start(1)` or `start(4)` depending on the role and
 * the `skipBasics` flag.
 *
 * We split this from `start()` so the boot modal can pick the
 * right step without changing the existing restore behaviour.
 */
function decideBootInitialStep(boot: BootChoice): OnboardingStep {
  // Elementary students always walk the full 5 steps — they
  // need the cosmos backdrop to make "一颗星球" land.
  if (boot.role === 'elementary') return 1;
  // Middle / high / teacher: only skip to step 4 if the user
  // explicitly ticked "跳过基础". Otherwise stay on step 1 so
  // the wizard teaches them cosmos → galaxy → star → planet.
  return boot.skipBasics ? 4 : 1;
}

async function start(initialStep: OnboardingStep = 5){
  try{const saved=await store.latest();if(saved){await send('import',{content:saved.content});lastSavedTick=projection?.tick??0;lastSavedBranch=projection?.branchId??'';$('save-status').textContent=`已恢复 · 第 ${lastSavedTick} 日`;onboarding=advanceOnboardingState(onboarding,initialStep);persistOnboarding();renderOnboarding();await loadCellCenters();return;}}
  catch(error){autoEnabled=false;toast(`无法恢复本地存档，已保留原文件：${error instanceof Error?error.message:String(error)}`,'error');}
  await send('create',{scenario:'two-lineages',cells:5120});
  // Cold start: respect the caller's choice of initial step.
  // When the boot modal routes us here with `1` or `4`, the
  // user sees the wizard from that point instead of being
  // teleported to the evolve screen. The default `5` keeps
  // the legacy "no boot choice, just run it" behaviour.
  onboarding=advanceOnboardingState(onboarding,initialStep);persistOnboarding();renderOnboarding();
  // P3.6 — also fetch the cell-centre lookup. Without this,
  // skipping the create form (e.g. by clicking the step-5 dot
  // directly) leaves cellCentersCache null, and the first
  // surface view paints every vertex with the landFraction /
  // temperature of cell 0 — the "all-green" / "all-blue"
  // bug. The form-submit path calls this itself (line ~1160);
  // we mirror it here so the cold-start / restore paths have
  // it too.
  await loadCellCenters();
}
renderOnboarding();
// PR-A: Boot modal cold start. If the user has never picked a
// role, show the modal first and let them confirm before we
// start the simulation. Once a role is saved, every subsequent
// cold start goes straight to `start()`.
const bootModal = $('boot-modal') as HTMLElement;
const bootStartBtn = $('boot-start') as HTMLButtonElement;
const bootSkipInput = $('boot-skip-basics') as HTMLInputElement;
const bootSkipLabel = $('boot-skip-label') as HTMLElement;
const bootCards = document.querySelectorAll<HTMLButtonElement>('.boot-card');
let selectedBootRole: Role | null = null;

function setSelectedBootRole(role: Role | null) {
  selectedBootRole = role;
  for (const card of Array.from(bootCards)) {
    const isMe = card.dataset.role === role;
    card.classList.toggle('selected', isMe);
    card.setAttribute('aria-checked', String(isMe));
  }
  bootStartBtn.disabled = role === null;
  // "Skip basics" is only meaningful for users old enough to
  // grasp planet-level inputs. Elementary students always
  // walk the full 5 steps (they need the cosmos backdrop to
  // make the "一颗星球" framing land).
  const skipEnabled = role !== null && role !== 'elementary';
  bootSkipInput.disabled = !skipEnabled;
  bootSkipLabel.classList.toggle('disabled', !skipEnabled);
  if (!skipEnabled) bootSkipInput.checked = false;
}

for (const card of Array.from(bootCards)) {
  card.addEventListener('click', () => {
    const r = card.dataset.role as Role | undefined;
    if (r && (ALL_ROLES as readonly string[]).includes(r)) setSelectedBootRole(r);
  });
}

function showBootModal() {
  bootModal.hidden = false;
  bootModal.setAttribute('aria-hidden', 'false');
  setSelectedBootRole(null);
  bootSkipInput.checked = false;
}

function hideBootModal() {
  bootModal.hidden = true;
  bootModal.setAttribute('aria-hidden', 'true');
}

bootStartBtn.addEventListener('click', () => {
  if (!selectedBootRole) return;
  const choice: BootChoice = {
    role: selectedBootRole,
    skipBasics: bootSkipInput.checked,
    chosenAtMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
  };
  saveBootChoice(choice);
  hideBootModal();
  // Hand the user off to the wizard at the right step. Without
  // this, `start()` would default to step 5 (the evolve screen)
  // and the role + skipBasics choice would have no visible
  // effect — making scenarios 2 and 3 look identical. The
  // decideBootInitialStep helper codifies the PR-A wiring so
  // PR-B / PR-F can override the logic in one place later.
  const initialStep = decideBootInitialStep(choice);
  // Briefly show a toast so the user gets a visible signal that
  // their choice was honoured — this is the "minimum visible
  // difference" between scenario 2 (no skip) and 3 (skip) the
  // user asked for.
  if (choice.skipBasics) {
    toast('已跳过宇宙/星系/恒星阶段,直接进入建立行星');
  } else {
    toast(`欢迎,${ROLE_META[choice.role].label}!从「宇宙」开始`);
  }
  action(start(initialStep));
});

if (loadBootChoice() === null) {
  // First-ever cold start (or after "重新开始"). Show the modal
  // and hold the simulation until the user confirms a role.
  showBootModal();
} else {
  action(start());
}
function updateBranches(d:Projection){
  for(const selectId of ['branch-select','compare-a','compare-b']){
    const select=$<HTMLSelectElement>(selectId),before=select.value;
    const options=d.branches.map(b=>{const o=document.createElement('option');o.value=b.id;o.textContent=b.label;return o;});select.replaceChildren(...options);
    if(selectId==='branch-select')select.value=d.branchId;
    else if(d.branches.some(b=>b.id===before))select.value=before;
    else select.value=selectId==='compare-b'?d.branches.at(-1)!.id:d.branches[0]!.id;
  }
  const list=$('branch-list');list.replaceChildren();
  for(const branch of d.branches){const row=document.createElement('div');row.className='branch-row'+(branch.id===d.branchId?' selected':'');const name=document.createElement('strong'),detail=document.createElement('small');name.textContent=branch.label;detail.textContent=`第 ${branch.tick} 日 · ${format(branch.population)} 个体${branch.parentId?` · 分叉于第 ${branch.forkTick} 日`:''}`;row.append(name,detail);list.append(row);}
  if(d.branches.length>1&&$<HTMLSelectElement>('compare-a').value===$<HTMLSelectElement>('compare-b').value)$<HTMLSelectElement>('compare-b').value=d.branches.find(b=>b.id!==$<HTMLSelectElement>('compare-a').value)!.id;
  $<HTMLButtonElement>('compare-run').disabled=d.branches.length<2;
}
$('open-lab')!.addEventListener('click',()=>{action(send('pause'));activateExplore('branch');});
$('close-lab')!.addEventListener('click',()=>activateExplore(null));
$('branch-select').addEventListener('change',()=>action(send('switch',{id:$<HTMLSelectElement>('branch-select').value})));
$('fork-simple').addEventListener('click',()=>action(send('fork',{id:`branch-${crypto.randomUUID()}`,label:`平行世界 ${(projection?.branches.length??0)+1}`})));
const descriptions:Record<string,{label:string;value:number;note:string}>={
  addNutrient:{label:'投入营养（MU）',value:1000,note:'所填总量平均分到目标区域，记录为外部物质投入。'},
  changeForcing:{label:'额外热量（W/m²，可为负数）',value:100,note:'在指定天数内改变能量收支，结束后自动恢复。'},
  disturbArea:{label:'死亡比例（0—1）',value:0.8,note:'随机死亡的生物转为碎屑，物质不会凭空消失。'},
  seedLife:{label:'投放个体总数',value:100,note:'人工播种冷适应性状，个体与能量储备均记为外部投入。'},
  editTraits:{label:'新的最适温度（K）',value:310,note:'修改选中区域第一个队列的最适温度，其余性状保留；记录人工谱系。'},
};
$('intervention-type').addEventListener('change',()=>{const type=$<HTMLSelectElement>('intervention-type').value,d=descriptions[type]!;$('intervention-value-label').textContent=d.label;$<HTMLInputElement>('intervention-value').value=String(d.value);$<HTMLInputElement>('intervention-value').min=type==='changeForcing'?'-100000':'0';$('forcing-duration-row').hidden=type!=='changeForcing';$('intervention-preview').textContent=d.note;$<HTMLSelectElement>('intervention-scope').disabled=type==='editTraits';});
$('apply-intervention').addEventListener('click',()=>action((async()=>{
  if(!projection)throw new Error('世界尚未准备好');const button=$<HTMLButtonElement>('apply-intervention');button.disabled=true;
  try{
    const branchId=`branch-${crypto.randomUUID()}`,type=$<HTMLSelectElement>('intervention-type').value,value=Number($<HTMLInputElement>('intervention-value').value);
    const cells=$<HTMLSelectElement>('intervention-scope').value==='all'?Array.from({length:projection.temperature.length},(_,i)=>i):[Math.max(0,selected)];
    let payload:Record<string,unknown>;
    if(type==='addNutrient')payload={cells,totalMu:value};
    else if(type==='changeForcing')payload={cells,forcingWPerM2:value,durationTicks:Number($<HTMLInputElement>('forcing-duration').value)};
    else if(type==='disturbArea')payload={cells,mortalityFraction:value};
    else if(type==='seedLife')payload={cells,traitId:'cool',totalCount:value,materialSource:'external',reserveJPerIndividual:20};
    else{const inspection=await send('inspect',{cell:Math.max(0,selected)}),cohort=inspection.cohorts[0];if(!cohort)throw new Error('该区域没有可修改的生命，请先选择有生命的区域');payload={cohortId:cohort.id,count:cohort.count,traits:{...cohort.traits,id:`manual-${crypto.randomUUID()}`,thermalOptimumK:value}};}
    const label=`${$<HTMLSelectElement>('intervention-type').selectedOptions[0]!.text} · ${(projection.branches.length??0)+1}`;
    await send('intervene',{id:branchId,label,command:{id:`cmd-${crypto.randomUUID()}`,branchId,atTick:projection.tick,version:1,type,payload}});
    $<HTMLSelectElement>('compare-b').value=branchId;$('intervention-preview').textContent='干预已应用到新分支，可与原时间线对照。';
  }finally{button.disabled=false;$('cancel-operation').hidden=true;}
})()));
$('compare-run').addEventListener('click',()=>action((async()=>{
  const button=$<HTMLButtonElement>('compare-run');button.disabled=true;$('cancel-operation').hidden=false;$('comparison-result').textContent='正在推进两条时间线…';
  try{const r=await send('compare',{a:$<HTMLSelectElement>('compare-a').value,b:$<HTMLSelectElement>('compare-b').value,ticks:Number($<HTMLSelectElement>('compare-duration').value)});const container=$('comparison-result');container.replaceChildren();const heading=document.createElement('p');heading.textContent=`第 ${r.tick} 日 · B − A`;container.append(heading);
    for(const[label,value]of [['生命个体',`${r.delta.population>=0?'+':''}${format(r.delta.population)}`],['平均温度',`${r.delta.temperatureK>=0?'+':''}${r.delta.temperatureK.toFixed(4)} K`],['可用营养',`${r.delta.nutrientMu>=0?'+':''}${r.delta.nutrientMu.toFixed(2)} MU`],['活跃谱系',`${r.delta.activeLineages>=0?'+':''}${r.delta.activeLineages}`]]){const row=document.createElement('div');row.className='comparison-row';const l=document.createElement('span'),v=document.createElement('strong');l.textContent=label!;v.textContent=value!;row.append(l,v);container.append(row);}
  }catch(error){$('comparison-result').textContent='对照未完成。已保留最后成功的时间步。';throw error;}finally{button.disabled=false;$('cancel-operation').hidden=true;}
})()));

// History panel: the dialog has been retired into the explore-stage
// (UX-7). The mount logic (rendering the chronicle entries + the
// per-epoch detail) lives inline below; the trigger is just
// `activateExplore('history')` from main.ts.
function showEpoch(index:number){const item=historyGuide[index]!;const panel=$('history-detail');panel.replaceChildren();const badge=document.createElement('span');badge.className='badge';badge.textContent='知识导览 · 非模拟状态';const age=document.createElement('div');age.className='epoch-age';age.textContent=item.age;const h=document.createElement('h3');h.textContent=item.title;const body=document.createElement('p');body.textContent=item.body;const a=document.createElement('a');a.href=item.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=item.source+' ↗';panel.append(badge,age,h,body,a);document.querySelectorAll('#history-entries button').forEach((b,i)=>{b.classList.toggle('active',i===index);b.setAttribute('aria-current',String(i===index));});}
historyGuide.forEach((item,index)=>{const button=document.createElement('button');button.textContent=item.title;button.addEventListener('click',()=>showEpoch(index));$('history-entries').append(button);});showEpoch(0);
$('open-history')!.addEventListener('click',()=>{action(send('pause'));activateExplore('history');});
$('close-history')!.addEventListener('click',()=>activateExplore(null));
const lenses:Record<string,string>={science:'依据营养、能量、遗传与环境匹配观察实际出生死亡。模型参数仍需校准。',wuyan:'依赖视角：观察生命对营养和能量的依赖，再通过扰动比较恢复。此设计转译不证明“递弱代偿”是自然定律。',changes:'变化视角：关注温度、种群与资源的趋势和条件转换。《易经》提供解释启发，不决定模拟事件或预测结果。',dependent:'条件视角：观察生命存续依靠哪些条件，条件改变后关系如何变化。工程依赖图不等同于佛教缘起义理的全部。'};
$('lens').addEventListener('change',()=>{$('lens-description').textContent=lenses[$<HTMLSelectElement>('lens').value]!;});

mountCosmos(
  () => send('pause' as RequestType),
  () => send('step' as RequestType),
  () => projection?.tick ?? 0,
  () => activateExplore(null),
);

/**
 * Render the onboarding stage. Steps 1—4 show a hero card; step
 * 5 hides the stage and reveals the planet-view (the existing
 * `<main>` block). The progress bar reflects the active step
 * and dims the dots for steps that aren't reachable yet.
 */
function renderOnboarding() {
  // PR-C: stage visible for steps 1—4; mainEl/explore sidebar
  // visible for steps 5 and 6 (the "演化中" sub-wizard and the
  // "自由探索" terminal stage share the same planet-view).
  const onStage = onboarding.step === 5 || onboarding.step === 6;
  onboardingStage.hidden = onStage;
  if (mainEl) mainEl.hidden = !onStage;
  // Explore sidebar is the post-step-5 navigation; show it on
  // both step 5 (sub-pill 5b exploration) and step 6.
  if (exploreSidebar) exploreSidebar.hidden = !onStage;
  if (onStage) refreshExplore();
  for (const step of [1, 2, 3, 4, 5, 6] as OnboardingStep[]) {
    const panel = onboardingPanelByStep[step];
    if (panel) panel.hidden = onboarding.step !== step;
  }
  for (const dot of Array.from(onboardingDots)) {
    const step = Number(dot.dataset.step) as OnboardingStep;
    dot.setAttribute('aria-current', step === onboarding.step ? 'step' : 'false');
    dot.disabled = !isStepReachable(onboarding, step);
  }
  for (const item of Array.from(onboardingStepItems)) {
    const step = Number(item.dataset.step) as OnboardingStep;
    item.classList.toggle('active', step === onboarding.step);
    item.classList.toggle('completed', onboarding.completedSteps.includes(step));
  }
  onboardingPrev.disabled = onboarding.step <= 1;
  // PR-C: step 6 is the new terminal "自由探索" stage. Power
  // users still use the progress dots to revisit earlier steps.
  onboardingNext.disabled = onboarding.step >= 6;
  onboardingNext.textContent = onboarding.step === 4 ? '建立世界并演化 →' : '下一步 →';
  onboardingProgressLabel.textContent = `第 ${onboarding.step} / 6 步`;
  // PR-C: 5a / 5b / 6 sub-pills — reflect current phase, lock
  // pills the user hasn't earned yet, and update the "X / Y 日"
  // progress label using the live `tick` from the worker.
  updateStep5Substep(projection?.tick ?? 0);
  // The cosmos dialog has its own "进入当前生命星球" button
  // that lands on step 5; we wire that here so the user can
  // both arrive at step 5 from a "deeper" dialog AND jump to
  // step 5 directly from the progress bar.
  const cosmosPlanetBtn = $('cosmos-planet');
  if (cosmosPlanetBtn) {
    cosmosPlanetBtn.onclick = () => goToStep(5);
  }
  // Sync the header "新建世界" button to the same wizard so
  // it doesn't drop the user back to a half-finished state.
  const newWorldBtn = $('new-world');
  if (newWorldBtn) {
    newWorldBtn.onclick = () => { action(send('pause')); goToStep(4); };
  }
}

/**
 * PR-C: reflect the 5a / 5b / 6 sub-state in the sub-step
 * pills, gate pills the user hasn't earned yet, and refresh
 * the "X / Y 日" progress label. Pure render — no state
 * mutation; the tick listener calls `maybeAutoAdvancePhase5`
 * separately so we don't recursively re-render.
 */
function updateStep5Substep(tick: number): void {
  const nav = $('step5-substep');
  if (!nav) return;
  // Hide the entire sub-step bar until the user reaches step 5
  // (the sub-pills are a 5a/5b/6 thing, not a 1—4 thing).
  nav.hidden = onboarding.step < 5;
  if (nav.hidden) return;
  const phase5aDone = step5aComplete(tick);
  const phase5bDone = step5bComplete(tick);
  const pills: Array<{ phase: Step5Phase; el: HTMLButtonElement | null; done: boolean; label: string }> = [
    { phase: '5a', el: nav.querySelector<HTMLButtonElement>('[data-phase="5a"]'), done: phase5aDone, label: `${Math.min(tick, STEP_5A_DONE_TICK)} / ${STEP_5A_DONE_TICK} 日` },
    { phase: '5b', el: nav.querySelector<HTMLButtonElement>('[data-phase="5b"]'), done: phase5bDone, label: `${Math.min(tick, STEP_5B_DONE_TICK)} / ${STEP_5B_DONE_TICK} 日` },
    { phase: '6',  el: nav.querySelector<HTMLButtonElement>('[data-phase="6"]'),  done: phase5bDone, label: phase5bDone ? '已解锁' : '等待 5b 完成' },
  ];
  for (const p of pills) {
    if (!p.el) continue;
    p.el.setAttribute('aria-pressed', String(onboarding.step === 5 ? onboarding.phase5 === p.phase : onboarding.step === 6 && p.phase === '6'));
    // 5a is always reachable; 5b unlocks once 5a is done; 6
    // unlocks once 5b is done (or the user is already on 6).
    p.el.disabled = !(
      p.phase === '5a' ||
      (p.phase === '5b' && phase5aDone) ||
      (p.phase === '6' && phase5bDone) ||
      onboarding.step === 6
    );
    const progress = p.el.querySelector<HTMLElement>('.step5-substep-progress');
    if (progress) progress.textContent = p.label;
  }
}

/**
 * PR-C: tick listener that promotes the sub-state when the
 * elapsed day count meets the step-5 thresholds. Idempotent —
 * re-renders but does not loop because each branch clears the
 * precondition before the next call.
 */
function maybeAutoAdvancePhase5(tick: number): void {
  // Only meaningful once the user is on step 5 or step 6.
  if (onboarding.step < 5) return;
  if (onboarding.step === 6) return; // already terminal
  // 5a → 5b
  if (onboarding.phase5 === '5a' && step5aComplete(tick)) {
    onboarding = setStep5Phase(onboarding, '5b');
    persistOnboarding();
    renderOnboarding();
    toast(`已自动进入 5b(生命演化),阈值 ${STEP_5A_DONE_TICK} 日`);
    return;
  }
  // 5b → 6 (自由探索)
  if (onboarding.phase5 === '5b' && step5bComplete(tick)) {
    onboarding = setStep5Phase(onboarding, '6');
    onboarding = advanceOnboardingState(onboarding, 6);
    persistOnboarding();
    renderOnboarding();
    toast(`已自动进入第 6 步「自由探索」,阈值 ${STEP_5B_DONE_TICK} 日`);
  }
}

/**
 * PR-C: pill click handlers. We bind once at module load —
 * the buttons are stable elements that live in `<main>`'s
 * static markup, so the listeners are never re-attached.
 */
function bindStep5SubstepHandlers(): void {
  const nav = $('step5-substep');
  if (!nav) return;
  for (const pill of Array.from(nav.querySelectorAll<HTMLButtonElement>('.step5-substep-pill'))) {
    const phase = pill.dataset.phase as Step5Phase | undefined;
    if (!phase) continue;
    pill.addEventListener('click', () => {
      if (pill.disabled) return;
      if (phase === '5a') {
        // Re-entering 5a from 5b is allowed (lets the user
        // re-watch the planet evolution). We keep `step = 5`
        // and just flip the phase; the next tick will re-fire
        // `maybeAutoAdvancePhase5` if the threshold is met.
        if (onboarding.step === 6) {
          // From step 6 the user can re-open 5a by stepping
          // back to step 5 with phase 5a.
          onboarding = advanceOnboardingState(onboarding, 5);
        }
        onboarding = setStep5Phase(onboarding, '5a');
        persistOnboarding();
        renderOnboarding();
      } else if (phase === '5b') {
        onboarding = setStep5Phase(onboarding, '5b');
        persistOnboarding();
        renderOnboarding();
      } else if (phase === '6') {
        onboarding = setStep5Phase(onboarding, '6');
        onboarding = advanceOnboardingState(onboarding, 6);
        persistOnboarding();
        renderOnboarding();
        toast('进入第 6 步「自由探索」');
      }
    });
  }
}

function goToStep(step: OnboardingStep) {
  // Disallow skipping ahead unless the target is reachable.
  if (!isStepReachable(onboarding, step)) {
    toast('请先完成前面的步骤', 'error');
    return;
  }
  // Closing any open dialogs keeps the visual state consistent.
  for (const id of ['cosmos-dialog', 'galaxy-dialog']) {
    const el = document.getElementById(id) as HTMLDialogElement | null;
    if (el && el.open) el.close();
  }
  onboarding = advanceOnboardingState(onboarding, step);
  persistOnboarding();
  renderOnboarding();
}

for (const dot of Array.from(onboardingDots)) {
  dot.addEventListener('click', () => {
    const step = Number(dot.dataset.step) as OnboardingStep;
    goToStep(step);
  });
}
onboardingPrev.addEventListener('click', () => {
  if (onboarding.step > 1) goToStep((onboarding.step - 1) as OnboardingStep);
});
onboardingNext.addEventListener('click', () => {
  if (onboarding.step < 6) goToStep((onboarding.step + 1) as OnboardingStep);
});
// PR-C: bind 5a/5b/6 sub-pill click handlers (5a re-entry,
// 5b advance, 6 manual unlock). The pill DOM lives inside
// `<main>` so it is stable across re-renders — listeners are
// attached once at module load.
bindStep5SubstepHandlers();
onboardingReset.addEventListener('click', () => {
  if (!confirm('重置到第 1 步？已完成进度会清空。')) return;
  // PR-C: phase5 also resets to 5a so the user re-walks the
  // 5a/5b/6 ladder; otherwise an old `phase5 = '6'` from a
  // previous wizard would be retained across a reset, which
  // is misleading.
  onboarding = { step: 1, phase5: '5a', completedSteps: [], finishedAtMs: null };
  // PR-A: also clear the boot choice so the next cold start
  // re-asks "你是哪种读者?" rather than auto-resuming a
  // role that the user explicitly just reset past.
  clearBootChoice();
  persistOnboarding();
  renderOnboarding();
  showBootModal();
});

// Step CTAs: open the matching dialog but keep the stage visible
// so the user can close the dialog and see the next-step CTA.
for (const skip of Array.from(document.querySelectorAll<HTMLButtonElement>('.onboarding-skip'))) {
  const actionName = skip.dataset.action;
  if (actionName === 'cosmos') skip.addEventListener('click', () => activateExplore('cosmos'));
  else if (actionName === 'galaxies') skip.addEventListener('click', () => activateExplore('galaxy'));
  else if (actionName === 'create') skip.addEventListener('click', () => { action(send('pause')); goToStep(4); });
}
// PR-B: CTAs no longer teleport to step 5. They open the
// matching explore panel; when the user closes that panel
// (via the back button, ESC, or any in-panel close control),
// `maybeAdvanceFromExploreClose` (wired inside `activateExplore`)
// auto-advances the wizard to the next step. This is the
// "function-of-action" completion criterion the user asked
// for in the design review — visiting a step's panel is the
// proof of completion, not a separate "完成" click.
document.getElementById('onboarding-cta-1')!.addEventListener('click', () => activateExplore('cosmos'));
document.getElementById('onboarding-cta-2')!.addEventListener('click', () => activateExplore('galaxy'));
document.getElementById('onboarding-cta-3')!.addEventListener('click', () => activateExplore('v14'));
// Cross-panel navigation: any "open another panel" button
// inside a panel dispatches `explore-activate` with the new
// panel id. The host listens and updates the stage. This is
// how mountGalaxies triggers galaxy→cosmos→galaxy chains
// without the panel module having to know about activateExplore.
document.addEventListener('explore-activate', (e) => {
  const id = (e as CustomEvent<string>).detail;
  if (id && ALL_EXPLORE_PANELS.includes(id as never)) {
    activateExplore(id as ExplorePanelId);
  }
});

// Phase 6: keyboard shortcuts. The 9 explore panels map to
// number keys 1—9 in the sidebar order; Esc returns to the
// planet view; R jumps to the top recommendation. We only
// listen when the user is on step 5 (otherwise the digits
// would compete with form input). Inputs / textareas
// / contenteditable elements are excluded so users can type
// numbers into seed / temperature fields without being
// hijacked.
const KEY_TO_PANEL: Record<string, ExplorePanelId> = {
  '1': 'cosmos', '2': 'galaxy', '3': 'v14',
  '4': 'chemistry', '5': 'colonies', '6': 'cognition',
  '7': 'settlement', '8': 'earth', '9': 'batch',
};
function isTypingInForm(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}
function isHelpOpen(): boolean {
  // Treat the V14 / cosmos / galaxy / create / branch /
  // history dialogs (still <dialog>s for the deep-path) as
  // modal — shortcuts are inert when one is open.
  for (const id of ['v14-dialog', 'cosmos-dialog', 'galaxy-dialog', 'branch-dialog', 'history-dialog']) {
    const el = document.getElementById(id) as HTMLDialogElement | null;
    if (el && el.open) return true;
  }
  return false;
}
document.addEventListener('keydown', (e) => {
  // Don't steal keys when the user is in a form field or a
  // dialog is modal.
  if (isTypingInForm(e.target)) return;
  if (isHelpOpen()) return;
  // Esc returns to the planet view.
  if (e.key === 'Escape') {
    if (!exploreStage.hidden) {
      e.preventDefault();
      activateExplore(null);
    }
    return;
  }
  // R jumps to the top recommendation.
  if (e.key === 'r' || e.key === 'R') {
    if (onboarding.step !== 5) return;
    const top = exploreRecommendBtn.dataset.explore as ExplorePanelId | undefined;
    if (top) {
      e.preventDefault();
      activateExplore(top);
    }
    return;
  }
  // 1—9 maps to the 9 panels.
  if (onboarding.step !== 5) return;
  const target = KEY_TO_PANEL[e.key];
  if (target) {
    e.preventDefault();
    activateExplore(target);
  }
});

// The on-stage create form (step 4) submits the same fields as
// the legacy create-dialog. When the user submits here we go
// straight to step 5 (演化) and create the world in the same
// pipeline as the legacy `new-world` button.
document.getElementById('onboarding-create-form')!.addEventListener('submit', (e) => {
  e.preventDefault();
  const scenario = ($('onboarding-scenario') as HTMLSelectElement).value;
  const seed = ($('onboarding-seed') as HTMLInputElement).value;
  const temperature = Number(($('onboarding-initial-temperature') as HTMLInputElement).value);
  const cells = Number(($('onboarding-resolution') as HTMLSelectElement).value);
  $('loading')!.hidden = false;
  chart = []; selected = -1; lastSavedTick = -1; lastSavedBranch = '';
  action(send('create', { scenario, seed, temperature, cells }).then(async () => {
    // P3 — fetch the cell-centre lookup once the world
    // exists. The surface view can already be constructed
    // (without markers) before this resolves; markers just
    // appear once the lookup is in.
    await loadCellCenters();
    goToStep(5);
  }));
});

// P12 / P13 prebiotic panel: chemistry reactor + colonial organisms.
// The controller already routes `internalTick` to auto-step both
// subsystems in silent mode once a network / registry is loaded, so
// the user only needs the per-step buttons to nudge the systems
// independently of the planetary tick.
const renderPrebiotic = mountPrebiotic(
  (type, payload) => send(type as RequestType, payload),
  (msg, isError) => toast(msg, isError ? 'error' : 'info'),
  () => activateExplore(null),
);
$('open-prebiotic')!.addEventListener('click', () => { action(send('pause')); activateExplore('chemistry'); });

// P14 cognition panel: multi-task (foraging / thermoregulation /
// aggregation) + multi-agent (per cohort). Auto-steps in lockstep
// with the planetary tick once loaded (silent mode).
const renderCognition = mountCognition(
  (type, payload) => send(type as RequestType, payload),
  (msg, isError) => toast(msg, isError ? 'error' : 'info'),
  () => activateExplore(null),
);
$('open-cognition')!.addEventListener('click', () => { action(send('pause')); activateExplore('cognition'); });

// P15 settlement panel: template-seeded independent civilisation
// layer (per docs/15 P15). Auto-steps in lockstep with the
// planetary tick once loaded (silent mode).
//
// The "📷 生成 3D 天际线" button (per settlement) closes over
// `prefillCityscape` from the V14 panel: clicking it opens the
// V14 dialog with a pre-filled `cityscape` spec, then auto-
// triggers the generate handler so the user gets a 3D model
// without any extra click.
const v14Panel = mountV14(
  (type, payload) => send(type as RequestType, payload),
  (msg, isError) => toast(msg, isError ? 'error' : 'info'),
  () => activateExplore(null),
);
const renderV14 = v14Panel.render;
const renderSettlement = mountSettlement(
  (type, payload) => send(type as RequestType, payload),
  (msg, isError) => toast(msg, isError ? 'error' : 'info'),
  (settlementId, label) => {
    v14Panel.prefillCityscape(settlementId, label);
    activateExplore('v14');
  },
  () => activateExplore(null),
);
$('open-settlement')!.addEventListener('click', () => { action(send('pause')); activateExplore('settlement'); });

// P16 Earth-data calibration panel. Wires `earthDataLoad` (in-repo
// synthetic Holocene series) and `earthDataCompare` (RMSE vs a
// transparent baseline on a holdout window). The phase-1 model
// trajectory is a placeholder constant; phase 2 wires a real
// multi-seed batch (P17).
const renderEarth = mountEarth(
  (type, payload) => send(type as RequestType, payload),
  (msg, isError) => toast(msg, isError ? 'error' : 'info'),
  () => activateExplore(null),
);
$('open-earth')!.addEventListener('click', () => { action(send('pause')); activateExplore('earth'); });

// P17 batch panel. The runner is synchronous (each seed gets a
// fresh controller), so the click blocks for the duration of the
// batch — phase 1 is a tool, not the main interaction loop.
const renderBatch = mountBatch(
  (type, payload) => send(type as RequestType, payload),
  (msg, isError) => toast(msg, isError ? 'error' : 'info'),
  () => activateExplore(null),
);
$('open-batch')!.addEventListener('click', () => { action(send('pause')); activateExplore('batch'); });

// V14 visual route (3D procedural models). The 5 kinds run in-repo
// per docs/04; the three commercial backends (worldLabs / atlas /
// spark) throw with an honest "API key + commercial agreement
// required" message. The panel renders the resulting mesh with
// Three.js (BufferGeometry + MeshStandardMaterial + OrbitControls)
// so the user can drag-rotate / scroll-zoom the model. Snapshot
// list (v14Snapshots) round-trips through book export / import.
//
// F: snapshot list is grouped by `createdAtBranch`, and the
//    compare-mode selector spans all branches so the user can
//    contrast, say, a "rocky coast" snapshot from `main` with a
//    "smooth coast" snapshot from a fork branch.
//
// G: the left column has a "batch parameter scan" section that
//    runs the controller's `v14BatchScan` handler across a
//    user-chosen seeds × kinds × styles matrix and renders the
//    resulting histogram + stats inline as SVGs.
//
// I: the panel also accepts a `prefillCityscape(settlementId,
//    label)` call from the P15 "📷 生成 3D 天际线" button. The
//    spec is built with `kind: 'cityscape'` + the settlement id
//    pre-filled; the controller resolves the rest (population /
//    knowledge / institution / cell area / nutrient) on the
//    worker side so the UI doesn't have to.
$('open-v14')!.addEventListener('click', () => { action(send('pause')); activateExplore('v14'); });
$('open-cosmos')!.addEventListener('click', () => { action(send('pause')); activateExplore('cosmos'); });
// `#open-galaxies` is bound inside mountGalaxies (it dispatches a
// stop-cosmic-playback event before running). The button is
// inside the cosmos panel so it has the right scope there.

$('expand-capacity').addEventListener('click',()=>action(send('expandCapacity',{id:`capacity-${crypto.randomUUID()}`}).then(()=>{$('toast').hidden=true;})));

$('refine-world').addEventListener('click',()=>action(send('refine',{id:`refine-${crypto.randomUUID()}`}).then(()=>{selected=-1;view?.select(-1);$('inspection').replaceChildren();})));

// `mountGalaxies` consumes the legacy `(type, payload) => Promise<any>` shape;
// wrap to bridge the typed `send` overloads without losing payload narrowing
// at the call sites above.
mountGalaxies(
  (type, payload) => send(type as RequestType, payload),
  () => activateExplore(null),
);
