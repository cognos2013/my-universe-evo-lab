# P12/P13 UI 接入 + auto-step 交付报告

**推进轮次**:第 9 轮(A + B + C 三件套合并)
**工作目录**:`/Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/`
**原始目录**:`/Users/fuj2ee/Documents/ChatGPT/我的宇宙/`(未动,mtime 与上轮一致)
**测试结果**:**127/127 通过**(从 123 + 4 新增)
**build**:通过(585.48 kB chunk 警告为既有问题,与本次改动无关)

---

## 落地清单

| # | 改动 | 位置 |
|---|---|---|
| 1 | `coloniesLoad` handler:扫描世界状态按 (cell, trait) 聚类形成殖民地 | `src/workers/controller.ts` |
| 2 | `chemistryStep` / `coloniesMaintain` 支持 `silent: true` 模式 | `src/workers/controller.ts` |
| 3 | `internalTick` 集成 silent auto-step:book 上有 chemistry / colonies 时,主 tick 自动推进 | `src/workers/controller.ts` |
| 4 | **Bug 修复**:`handleRun` 末尾调 `ctx.schedule(ctx.generation)` 启动 internalTick setTimeout 链(原项目 run 不推进 tick 的死链) | `src/workers/controller.ts` |
| 5 | `Projection` 加 `chemistry` / `colonies` 累计状态字段 | `src/workers/controller.ts` |
| 6 | UI 入口按钮 "化学与聚落实验 →" | `index.html` (cosmos-controls 块) |
| 7 | 新 dialog `prebiotic-dialog`:P12 反应网络 + P13 聚落两栏布局 | `index.html` |
| 8 | prebiotic 面板样式(网格两栏 + form + 列表) | `src/app/style.css` |
| 9 | `mountPrebiotic` 模块:加载/推进/自动状态展示,接收 projection snapshot | `src/app/prebiotic.ts`(新文件) |
| 10 | main.ts 挂载:projection 推送 → 渲染;按钮绑 dialog | `src/app/main.ts` |
| 11 | 4 个端到端测试:coloniesLoad / silent chem / silent col / auto-step 联调 | `tests/p12p13-integration.test.ts` |

---

## 关键设计点

### 1. `coloniesLoad` — 涌现式殖民地

P13 的殖民地不是用户输入的 network,而是**从世界状态自动涌现**的:

- 遍历世界所有 (cell, cohort) 候选
- 同 cell + 同 trait → `tryAdhere`(粘附到现有 organism)
- 否则 → `tryFormColony`(新建)
- 默认配置:`minMembers=2, fissionMembers=8, maintenance=1 J/member`

这是 P13 "两个选择单元" 原则的入口:从此殖民地与其成员队列独立演化。

### 2. `silent` 模式 + auto-step 集成

`chemistryStep` / `coloniesMaintain` 加 `p.silent === true` 检查:silent 模式下只更新内部状态,不 emit reply,不发 ack。

`internalTick` 末尾检查 `book.chemistry` / `book.colonies`,有就调 silent 模式:

```ts
if (ctx.book?.chemistry) {
  await handlers.chemistryStep({ silent: true }, ctx, 0);
}
if (ctx.book?.colonies) {
  await handlers.coloniesMaintain({ silent: true }, ctx, 0);
}
```

效果:用户**只点"▶ 开始演化"** 主 tick,P12/P13 就跟着自动跑。事件流不会被淹没在 per-step reply 里。

### 3. Projection 携带累计状态

silent 模式不发 reply → UI 不能拿 step / totalConsumedJ / totalFissions。修复:`Projection` 加 `chemistry` 和 `colonies` 字段(从 `#book` 直接读),`#publish` 每次都打包最新累计状态。UI 不再依赖 per-step reply,只读 projection。

### 4. **Pre-existing 死链 Bug 修复**

写测试时发现:主项目 `run` handler **只 setRunning(true) + setTarget**,没人启动 internalTick setTimeout 链。`internalTick` 末尾才 `schedule(g)`,但**没人触发第一次**。这是 pre-existing bug,产品里"▶ 开始演化"按钮点完,tick 永远不前进。

修复:在 `handleRun` 末尾加 `ctx.schedule(ctx.generation)` — 启动第一下 internalTick,之后链自续。

这是接入 P12/P13 auto-step 的必要修复,scope 内,不修我的 silent 调用永远跑不到。

---

## 测试矩阵

| 测试 | 验证 |
|---|---|
| `coloniesLoad: scans the world and forms organisms by (cell, trait) cohesion; cohorts remain in WorldState` | 至少形成一个殖民地 + 至少一个 cohort 被殖民 + 原 world cohort 数量不变 |
| `chemistryStep silent mode: advances reactor + debits ledger but does NOT emit a chemistry reply` | reactor step > 0 + totalConsumedJ > 0 + 0 个新增 chemistry reply |
| `coloniesMaintain silent mode: advances registry but does NOT emit a colonies reply` | projection.colonies 仍可用 + 0 个新增 colonies reply |
| `internalTick auto-step: chemistry + colonies advance in lockstep with the planetary tick` | run 3 ticks → tick=3, chem.step=3, col.total=448 + silent |

---

## UI 流程

1. 用户点 **cosmos-controls** 块的 **"化学与聚落实验 →"** 按钮
2. dialog 弹出,左栏 P12 反应网络,右栏 P13 聚落
3. **P12**:
   - 点 "载入示例网络" 填入默认 JSON
   - 点 "加载网络" → `chemistryLoad` → 状态显示 "已加载"
   - 点 "推进 1 步" → `chemistryStep` → 浓度表更新
4. **P13**:
   - 调整最小成员数 / 分裂阈值 / 维护费(可选)
   - 点 "扫描世界并形成聚落" → `coloniesLoad` → 显示形成数量
   - 点 "维护 1 步" → `coloniesMaintain` → 解散 / 分裂 / 维护累计
5. **自动步进**(关键 UX 改进):
   - 用户**关掉** dialog,回主界面点 **"▶ 开始演化"**
   - chemistry / colonies **自动** 跟着主 tick 推进
   - 用户再点 dialog 看到的是最新累计状态(从 projection 读)

---

## 仍待用户拍板(战略层 D 4 项)

无新增,沿用:
1. 14 视觉路线去留
2. WASM 化触发条件
3. 跨浏览器一致性
4. 仓库内 auto-continue

下一轮候选:
- **D**:MIST 96 MB 数据接入(P10-C 闭环)
- **E**:P14 智能行为(更大工程,启动 phase 1)
- **F**:战略 D 4 项用户拍板
- **G**:9 轮改动汇总提 PR(15 commit + 交付报告)
- **H**:UI 打磨:反应网络 JSON 校验更友好 / 殖民地列表展开细节 / auto-step 显式 toggle 显隐(目前是"加载后自动开")

请选字母组合。
