/**
 * Explore page — 5-step plan panel + context-driven recommendations.
 *
 * Phase 2 of the UX rebuild: replace the 6 hidden `dialog` panels
 * (chemistry, colonies, cognition, settlement, earth, batch)
 * with a right-anchored "explore" sidebar that tells the user
 * "you have X, try Y next", and a main stage where the active
 * explore panel renders. The V14 visual route keeps its own
 * dialog because it's a fundamentally different surface (3D
 * canvas + Three.js); it's listed in the sidebar but clicking
 * it still opens the dialog.
 *
 * The state machine is *derived* from `Projection` — there is
 * no separate "explore state" to persist. The current active
 * panel (which one is showing) is held in module-local state
 * and resets to the recommendation whenever the underlying
 * context changes (e.g. the user just loaded chemistry, the
 * recommendation moves to colonies).
 */

import type { Projection } from '../workers/controller.ts';

/**
 * The 11 explore panels we expose. Phase 3 absorbed the 3
 * "external" dialogs (cosmos / galaxy / v14) into the same
 * explore-stage; Phase 7—8 absorbed history-dialog and
 * branch-dialog, completing the unification. The only
 * remaining `<dialog>` elements are knowledge surfaces
 * (history isn't really one, but it lives with the rest).
 */
export type ExplorePanelId =
  | 'cosmos'       // Step 1 — ΛCDM 简化背景
  | 'galaxy'       // Step 2 — 8 个气体晕
  | 'v14'          // Step 3 — 3D 视觉实验
  | 'chemistry'    // P12 reaction network
  | 'colonies'     // P13 colonial organisms
  | 'cognition'    // P14 cognitive agents
  | 'settlement'   // P15 settlements
  | 'earth'        // P16 Earth-data calibration
  | 'batch'        // P17 multi-seed batch
  | 'history'      // 宇宙年表(知识导览)
  | 'branch';      // 干预与分支

export const ALL_EXPLORE_PANELS: readonly ExplorePanelId[] = [
  'cosmos', 'galaxy', 'v14', 'chemistry', 'colonies', 'cognition',
  'settlement', 'earth', 'batch', 'history', 'branch',
] as const;

interface PanelMeta {
  id: ExplorePanelId;
  eyebrow: string;
  title: string;
  /** One-line description used in the sidebar. */
  blurb: string;
  /** Predicate that says "this panel is loaded and has data". */
  isLoaded: (proj: Projection) => boolean;
  /** Optional priority bump when nothing else is loaded
   *  (i.e. "this is the first thing to try on a brand-new
   *  world"). Lower numbers win. */
  coldStartRank: number;
  /** One-line next-step hint shown in the recommendation card. */
  hintIfMissing: string;
  hintIfLoaded: string;
}

