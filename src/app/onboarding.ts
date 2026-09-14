/**
 * Onboarding state machine — 5-step progressive disclosure.
 *
 * The 5 steps map to the natural "from cosmos to a living planet"
 * cognitive journey:
 *
 *   1. 宇宙  — ΛCDM 背景 + Hubble 膨胀 + 暗能量占比
 *   2. 星系  — 8 个气体晕 → 第一代恒星群 + 引力装配
 *   3. 恒星  — 在一个气体晕里选一颗合适的恒星 + 周围类地行星
 *   4. 行星  — 初始化类地行星(场景 / 种子 / 温度 / 精度)
 *   5. 演化  — 推进 + 干预 + 对照 + 历史 + 各子系统实验
 *
 * Each step renders a hero card on the main stage; the user can
 * either drill into the related dialog (cosmos / galaxies /
 * create / planet) or advance to the next step. The "completed"
 * flag per step unlocks the progress dots and lets the user
 * jump back to a previous step.
 *
 * State is persisted in `localStorage` so the user picks up
 * where they left off. The key is namespaced (`my-universe-v1`)
 * so a future schema change can bump the version without
 * touching the old data.
 */

export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6;

export const ALL_ONBOARDING_STEPS: readonly OnboardingStep[] = [1, 2, 3, 4, 5, 6] as const;

/**
 * PR-B — completion-criterion hooks.
 *
 * Each step 1—4 has an associated *completion action* (the
 * physical thing the user has to do, not just "look at the
 * panel"). When the app observes that action, it marks the
 * step as completed and (optionally) auto-advances to the
 * next one. This is the function-of-action completion
 * criterion the user requested in the design review —
 * the previous behaviour only flipped `step` to 5 directly,
 * so scenarios 2 and 3 looked identical.
 *
 * The mapping lives here, not in `main.ts`, so PR-F (学段适配)
 * can override the wiring without spelunking the main bundle.
 */
export const STEP_COMPLETION: Record<OnboardingStep, { panel: string | null; nextStep: OnboardingStep | null }> = {
  1: { panel: 'cosmos',  nextStep: 2 },     // step 1 → 看宇宙背景
  2: { panel: 'galaxy',  nextStep: 3 },     // step 2 → 看星系演化
  3: { panel: 'v14',     nextStep: 4 },     // step 3 → 选恒星系统
  4: { panel: 'create',  nextStep: 5 },     // step 4 → 初始化行星(走 form submit 路径)
  5: { panel: null,      nextStep: null },  // step 5 内部拆 5a/5b,由 sub-completion 推进
  6: { panel: null,      nextStep: null },  // step 6 = 自由探索,终态
};

/**
 * Pure helper: given the current step, return the step the
 * user should land on after they complete the *completion
 * action* for that step. Returns `null` when the step is
 * terminal (step 5) or the action does not auto-advance.
 */
export function nextStepAfterCompletion(step: OnboardingStep): OnboardingStep | null {
  return STEP_COMPLETION[step].nextStep;
}

/**
 * PR-C — step 5a / 5b split + sub-completion.
 *
 * Step 5 used to be a single terminal "演化" stage. The 6-stage
 * design review split it into:
 *   - 5a (行星演化): watch the planet run for ~100 simulated
 *     days. Done when `tick >= 100`.
 *   - 5b (生命演化): keep watching for ~1000 simulated days
 *     so the population curve has time to settle. Done when
 *     `tick >= 1000`.
 *   - 6 (自由探索): open the explore sidebar, run interventions,
 *     compare branches. The previous "explore" surface.
 *
 * The thresholds (100 / 1000) are deliberate defaults from the
 * 6-stage design doc; both `step5aComplete` and `step5bComplete`
 * accept any `tick` value so PR-F (学段适配) can lower them for
 * `elementary` without us having to re-architect.
 */

/** Default tick threshold for completing step 5a. */
export const STEP_5A_DONE_TICK = 100;

/** Default tick threshold for completing step 5b. */
export const STEP_5B_DONE_TICK = 1000;

