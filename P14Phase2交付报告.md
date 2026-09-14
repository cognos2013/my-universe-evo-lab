# P14 phase 2 交付报告

**推进轮次**:第 11 轮
**工作目录**:`/Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/`
**原始目录**:`/Users/fuj2ee/Documents/ChatGPT/我的宇宙/`(未动)
**测试结果**:**138/138 通过**(从 135 + 3 新增)
**build**:通过

---

## Phase 2 范围

- **多任务**:3 种 P14 任务共享同一套 Action / Policy / Q-learning 实现,只换 reward shaping
- **多智能体**:projection 携带 per-lineage rollup,UI 显示每个 lineage 的 agent 数 / 平均 reward / Q-table 大小
- **UI 接入**:新 `cognition-dialog`,左侧控制(任务 / 策略 / ε / 加载 / 步进)+ 右侧累计状态 + 按谱系 rollup

---

## 落地清单

| # | 改动 | 位置 |
|---|---|---|
| 1 | `TaskKind = 'foraging' \| 'thermoregulation' \| 'aggregation'` + `ALL_TASK_KINDS` | `src/simulation/cognition/agent.ts` |
| 2 | `CognitiveAgent.taskKind` 字段 + `makeCognitiveAgent` 接受 taskKind 参数 | `src/simulation/cognition/agent.ts` |
| 3 | `applyAction` 重写 reward shaping,按 `agent.taskKind` 分支 | `src/simulation/cognition/agent.ts` |
| 4 | `stepCognitiveRegistry` 接受 `siblings: CognitiveAgent[]`(默认 = registry.agents),让 aggregation 跨 agent 通信 | `src/simulation/cognition/policy.ts` |
| 5 | `cognitionLoad` payload 接受 `task: TaskKind` + 校验 | `src/workers/controller.ts` |
| 6 | `cognition` reply + projection 携带 `taskKind` | `src/workers/controller.ts` |
| 7 | `Projection.cognition.byLineage[]` 包含 lineageId / agents / avgReward / totalQEntries | `src/workers/controller.ts` |
| 8 | UI 入口按钮 "智能行为实验 →" | `index.html` (cosmos-controls) |
| 9 | `cognition-dialog`:左侧控制(任务/策略/ε/加载/步进)+ 右侧累计 + 按谱系 | `index.html` |
| 10 | `cognition-dialog` 样式 | `src/app/style.css` |
| 11 | `mountCognition` UI 模块:接收 projection snapshot 渲染累计 + 谱系 | `src/app/cognition.ts`(新文件) |
| 12 | main.ts 挂载 + projection 推送 | `src/app/main.ts` |
| 13 | 3 个新集成测试:task 切换 / 错误 task+policy / aggregation | `tests/p12p13-integration.test.ts` |

---

## 三个任务(reward shaping)

| Task | 目标 | Reward |
|---|---|---|
| `foraging` | 落全局最富 cell | +50(命中),0(其他) |
| `thermoregulation` | 贴近 290 K | 50 × max(0, 1 − \|T−290\|/30) |
| `aggregation` | 邻居有同 lineage agent | 10 × 同 lineage 邻居数 |

**Q-learning 算法不变**,只换 reward 就能产出 3 种不同最优策略 — P14 验收门("未在环境任务上优于基线"门槛)适用于每个任务。

---

## UI 流程

1. **打开** 主界面点 "智能行为实验 →" 按钮
2. **选择** 任务(foraging/thermoregulation/aggregation)+ 策略(q-learning/random)+ ε
3. **加载** → `cognitionLoad` → 显示 "已加载 N 个 agents"
4. **手动推进** → `cognitionStep` 单步,看累计 reward / cognition J / episode
5. **关闭** dialog,点主界面 "▶ 开始演化" — P14 跟着主 tick 自动学(silent 模式,事件流干净)
6. **重新打开** dialog — 看累计状态 + 按谱系 rollup(对比每个 lineage 学习进度)

---

## 关键设计点

### 1. Task-agnostic Q-learning

Q-learning 算法与 task 解耦,只读 `(state, action) → Q` 表。换 task 不需要重训(从冷启动重新开始,但代码路径不变)。这让 P14 的"3 任务 + 2 策略 = 6 组合"测试矩阵变成纯参数化。

### 2. Aggregation 通过 siblings 列表通信

aggregation 任务需要知道"邻居 cell 上其他 agent 的 lineageId"。`stepCognitiveRegistry` 接受 `siblings: CognitiveAgent[]` 参数,默认 = `registry.agents`。这样多智能体社交可视化能工作,且单元测试可以传自定义 siblings 模拟"无邻居"等场景。

### 3. per-lineage rollup 在 projection 层

`Projection.cognition.byLineage` 是 controller 在 publish 时即时计算的(从 `registry.agents` 按 lineageId group),不是单独字段。代价 = 每次 publish 多一次 O(n) 遍历,但 agent 数 < 10k 都没问题。

### 4. 严格 task 校验

`cognitionLoad` 对 task 和 policy 字符串都做 whitelist 校验(失败 → error reply)。这防止 UI 输入错误悄悄 fallback 到默认值,符合 docs/15 P14 "不靠语言模型叙述,只靠可执行验证" 的原则。

---

## 测试矩阵

| 测试 | 验证 |
|---|---|
| `cognitionLoad with task: projection carries the taskKind + per-lineage rollup` | task 切换 + byLineage 字段 |
| `cognitionLoad rejects unknown task and unknown policy` | 错误输入走 error reply |
| `aggregation task: per-lineage rollup reports shared reward when agents cluster` | aggregation 任务 + 多 agent rollup |
| (上轮) `Q-learning beats random on the foraging task` | P14 验收门(主) |

---

## 下一步候选

| # | 方向 |
|---|---|
| **F** | 战略 D 4 项你拍板 |
| **G** | 11 轮改动汇总提 PR(25 commit) |
| **D** | MIST 96 MB 数据接入(P10-C 闭环) |
| **E2** | P15 聚落与文明(更大工程,启动 phase 1) |
| **P14-3** | 真实学习曲线 UI(画 Q-table 平均 Q 随 episode 变化 + reward 趋势图) |

P14 phase 1+2 已就绪:**3 任务 + 2 策略 + 多 agent rollup + UI**。要继续推 P15 还是做其他?