export const PANEL_META: Record<ExplorePanelId, PanelMeta> = {
  cosmos: {
    id: 'cosmos',
    eyebrow: 'STEP 1 / COSMOS',
    title: '宇宙背景',
    blurb: 'ΛCDM 简化背景 · H₀/Ωm/ΩΛ · 138 亿年尺度',
    isLoaded: () => true,
    coldStartRank: 0,
    hintIfMissing: '从 ΛCDM 简化背景开始 · 推进 138 亿年尺度观察大尺度结构',
    hintIfLoaded: '已打开 — 推进几亿年观察 H / 尺度因子演化',
  },
  galaxy: {
    id: 'galaxy',
    eyebrow: 'STEP 2 / GALAXY',
    title: '星系与恒星',
    blurb: '8 个预置气体晕 · 引力装配 · 第一代恒星群',
    // `galaxy` is a step-2 entry point — the 8 halos are
    // preloaded, so the panel is always "available" from the
    // sidebar's perspective. The actual `book.astronomy` is
    // initialised lazily on first `galaxiesAdvance` call.
    isLoaded: () => true,
    coldStartRank: 0,
    hintIfMissing: '从一片气体云开始 · 看坍缩 + 第一代恒星',
    hintIfLoaded: '已加载 — 前进 1 亿年观察装配,或启用引力合并',
  },
  v14: {
    id: 'v14',
    eyebrow: 'STEP 3 / VISUAL',
    title: '3D 视觉实验',
    blurb: '程序化 5 种 3D 模型 · 快照 / 对比 / 批量',
    isLoaded: (p) => p.v14.snapshots.length > 0,
    coldStartRank: 4,
    hintIfMissing: '看完 P12—P17 后生成一张 3D 快照作纪念',
    hintIfLoaded: '已有快照 — 选两条进入对比模式',
  },
  chemistry: {
    id: 'chemistry',
    eyebrow: 'P12 / REACTION NETWORK',
    title: '化学反应网络',
    blurb: '用 in-repo 合成 GARD / Markov 网络做生命前化学实验',
    isLoaded: (p) => p.chemistry !== null,
    coldStartRank: 3,
    hintIfMissing: '行星初始化后没有化学实验 · 试个 raw 网络看第一代反应',
    hintIfLoaded: '已加载 — 推进 1 步看反应进展,或换 GARD / Markov 网络',
  },
  colonies: {
    id: 'colonies',
    eyebrow: 'P13 / COLONIAL ORGANISMS',
    title: '多细胞聚落',
    blurb: '同区域同形状的多个队列组成新选择单元',
    isLoaded: (p) => p.colonies !== null,
    coldStartRank: 4,
    hintIfMissing: '化学实验跑几轮后,看队列是否组成聚落',
    hintIfLoaded: '已加载 — 看聚落规模 / 维护费 / 分裂事件',
  },
  cognition: {
    id: 'cognition',
    eyebrow: 'P14 / COGNITIVE AGENTS',
    title: '智能行为',
    blurb: 'Q-learning 智能体在觅食 / 避热 / 社交三任务中学习',
    isLoaded: (p) => p.cognition !== null,
    coldStartRank: 5,
    hintIfMissing: '聚落稳定后,试试 P14 — 给 agent 3 个任务做对照',
    hintIfLoaded: '已加载 — 对比 q-learning vs random 基线',
  },
  settlement: {
    id: 'settlement',
    eyebrow: 'P15 / CIVILISATIONS',
    title: '聚落与文明',
    blurb: '生产 / 消费 / 知识 / 制度 / 技术 / 联盟 / 冲突',
    isLoaded: (p) => p.settlement !== null,
    coldStartRank: 1,
    hintIfMissing: '先建几个聚落,再观察制度 / 技术 / 联盟 / 冲突',
    hintIfLoaded: '已加载 — 推进看平均寿命 vs 制度 baseline,或 📷 生成 3D 天际线',
  },
  earth: {
    id: 'earth',
    eyebrow: 'P16 / REAL-EARTH DATA',
    title: '地球校准',
    blurb: '用真实地球数据校准模型(目前 ship 合成 Holocene 曲线)',
    isLoaded: (p) => p.earthData !== null,
    coldStartRank: 6,
    hintIfMissing: '载入合成 Holocene 数据 + 跑校准看 RMSE vs 透明基线',
    hintIfLoaded: '已加载 — 换 baseline(常量 / 趋势 / 持续性)看是否胜出',
  },
  batch: {
    id: 'batch',
    eyebrow: 'P17 / SCENARIO BATCHES',
    title: '多种子批量',
    blurb: '跨多 seed 跑同一场景,看种群 / 温度 / 谱系数分布',
    isLoaded: (p) => p.batches.length > 0,
    coldStartRank: 2,
    hintIfMissing: '想做严格可信的统计 · 跑 4—16 个 seed 看分布',
    hintIfLoaded: '已加载 — 看 per-seed 结果 + p5 / p50 / p95 区间',
  },
  history: {
    id: 'history',
    eyebrow: 'KNOWLEDGE / COSMIC CHRONICLE',
    title: '宇宙年表',
    blurb: '从宇宙开端到未定未来 · 8 个时期知识导览',
    // History is always available — it's read-only knowledge,
    // no controller state required.
    isLoaded: () => true,
    coldStartRank: 0,
    hintIfMissing: '打开 8 个宇宙历史时期阅读',
    hintIfLoaded: '已加载 — 选左侧时期看详情',
  },
  branch: {
    id: 'branch',
    eyebrow: 'LAB / PARALLEL HISTORIES',
    title: '干预与分支',
    blurb: '复制当前世界 / 改一个条件 / 对照两条历史',
    // The branch lab is always available (a fresh world has
    // only the main branch but the controls are present).
    isLoaded: () => true,
    coldStartRank: 0,
    hintIfMissing: '复制当前世界开始对照 · 改一个条件看 B − A',
    hintIfLoaded: '已加载 — 干预 / 对照 / 复制分支',
  },
};