/**
 * PR-F — per-role tick thresholds for the 5a / 5b sub-phases.
 * The K12 design review split `Role` into four audiences with
 * different attention spans; elementary students should not
 * wait 1000 simulated days to reach 自由探索, while 高中生
 * are encouraged to run longer to see equilibrium dynamics.
 * The defaults above remain in case a cold start has no
 * `BootChoice` (shouldn't happen after PR-A, but keeps the
 * helpers safe).
 */
export const ROLE_THRESHOLDS: Record<Role, { step5aTick: number; step5bTick: number }> = {
  elementary: { step5aTick: 50,   step5bTick: 200  }, // 短小快,先把故事讲完
  middle:    { step5aTick: 100,  step5bTick: 1000 }, // 默认
  high:      { step5aTick: 200,  step5bTick: 2000 }, // 留时间看平衡
  teacher:   { step5aTick: 100,  step5bTick: 1000 }, // 同 middle,加教学提示
};

/**
 * PR-F — pick the live 5a/5b tick thresholds for the current
 * boot choice. Falls back to the 100/1000 defaults when no
 * boot choice is present.
 */
export function getRoleThresholds(boot: BootChoice | null): { step5aTick: number; step5bTick: number } {
  if (!boot) return { step5aTick: STEP_5A_DONE_TICK, step5bTick: STEP_5B_DONE_TICK };
  return ROLE_THRESHOLDS[boot.role];
}

/**
 * PR-F — role-specific guidance for each step. Keys mirror
 * `OnboardingStep`. Each entry is a short sentence the wizard
 * surfaces in the hero card body when the user has picked
 * the matching role. Roles without an override (e.g. teacher
 * on step 1) fall back to the default `STEP_META` body.
 */
export const ROLE_STEP_GUIDANCE: Partial<Record<OnboardingStep, Partial<Record<Role, string>>>> = {
  1: {
    elementary: '想象一个比沙粒还小的点,慢慢变成满天星斗。这是宇宙的开始 — 不用记数字,先看看颜色怎么变。',
    middle:    'ΛCDM 简化背景:H₀ = 67.4 km/s/Mpc · Ωm = 0.315 · ΩΛ = 0.685。看 138 亿年尺度上空间的膨胀。',
    high:      '平坦 ΛCDM 背景(教学简化,不是观测校准)。重点观察 138 亿年间空间膨胀 + 暗能量占比。',
  },
  2: {
    elementary: '8 团气体云会自己变成星系。点一个看,看 5 百万年会发生什么。',
    middle:    '8 个孤立气体晕(不叠加哈勃流)。每个晕有自己的质量、坐标和 5 Myr 步长。',
    high:      '预置 8 个气体晕,孤立系统(不叠加哈勃流)。看坍缩 + 第一代恒星群 + 引力装配。',
  },
  3: {
    elementary: '在气体云里挑一颗"合适"的恒星,周围有类地行星就行。',
    middle:    '恒星用三个质量档(0.1 / 1 / 10 M☉)与教学寿命/回流/光度值,并未观测校准。',
    high:      '恒星三质量档(0.1/1/10 M☉)与教学值,未做观测校准 — 与现实有出入,设计取舍见 model card。',
  },
  4: {
    elementary: '选一个起点,接下来我们就看你这颗行星上会发生什么。',
    middle:    '场景决定生命起点(两种生命/无生命/有限资源),种子决定可复现的演化历史。',
    high:      '场景 = 生命起点 + 物质约束;种子 = 复现性;初始温度决定 habitable zone 位置。',
  },
  5: {
    elementary: '等一会儿,让星星自己讲故事 — 我们看看温度、生命会怎么变。',
    middle:    '5a(行星 100 日) + 5b(生命 1000 日)。先看行星本身的物理/化学演化,再追踪生命曲线。',
    high:      '5a 行星物理/化学 100 日 → 5b 生命曲线 1000 日 → 自由探索。三个阶段都通过 tick 阈值自动推进。',
  },
  6: {
    elementary: '接下来你可以随便玩 — 改温度、加营养、看看星球会怎样。',
    middle:    '所有 P1—P9 + P12—P17 实验都开放。推进 / 干预 / 对照 / 化学 / 多细胞 / 智能 / 聚落 / 校准 / 批量。',
    high:      '自由探索阶段:可用 P1—P9 + P12—P17 全套工具。重点对照实验(addNutrient/changeForcing/editTraits)。',
  },
};

