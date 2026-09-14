# P15-3 + P16 phase 1 交付报告

**推进轮次**:第 14 轮
**工作目录**:`/Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/`
**原始目录**:`/Users/fuj2ee/Documents/ChatGPT/我的宇宙/`(未动)
**测试结果**:**154/154 通过**(从 146 + 8 新增)
**build**:通过
**dev server**:**http://localhost:9151/**(后台运行 task `bg_de8c0351-...`)

---

## 本轮关键交付

### 1. P15-3 phase 3:制度规则扩展

| 维度 | 内容 |
|---|---|
| **冲突 (`ConflictEdge`)** | 每 step 概率触发,双方扣 `casualtyFraction × pop` + `damageFood`(食物销毁,不是转出);population < 1 触发 dissolve |
| **联盟 (`CoalitionEdge`)** | 无条件共享,每 step 上限 `ratePerStep` 转出(无 deficit 门) — "风险共担" |
| **制度演化** | 默认规则 `popAbove: 80 → public` / `popBelow: 15 → private`,每 step 评估,触发自动转换 |

### 2. P16 phase 1:现实地球数据 + 校准

| 维度 | 内容 |
|---|---|
| **`EarthDataPoint`** | (tickDays, temperatureK, seaLevelM, co2ppm, iceCoverageFrac, source, measured) — source 必填,缺测标记 |
| **`EarthDataSeries`** | 排序 + 校验:全 series 必须同 source,否则 throw |
| **`CalibrationConfig`** | trainFraction ∈ [0.5, 0.95] + baseline ∈ {constant-mean, linear-trend, persistence} + quantity |
| **`CalibrationReport`** | calibratedRMSE/MAE vs baselineRMSE/MAE + `beatsBaseline: boolean` |
| **内嵌合成数据** | `syntheticHoloceneSeries()` — 10 000 年 × 1 年分辨率,标注"synthetic-Holocene-placeholder"避免冒充观测 |
| **验收门** | tracking model RMSE < constant-mean baseline RMSE |

### 3. UI 接入

- `settlement-dialog` 加 2 个新 checkbox:全连接联盟 / 全连接冲突
- 新 `earth-dialog`:左侧加载 sample + 校准控件(train 比例/baseline/quantity),右侧累计状态(数据源/点数/区间/缺测/RMSE 对比/是否胜出)
- main.ts 挂载 `mountEarth` + 投影推送

---

## 落地清单

| # | 改动 | 位置 |
|---|---|---|
| 1 | `ConflictEdge` / `CoalitionEdge` / `InstitutionEvolutionRule` 接口 | `src/simulation/settlement/types.ts` |
| 2 | `SettlementRegistry` 加 conflicts / coalitions / institutionRule 字段 + 累计 counter | `src/simulation/settlement/types.ts` |
| 3 | `SettlementTemplate` 加 `conflictTo` / `coalitionTo` 字段 | `src/simulation/settlement/types.ts` |
| 4 | `validateSettlement` 校验 institution + technology 字段 | `src/simulation/settlement/types.ts` |
| 5 | `stepSettlements` 加 coalition 步 + conflict 步 + 制度演化步,接受 `rng` 参数 | `src/simulation/settlement/simulate.ts` |
| 6 | `seedSettlements` resolve `conflictTo` / `coalitionTo` 标签到 id | `src/simulation/settlement/simulate.ts` |
| 7 | `handleSettlementLoad` 接受 coalition/conflict 模板 + 严格校验 | `src/workers/controller.ts` |
| 8 | `Projection.settlement` 加 phase 3 累计字段(coalitions / casualties / lost / destroyed / transitions) | `src/workers/controller.ts` |
| 9 | `EarthDataPoint` / `EarthDataSeries` / `CalibrationConfig` / `CalibrationReport` / `loadEarthData()` | `src/simulation/earth/types.ts` |
| 10 | `compareToEarth` 实现(train/holdout split + 3 baselines + linear interpolation) | `src/simulation/earth/compare.ts` |
| 11 | `syntheticHoloceneSeries` 内嵌数据 + 真实 Holocene 形状(早暖/中冷/晚暖) | `src/simulation/earth/sample.ts` |
| 12 | `handleEarthDataLoad` / `handleEarthDataCompare` + `__InternalHandlerContext.setEarthCalibration` mutator | `src/workers/controller.ts` |
| 13 | `Projection.earthData` 含 calibration report | `src/workers/controller.ts` |
| 14 | `ExperimentBook.earthData?: EarthDataSeries` 字段 + import/export 路由 + checksum 不变 | `src/experiments/book.ts` |
| 15 | `settlement-dialog` 加 联盟/冲突 控件 | `index.html` + `src/app/settlement.ts` |
| 16 | 新 `earth-dialog` + `.earth-dialog` / `.earth-layout` 样式 | `index.html` + `src/app/style.css` |
| 17 | `mountEarth` UI 模块 + main.ts 挂载 + projection 推送 | `src/app/earth.ts`(新)+ `src/app/main.ts` |
| 18 | 8 个新测试:P15-3 冲突/联盟/制度演化 + P16 加载/拒绝/校准门/控制器集成 | `tests/p15p16.test.ts`(新) |
| 19 | handlers.test mock 加 `setEarthCalibration` no-op | `tests/handlers.test.ts` |

---

## 关键设计点

### 1. P15-3 冲突 vs 联盟 对称