/** Snapshot of the explore sidebar state, derived from a `Projection`. */
export interface ExploreState {
  /** Currently active panel on the stage. */
  active: ExplorePanelId;
  /** Per-panel loaded/missing state. */
  loaded: Record<ExplorePanelId, boolean>;
  /** Sorted recommendation list, most-urgent first. */
  recommendations: ExplorePanelId[];
  /** Headline one-liner for the recommendation card. */
  topReason: string;
}

/** Pick the "next" panel based on loaded state + cold-start
 *  ranks. Strategy: first recommend the highest-ranked missing
 *  panel; if everything is loaded, recommend the lowest-ranked
 *  loaded panel (encourages re-running with a different
 *  parameter set, e.g. new GARD / Markov network).
 *
 *  `cosmos` and `galaxy` are the step-1 / step-2 entry points
 *  — they're "always loaded" (cold-start rank 0, `isLoaded`
 *  returns true without any controller state), so they never
 *  surface as the top recommendation. They're listed in the
 *  sidebar so the user can re-visit them, but the recommendation
 *  flow always steers toward a P12—P17 experiment first. */
export function recommendExploration(proj: Projection): ExplorePanelId {
  const missing = ALL_EXPLORE_PANELS
    .map((id) => PANEL_META[id])
    .filter((m) => !m.isLoaded(proj))
    .sort((a, b) => a.coldStartRank - b.coldStartRank);
  if (missing.length > 0) return missing[0]!.id;
  // Everything loaded — keep exploring the same panel so the
  // UI doesn't jump around. The user can pick another.
  return 'chemistry';
}

/** Build the full explore state for a projection. */
export function buildExploreState(proj: Projection, current: ExplorePanelId): ExploreState {
  const loaded: Record<ExplorePanelId, boolean> = {
    cosmos: PANEL_META.cosmos.isLoaded(proj),
    galaxy: PANEL_META.galaxy.isLoaded(proj),
    v14: PANEL_META.v14.isLoaded(proj),
    chemistry: PANEL_META.chemistry.isLoaded(proj),
    colonies: PANEL_META.colonies.isLoaded(proj),
    cognition: PANEL_META.cognition.isLoaded(proj),
    settlement: PANEL_META.settlement.isLoaded(proj),
    earth: PANEL_META.earth.isLoaded(proj),
    batch: PANEL_META.batch.isLoaded(proj),
    history: PANEL_META.history.isLoaded(proj),
    branch: PANEL_META.branch.isLoaded(proj),
  };
  const rec = recommendExploration(proj);
  const recMeta = PANEL_META[rec];
  const allLoaded = ALL_EXPLORE_PANELS.every((id) => loaded[id]);
  const topReason = allLoaded
    ? '所有实验都已加载 · 可以重跑不同参数或进入 V14 视觉实验'
    : loaded[rec]
      ? recMeta.hintIfLoaded
      : recMeta.hintIfMissing;
  // Recommendation list: missing first (sorted by cold-start
  // rank), then loaded (in panel order, no specific priority).
  const recommendations: ExplorePanelId[] = [
    ...ALL_EXPLORE_PANELS
      .map((id) => PANEL_META[id])
      .filter((m) => !m.isLoaded(proj))
      .sort((a, b) => a.coldStartRank - b.coldStartRank)
      .map((m) => m.id),
    ...ALL_EXPLORE_PANELS.filter((id) => loaded[id]),
  ];
  return { active: current, loaded, recommendations, topReason };
}

/** Pure helper: the recommendation's meta, used by the UI
 *  when the user clicks the recommendation. */
export function topRecommendationMeta(state: ExploreState): PanelMeta | null {
  const id = state.recommendations[0];
  if (!id) return null;
  return PANEL_META[id];
}