/**
 * PR-F — pick the role-specific guidance for a given step +
 * role. Falls back to the default `STEP_META` body when no
 * role-specific text exists.
 */
export function getRoleStepGuidance(step: OnboardingStep, role: Role | null): string {
  if (role !== null) {
    const byStep = ROLE_STEP_GUIDANCE[step];
    if (byStep) {
      const text = byStep[role];
      if (text) return text;
    }
  }
  return STEP_META[step].body;
}

/**
 * Step 5 has two sub-stages tracked out-of-band in `OnboardingState`.
 * We model them as a string sub-state so the rest of the code can
 * still treat the wizard as 6 steps (no 5.5 / 5.75 in the type).
 */
export type Step5Phase = '5a' | '5b' | '6';

export const DEFAULT_STEP5_PHASE: Step5Phase = '5a';

/** Pure helper: returns true if the world has run long enough to
 *  finish step 5a (planet evolution). */
export function step5aComplete(tick: number, threshold: number = STEP_5A_DONE_TICK): boolean {
  return tick >= threshold;
}

/** Pure helper: returns true if the world has run long enough to
 *  finish step 5b (life evolution, the slower phase). */
export function step5bComplete(tick: number, threshold: number = STEP_5B_DONE_TICK): boolean {
  return tick >= threshold;
}

/**
 * PR-A — Boot choice (role / skipBasics).
 *
 * The cold-start onboarding now begins with a *role* selection so
 * that downstream panels (PR-F, 学段适配) can tailor wording,
 * skipped steps, and recommendation strength. The role is shown
 * once per browser, persisted in `localStorage`, and the user can
 * re-pick via the existing "重新开始" button (which also clears
 * the onboarding state).
 *
 * Storage layout:
 *   - `my-universe-boot-v1` → `BootChoice` JSON, or absent
 *
 * The `OnboardingState` is intentionally NOT extended — boot lives
 * in its own slot so the 5-step wizard keeps a stable schema and
 * old localStorage payloads keep loading. Future PR-F will read
 * `loadBootChoice()` to seed the initial `OnboardingState.step`.
 */
export type Role = 'elementary' | 'middle' | 'high' | 'teacher';

export const ALL_ROLES: readonly Role[] = ['elementary', 'middle', 'high', 'teacher'] as const;

/** Human-readable role label (zh-CN). Used in the modal and
 *  (later) in the "step 0" eyebrow of the wizard. */
export const ROLE_META: Record<Role, { label: string; tagline: string; audience: string }> = {
  elementary: {
    label: '小学生',
    tagline: '看个故事,不必纠结公式',
    audience: '小学 5—6 年级 · 直观体验',
  },
  middle: {
    label: '初中生',
    tagline: '跟着走完一遍流程',
    audience: '初中 · 系统化观察',
  },
  high: {
    label: '高中生',
    tagline: '对照现实数据自己推理',
    audience: '高中 · 探究与挑战',
  },
  teacher: {
    label: '老师',
    tagline: '准备课堂演示 + 学生挑战',
    audience: '教师 · 教学场景',
  },
};

export interface BootChoice {
  /** Selected role. */
  role: Role;
  /** When true, the user has asked to skip the cosmos / galaxy
   *  steps (steps 1—3) on the next cold start and jump straight
   *  to "create a planet" (step 4). Honoured only for `middle`,
   *  `high`, and `teacher` roles — `elementary` always walks
   *  the full 5 steps. */
  skipBasics: boolean;
  /** `performance.now()` at the moment the user confirmed. */
  chosenAtMs: number;
}

export const BOOT_STORAGE_KEY = 'my-universe-boot-v1';

function isRole(v: unknown): v is Role {
  return v === 'elementary' || v === 'middle' || v === 'high' || v === 'teacher';
}

/** A boot choice is considered "valid" only if the role is one
 *  of the four known values. `skipBasics` must be a boolean. */
function sanitiseBoot(raw: unknown): BootChoice | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isRole(o.role)) return null;
  if (typeof o.skipBasics !== 'boolean') return null;
  if (typeof o.chosenAtMs !== 'number') return null;
  return {
    role: o.role,
    skipBasics: o.skipBasics,
    chosenAtMs: o.chosenAtMs,
  };
}

