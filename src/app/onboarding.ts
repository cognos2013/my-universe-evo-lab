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

export type OnboardingStep = 1 | 2 | 3 | 4 | 5;

export const ALL_ONBOARDING_STEPS: readonly OnboardingStep[] = [1, 2, 3, 4, 5] as const;

export interface OnboardingState {
  /** Current step (1—5). The progress bar highlights this dot. */
  step: OnboardingStep;
  /** Set of step numbers the user has already passed. Once
   *  step N is reached, all steps 1—N are marked completed so
   *  the user can freely click back. */
  completedSteps: OnboardingStep[];
  /** When the user finished step 5 for the first time. We
   *  show the wizard again on every cold start until this is
   *  set, so a brand-new user always lands on step 1. */
  finishedAtMs: number | null;
}

export const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  step: 1,
  completedSteps: [],
  finishedAtMs: null,
};

const STORAGE_KEY = 'my-universe-onboarding-v1';

function isStep(n: unknown): n is OnboardingStep {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5;
}

function sanitise(raw: unknown): OnboardingState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ONBOARDING_STATE };
  const o = raw as Record<string, unknown>;
  const step = isStep(o.step) ? o.step : 1;
  const completed = Array.isArray(o.completedSteps)
    ? (o.completedSteps.filter(isStep) as OnboardingStep[])
    : [];
  const finishedAtMs = typeof o.finishedAtMs === 'number' ? o.finishedAtMs : null;
  return { step, completedSteps: completed, finishedAtMs };
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
    completedSteps: [...completed].sort((a, b) => a - b),
    finishedAtMs: state.finishedAtMs,
  };
  if (step === 5) {
    next.finishedAtMs = state.finishedAtMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }
  return next;
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
    body: '所有 P1—P9 + P12—P17 实验都在这里。推进 / 干预 / 对照 / 历史 / 化学 / 多细胞 / 智能 / 聚落 / 校准 / 批量。下面的右侧"探索"栏会基于行星当前状态推荐下一步可以试什么。',
    cta: { label: '进入演化', action: 'play' },
  },
};
