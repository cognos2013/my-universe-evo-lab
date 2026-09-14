import type { ModelCard, Scenario } from '../simulation/core/contracts.ts';
import * as v from '../simulation/core/validation.ts';

export const modelCards: readonly ModelCard[] = [
  {
    id: 'environment-energy-v1', version: '1.0.0', title: '简化能量平衡与地表网格',
    status: 'implemented', evidence: 'authored',
    assumptions: ['输入辐射与有效反照率、发射率控制温度；相邻单元交换能量。', '固定地形，无天气与板块运动。'],
    validRange: ['设计参数域：150—400 K；参数域校验不等于物理稳定性保证。'],
    limitations: ['已实现温度方程、子步与基础收敛检验，仍不是完整气候模型。', '不能用于真实气候预测。'],
    sources: ['docs/02-详细设计.md §6'],
  },
  {
    id: 'matter-ledger-v1', version: '1.0.0', title: '单一模型物质账',
    status: 'contract', evidence: 'authored',
    assumptions: ['MU 在营养、生物结构和碎屑间转移；投入移除须记录。', '每个个体结构 MU 相同。'],
    validRange: ['所有物质池非负；MU 不对应真实元素质量。'],
    limitations: ['未表示碳氮磷化学计量；同时检查静态与推进收支。'],
    sources: ['docs/02-详细设计.md §5.3、§6.3'],
  },
  {
    id: 'cohort-evolution-v1', version: '1.0.0', title: '无性队列性状演化',
    status: 'implemented', evidence: 'authored',
    assumptions: ['同区域同基因型合并，数量为整数；性状空间由设计给定。', '繁殖消耗物质和能量，突变不定向。'],
    validRange: ['最适温度 150—400 K，耐受宽度 0.1—100 K。'],
    limitations: ['已实现性状演化；不包含生命起源、多细胞或智能。', '队列不记录独立个体记忆；谱系不等同于物种。'],
    sources: ['docs/02-详细设计.md §7', 'https://darwin-online.org.uk/converted/pdf/1860_Origin_F379.pdf'],
  },
  {
    id: 'determinism-v1', version: '1.0.0', title: '种子与随机通道协议',
    status: 'contract', evidence: 'authored',
    assumptions: ['SHA-256 从种子、通道、实体、tick 派生 xoshiro128** 的 128 位状态。', 'branchId 与镜头不进入随机坐标；固定版本固定环境重放。'],
    validRange: ['非负安全整数 tick；四个 uint32 随机状态字不能全零。'],
    limitations: ['随机源不用于密码学；跨平台浮点方程不承诺逐位一致。', '逐事件 SHA-256 的成本尚待 P1 基准，不改变协议的前提下可以缓存。'],
    sources: ['docs/03-P0-实施记录.md', 'https://prng.di.unimi.it/xoshiro128starstar.c'],
  },
  {
    id: 'authored-scenario-v1', version: '1.0.0', title: '人工生态实验场景',
    status: 'contract', evidence: 'authored',
    assumptions: ['初始生命由人工播种；模板参数用于机制验证。'],
    validRange: ['320、1,280、5,120 或 20,480 地表单元；首版仅自由模式。'],
    limitations: ['不是历史地球快照，不保证出现生命复杂化或文明。', '网格构建与当地资源充分性在初始化时验证。'],
    sources: ['docs/02-详细设计.md §1、§2'],
  },
  {
    // P10-C: IMF-driven population bins, but lifetime / returned / luminosity
    // remain teaching approximations keyed to the IMF segment midpoints.
    // MIST or PARSEC tracks have not been downloaded or validated yet; this
    // card advertises that boundary so the P10-C exit gate (no forbidden
    // scientific claims until the proxy is replaced) stays open.
    id: 'stellar-imf-v1', version: '1.0.0', title: '银河场 IMF 驱动的恒星群分箱',
    status: 'implemented', evidence: 'authored',
    assumptions: [
      'Kroupa 2001 银河场 IMF 解析积分（0.08—0.5 斜率 1.3，0.5—100 斜率 2.3）。',
      '银河场 IMF，非原初恒星 IMF；低金属丰度下两者可能不一致。',
      '寿命 / 回流 / 光度用段中位数的教学近似值，不是 MIST / PARSEC 校准轨道。',
    ],
    validRange: ['单段质量分数 0 < f ≤ 1；总质量分数和 = 1（数值积分 1e-14 内）。', '质量分箱边界必须严格递增并覆盖 0.08—100 M☉。'],
    limitations: [
      '不包含元素产额、恒星风、反馈、超新星能量注入。',
      '不区分金属丰度演化；所有恒星群用同一组教学近似。',
      '银河场 IMF 跑零金属起点与天文观测不一致；P10-C 完成后此差异仍存在。',
    ],
    sources: [
      'https://arxiv.org/html/astro-ph/0009005v2',
      'src/simulation/cosmos/imf.ts',
      'src/simulation/cosmos/galaxies.ts',
    ],
  },
];

export function validateModelCard(input: unknown): asserts input is ModelCard {
  const c = v.object(input, ['id', 'version', 'title', 'status', 'evidence', 'assumptions', 'validRange', 'limitations', 'sources'], 'modelCard');
  v.id(c.id, 'modelCard.id'); v.choice(c.version, ['1.0.0'], 'modelCard.version'); v.text(c.title, 'modelCard.title');
  v.choice(c.status, ['contract', 'planned', 'implemented'], 'modelCard.status'); v.choice(c.evidence, ['authored'], 'modelCard.evidence');
  for (const key of ['assumptions', 'validRange', 'limitations', 'sources']) {
    const items = v.array(c[key], `modelCard.${key}`);
    if (!items.length) v.fail(`modelCard.${key}`, 'cannot be empty');
    items.forEach((x, i) => v.text(x, `modelCard.${key}[${i}]`));
  }
}

export function validateModelCoverage(scenario: Scenario): void {
  modelCards.forEach(validateModelCard);
  v.unique(modelCards.map(c => c.id), 'modelCards');
  const all = new Set(modelCards.map(c => c.id));
  const refs = new Set([...scenario.modelCardIds, ...scenario.rules.modelCardIds]);
  for (const ref of refs) if (!all.has(ref)) v.fail('modelCardIds', `unknown model card ${ref}`);
  for (const required of ['environment-energy-v1', 'matter-ledger-v1', 'cohort-evolution-v1', 'determinism-v1', 'authored-scenario-v1']) {
    if (!refs.has(required)) v.fail('modelCardIds', `missing model card ${required}`);
  }
}