/**
 * Read the persisted boot choice. Returns `null` on a cold start,
 * on parse failure, when `localStorage` is unavailable, or when
 * the stored shape is invalid (e.g. role typo).
 */
export function loadBootChoice(): BootChoice | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(BOOT_STORAGE_KEY);
    if (raw === null) return null;
    return sanitiseBoot(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Persist a boot choice. No-op when `localStorage` is unavailable. */
export function saveBootChoice(choice: BootChoice): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(BOOT_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Quota / private mode: silently drop. The choice stays in
    // memory for the current session, just not across reloads.
  }
}

/** Remove the persisted boot choice. Used by the "重新开始"
 *  button so the next cold start re-shows the role modal. */
export function clearBootChoice(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(BOOT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export interface OnboardingState {
  /** Current step (1—6). The progress bar highlights this dot. */
  step: OnboardingStep;
  /** PR-C: which sub-phase of step 5 the user is currently in.
   *  Only meaningful when `step === 5`. Persists across reloads
   *  so closing the tab mid-5b does not reset to 5a. */
  phase5: Step5Phase;
  /** Set of step numbers the user has already passed. Once
   *  step N is reached, all steps 1—N are marked completed so
   *  the user can freely click back. */
  completedSteps: OnboardingStep[];
  /** When the user finished step 6 for the first time. We
   *  show the wizard again on every cold start until this is
   *  set, so a brand-new user always lands on step 1. */
  finishedAtMs: number | null;
}

export const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  step: 1,
  phase5: DEFAULT_STEP5_PHASE,
  completedSteps: [],
  finishedAtMs: null,
};

const STORAGE_KEY = 'my-universe-onboarding-v1';

function isStep(n: unknown): n is OnboardingStep {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5 || n === 6;
}

function sanitise(raw: unknown): OnboardingState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ONBOARDING_STATE };
  const o = raw as Record<string, unknown>;
  const step = isStep(o.step) ? o.step : 1;
  const phase5: Step5Phase = o.phase5 === '5b' || o.phase5 === '6' ? o.phase5 : '5a';
  const completed = Array.isArray(o.completedSteps)
    ? (o.completedSteps.filter(isStep) as OnboardingStep[])
    : [];
  const finishedAtMs = typeof o.finishedAtMs === 'number' ? o.finishedAtMs : null;
  return { step, phase5, completedSteps: completed, finishedAtMs };
}

/**
 * Read the persisted state. Falls back to `DEFAULT_ONBOARDING_STATE`
 * on a cold start, on parse failure, or when `localStorage` is
 * unavailable (e.g. SSR / private mode).
 */
export function loadOnboardingState(): OnboardingState {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_ONBOARDING_STATE };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_ONBOARDING_STATE };
    return sanitise(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_ONBOARDING_STATE };
  }
}

/** Persist state. No-op when `localStorage` is unavailable. */
export function saveOnboardingState(state: OnboardingState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota / private mode: silently drop. The state stays in
    // memory for the current session, just not across reloads.
  }
}

/** Mark `step` as the current step and append it (and every
 *  step before it) to `completedSteps`. Idempotent. */
export function advanceOnboardingState(state: OnboardingState, step: OnboardingStep): OnboardingState {
  if (step === state.step) return state;
  const completed = new Set<OnboardingStep>(state.completedSteps);
  for (let s = 1 as OnboardingStep; s <= step; s = (s + 1) as OnboardingStep) {
    completed.add(s);
  }
  const next: OnboardingState = {
    step,
    // Preserve the user's current 5a/5b/6 phase unless they're
    // explicitly leaving step 5 — when they enter 5 fresh or
    // jump back to 5 we reset to 5a so the sub-tabs re-show
    // the "planet evolution" framing. Leaving step 5 (to 6) is
    // the responsibility of `setStep5Phase`, which runs before
    // the caller re-invokes `advanceOnboardingState`.
    phase5: step === 5 ? '5a' : state.phase5,
    completedSteps: [...completed].sort((a, b) => a - b),
    finishedAtMs: state.finishedAtMs,
  };
  if (step === 6) {
    next.finishedAtMs = state.finishedAtMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }
  return next;
}