冲突:破坏性,扣 population + 销毁 food(`damageFood` 不转为另一方)
联盟:建设性,无条件共享(rate 上限)

两者**配对**:`runExchanges` 步处理联盟转移,`runConflicts` 步独立处理(双方都扣)。如果两个聚落既有联盟又有冲突 → 联盟 + 冲突同时发生(罕见但合法)。

### 2. 制度演化基于人口阈值

默认 `popAbove: 80 → public`(人口足够大时自然形成国家),`popBelow: 15 → private`(人口衰退时制度崩溃回私有)。这是**涌现式**制度变化,不是用户手动切换。

### 3. P16 数据契约:source 必填

每个 `EarthDataPoint` 必须有 `source` 字符串,整条 series 必须同 source。否则 `loadEarthData` 抛 `all points in a series must share a single source citation`。这是 docs/15 P16 "固定数据来源" 的工程化实现 — 防止把不同来源混成一条 series。

### 4. baseline 三选一,rmse/mae 双指标

- `constant-mean`:train 段均值预测 holdout
- `persistence`:train 末值预测 holdout
- `linear-trend`:train 段最小二乘线性拟合

`CalibrationReport` 同时报 RMSE 和 MAE,`beatsBaseline = calibratedRMSE < baselineRMSE`。Phase 1 用 RMSE,因为它是 P16 验收门槛"优于透明基线"的标准指标。

### 5. `Math.pow` 替代 `**` 防止优先级陷阱

**踩坑**:`Math.exp(-x ** 2)` 在 JS 中被解析为 `Math.exp(-(x ** 2))`,没问题。但 `Math.exp((-((years - 1500) / 1500)) ** 2)`(带外层括号)实际等价于 `Math.exp((-(...)/1500) ** 2) = Math.exp((.../1500) ** 2)`(平方后符号丢失) — 变成**正指数**!

TypeScript 不报警(语法正确),runtime 给出完全错的曲线。**修法**:统一用 `Math.exp(-Math.pow(x, 2))`,无歧义。

### 6. controller 实例 vs ctx 闭包

Calibration report 需要**持**在 controller(以便下次 projection publish),但 handler 通过 `ctx` 拿不到 controller 私有字段。修法:加 `__InternalHandlerContext.setEarthCalibration` mutator,handler 调它写到 controller 实例。

---

## 测试矩阵(8 个新测试)

| 测试 | 验证 |
|---|---|
| `P15-3: coalition chain softens shocks` | 联盟 cohort 有 transferred food,no-coalition cohort 0 |
| `P15-3: conflict inflicts population + food damage on both sides` | 触发冲突后 totalCasualtyEvents ≥ 1,population ↓ |
| `P15-3: institutional evolution upgrades big settlement to public` | 人口 50 触犯 popAbove=30 → institution.kind = 'public' |
| `P15-3 controller: settlementLoad with conflict + coalition edges` | projection.coalitions = 1, conflicts = 1 |
| `P16: loadEarthData parses a valid series and rejects inconsistent citations` | 一致 citation 通过;不一致 throw |
| `P16: compareToEarth — a tracking model beats constant-mean` | tracking model RMSE < baseline RMSE |
| `P16: compareToEarth — a clearly-wrong model loses to constant-mean baseline` | 0 K flat 输 baseline |
| `P16 controller: earthDataLoad + earthDataCompare produce beatsBaseline on projection` | projection.earthData.calibration.beatsBaseline = true |

---

## dev server 状态

```bash
cd /Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙
npx vite --port 9151 --host 0.0.0.0
# Local:   http://localhost:9151/
# Network: http://192.168.3.43:9151/
```

后台 task `bg_de8c0351-...`,HTTP 200,所有 5 个 dialog 加载(cosmos/galaxy/prebiotic/cognition/settlement/earth)。

---

## 测试路径

1. 打开 http://localhost:9151/
2. 建一个新世界
3. 点 "聚落与文明 →"
4. 启用"全连接互助" + "全连接联盟" + "全连接冲突",生成 3 个聚落
5. 推进几步,看 bySettlement 中 institution 演化(大聚落 public,小聚落 private)
6. 关闭 settlement dialog
7. 点 "地球校准 →"
8. 载入合成 Holocene 数据 → 看到 10 000 个点,缺测 0
9. 选 `constant-mean` baseline + 温度量,点校准 → 看到 calibratedRMSE < baselineRMSE,胜出 ✓
10. 切 `linear-trend` / `persistence` baseline 重测,对比 RMSE

---

## 累计 14 轮一览

P0 基础 → B3 拆 handlers → P0-4 IMF → P10-C → P10C-P11 → P12-P13 → 集成 → UI 接入 → P14 phase 1 → P14 phase 2 → P15 phase 1 → P15 phase 2 (制度/技术/交换) → **P15-3 (冲突/联盟/制度演化)** + **P16 (Earth data 校准)**。

docs/15 P12 / P13 / P14 / P15 / P16 全部 phase 1 落地。

---

## 下一步候选

| # | 方向 |
|---|---|
| **F** | 战略 D 4 项你拍板 |
| **G** | 14 轮改动汇总提 PR(40 commit) |
| **D** | MIST 96 MB 数据接入(P10-C 闭环) |
| **P17** | 未来情景集合(多种子批量 + 失败统计 + 结果分布) |
| **V** | 14 视觉路线(World Labs / Marble) |

P12-P16 都已 phase 1。下一步看你优先级。

请选下一步。
