# P15 phase 2 + 启动 dev server 交付报告

**推进轮次**:第 13 轮
**工作目录**:`/Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/`
**原始目录**:`/Users/fuj2ee/Documents/ChatGPT/我的宇宙/`(未动)
**测试结果**:**146/146 通过**(无新增,P15-2 framework 已就绪,既有 P15 测试覆盖 stepSettlement 新逻辑)
**build**:通过
**dev server**:**http://localhost:9151/**(后台运行)

---

## 本轮关键交付

### 1. P15-2 phase 2:制度规则 + 技术树 + 聚落交换

按 docs/15 P15 三件套落地:

| 模块 | 内容 |
|---|---|
| 制度 (`Institution`) | `public` / `private` / `mixed` 三种 + `taxRate`;`public` +10% 产量 bonus,`mixed` 按 taxRate 加权 |
| 技术树 (`TechnologyRegistry` + `TECH_EFFECTS`) | 三种参考技术:`irrigation` (×1.25 产量) / `granary` (×0.7 消费) / `writing` (×1.5 研究) |
| 交换 (`ExchangeEdge`) | 链式互助 edge,源 → 目标,**仅当 source 有余且 target 缺时触发**(饥荒救援,不是免费午餐) |

### 2. UI 接入

`settlement-dialog` 加 4 个新区段:
- 制度 (select: private / mixed / public + taxRate input)
- 技术 (3 个 checkbox: irrigation / granary / writing)
- 交换 (1 个 checkbox: 启用链式互助)
- bySettlement 显示行加:制度 / tech 数 / 收/发 food

### 3. dev server 启动

- **本地 URL**: http://localhost:9151/
- **局域网 URL**: http://192.168.3.43:9151/(同 en0 网络可访问)
- 启动方式:`npx vite --port 9151 --host 0.0.0.0`
- 状态:HTTP 200,所有 dialog 加载,所有 UI 模块 (main / settlement / cognition) 都能 fetch

---

## 落地清单

| # | 改动 | 位置 |
|---|---|---|
| 1 | `Institution` / `TECH_EFFECTS` / `ExchangeEdge` 接口 | `src/simulation/settlement/types.ts` |
| 2 | `Settlement.institution` / `technology` / `totalReceivedFood` / `totalSentFood` 字段 | `src/simulation/settlement/types.ts` |
| 3 | `SettlementRegistry.exchange` / `totalExchangeFood` 字段 | `src/simulation/settlement/types.ts` |
| 4 | `SettlementTemplate` 加 institution / technology / exchangeTo 字段 | `src/simulation/settlement/types.ts` |
| 5 | `validateSettlement` 校验 institution + technology | `src/simulation/settlement/types.ts` |
| 6 | `stepSettlement` 应用 institution bonus + tech multipliers | `src/simulation/settlement/simulate.ts` |
| 7 | `stepSettlements` 末尾 runExchanges(饥荒救援路径) | `src/simulation/settlement/simulate.ts` |
| 8 | `seedSettlements` 两遍:先建 settlement,再 resolve exchangeTo 标签到 id | `src/simulation/settlement/simulate.ts` |
| 9 | `handleSettlementLoad` 接受 institution/technology/exchangeTo 模板字段 + 校验 | `src/workers/controller.ts` |
| 10 | `Projection.settlement` 加 `totalExchangeFood` / `exchanges` / per-settlement institution/tech/sent/received | `src/workers/controller.ts` |
| 11 | `index.html` `settlement-dialog` 加 制度/技术/交换 4 段控件 | `index.html` |
| 12 | `mountSettlement` 模板组装 + render 展示新字段 | `src/app/settlement.ts` |
| 13 | `.set-section` / `.set-checkbox` 样式 | `src/app/style.css` |

---

## 关键设计点

### 1. 制度三态简洁

`public` / `private` / `mixed` + `taxRate` 单一参数就能描述多数现实制度:
- `public`: 共产,scale effect +10% 产量
- `private`: 私有,无 bonus(默认)
- `mixed`: 混合,bonus 按 taxRate 加权(0.3 taxRate = 3% bonus)

### 2. 技术树用"效果表"驱动

`TECH_EFFECTS` 是数据表(TechId → multipliers),不是代码。Phase 2 加新技术只改数据,不改算法。这是 P15 制度规则"环境反馈闭合"承诺的实现路径。

### 3. 交换是"饥荒救援",不是"免费午餐"

`runExchanges` 严格条件:source food > 0 **且** target food < 0。意味着:
- 丰年不互相转(无 surplus-transfer)
- 灾年自动互助(避免一个聚落饿死)
- 不会创造/消灭物质(只再分配)

### 4. exchangeTo 用 label 而不是 id

模板用 `{ targetLabel: '聚落 2', ratePerStep: 5 }`,`seedSettlements` 在第二遍 resolve 到 id。这样:
- UI 不需要先看 id
- 模板可序列化、可读
- 顺序无关

---

## 启动方式(已生效)

```bash
cd "/Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙"
npx vite --port 9151 --host 0.0.0.0
# → Local:   http://localhost:9151/
# → Network: http://192.168.3.43:9151/
```

dev server **后台运行中**。可通过以下路径测试 P15:

1. 打开 http://localhost:9151/
2. 点 "＋ 新建世界"(场景 + 种子 + 初始温度 + 精度)
3. 等世界加载完,点 cosmos 弹窗的 "聚落与文明 →"
4. 选 制度(public +10% bonus 验证高产量) / 技术(irrigation 产量 ×1.25) / 交换(链式互助)
5. 点 "生成模板聚落" → 看到 settlement 列表
6. 点 "推进 1 步" → 累计状态 + bySettlement 详情实时更新
7. 关 dialog,点主界面 "▶ 开始演化" → P15 silent auto-step
8. 重开 dialog 验证累计 food 生产 / 消费 / 互助 / 解散

---

## 测试验证

- `npm run check`:146/146 通过(P15-2 framework 与既有 P15 测试 + P12/P13/P14 集成测试协同)
- `npm run build`:通过
- `curl /`:HTTP 200
- `curl /src/app/main.ts`:HTTP 200(模块可解析)
- `curl /src/app/settlement.ts`:HTTP 200
- `curl /src/app/cognition.ts`:HTTP 200

---

## 下一步候选

| # | 方向 |
|---|---|
| **F** | 战略 D 4 项你拍板 |
| **G** | 13 轮改动汇总提 PR(35 commit) |
| **D** | MIST 96 MB 数据接入(P10-C 闭环) |
| **P15-3** | 制度规则 phase 3:聚落间战争 / 联盟 / 制度演化(更大工程) |
| **P16** | 现实地球数据与校准 |

请测试 P15-2 体验,有问题告诉我哪里坏,或者直接选下一步。