/**
 * PR-C: set the step-5 sub-phase. Idempotent. Returns a new
 * `OnboardingState` with `phase5` updated; the `step` field is
 * left untouched so callers that want to combine a phase bump
 * with a step advance (e.g. 5b → 6) can do:
 *
 *   state = setStep5Phase(advanceOnboardingState(state, 6), '6');
 */
export function setStep5Phase(state: OnboardingState, phase: Step5Phase): OnboardingState {
  if (state.phase5 === phase) return state;
  return { ...state, phase5: phase };
}

/** Pure helper: is `target` reachable from `current` (either
 *  the same step, a step that has been completed, or one step
 *  past the highest reached step). Used by the UI to decide
 *  which progress dots are clickable. "Highest reached" is the
 *  max of `state.step` and every `state.completedSteps` entry
 *  so the user can always click forward from wherever they
 *  are right now. */
export function isStepReachable(state: OnboardingState, target: OnboardingStep): boolean {
  if (target === state.step) return true;
  if (state.completedSteps.includes(target)) return true;
  const candidates: number[] = [state.step, ...state.completedSteps];
  const max = candidates.length === 0 ? 0 : Math.max(...candidates);
  return target === max + 1;
}

/** Label / description / primary CTA per step. */
export const STEP_META: Record<OnboardingStep, {
  eyebrow: string;
  title: string;
  body: string;
  cta: { label: string; action: 'cosmos' | 'galaxies' | 'create' | 'play' };
}> = {
  1: {
    eyebrow: 'STEP 1 / COSMOS',
    title: '从一个宇宙开始',
    body: '平坦 ΛCDM 简化背景 · H₀ = 67.4 km/s/Mpc · Ωm = 0.315 · ΩΛ = 0.685。点击下方"看宇宙背景"先观察 138 亿年尺度上的大尺度结构 —— 这里不计算引力聚集或恒星演化，只是空间膨胀的示意。',
    cta: { label: '看宇宙背景', action: 'cosmos' },
  },
  2: {
    eyebrow: 'STEP 2 / GALAXY',
    title: '落入一片气体云',
    body: '8 个预置气体晕（孤立系统，不叠加哈勃流）。每个晕有自己的质量、坐标和 5 Myr 恒星步长。点击"看星系演化"观察坍缩 + 第一代恒星群 + 引力装配。',
    cta: { label: '看星系演化', action: 'galaxies' },
  },
  3: {
    eyebrow: 'STEP 3 / STAR & PLANET',
    title: '选一颗恒星 + 周围行星',
    body: 'P10 阶段为教学简化：恒星用三个质量档（0.1 / 1 / 10 M☉）与寿命 / 回流 / 光度教学值，并未观测校准。点击"选恒星系统"查看预置 8 个气体晕里恒星群分布；下一步才会进入行星初始化。',
    cta: { label: '选恒星系统', action: 'galaxies' },
  },
  4: {
    eyebrow: 'STEP 4 / PLANET',
    title: '创造一颗类地行星',
    body: '选择场景、种子、初始温度和观察精度。场景决定生命起点（两种生命 / 无生命 / 有限资源），种子决定可复现的演化历史。点击"初始化行星"建立世界。',
    cta: { label: '初始化行星', action: 'create' },
  },
  5: {
    eyebrow: 'STEP 5 / EVOLVE',
    title: '在这颗行星上开始演化',
    body: '5a(行星演化 100 日)+ 5b(生命演化 1000 日)。先看行星本身的物理/化学演化,再追踪生命曲线;都满足后进入第 6 步"自由探索"。',
    cta: { label: '进入演化', action: 'play' },
  },
  6: {
    eyebrow: 'STEP 6 / EXPLORE',
    title: '自由探索',
    body: '所有 P1—P9 + P12—P17 实验都开放。推进 / 干预 / 对照 / 历史 / 化学 / 多细胞 / 智能 / 聚落 / 校准 / 批量。右侧"探索"栏会基于行星当前状态推荐下一步可以试什么。',
    cta: { label: '进入自由探索', action: 'play' },
  },
};
