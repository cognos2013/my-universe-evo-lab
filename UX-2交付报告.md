# UX-2 客户体验重塑交付报告(Phase 2: 探索页 + 上下文面板)

> 日期:2026-09-07
> 阶段:UX-1 phase 2 — 探索侧边栏 + 上下文推荐算法
> 工作区副本:`/Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/`
> 原始目录:`/Users/fuj2ee/Documents/ChatGPT/我的宇宙/`(完全未动,11:37 mtime)

## 一、本轮交付

### 1.1 上下文状态机(`src/app/explore.ts`,7 KB)

| 概念 | 实现 |
|---|---|
| `ExplorePanelId` | `'chemistry' \| 'colonies' \| 'cognition' \| 'settlement' \| 'earth' \| 'batch'`(6 个 P12—P17 子系统) |
| `ALL_EXPLORE_PANELS` | `[chemistry, colonies, cognition, settlement, earth, batch]` |
| `PANEL_META` | 每 panel 的 eyebrow / title / blurb / `isLoaded(proj)` / `coldStartRank` / `hintIfMissing` / `hintIfLoaded` |
| `ExploreState` | `{ active, loaded: Record<id, boolean>, recommendations: id[], topReason }` |
| `recommendExploration(proj)` | 纯函数:挑一个未加载的 + rank 最低的;全加载 fallback 到 `chemistry` |
| `buildExploreState(proj, current)` | 派生完整 ExploreState(不持久化,每次 Projection 变化重算) |

**cold-start 优先级**(低的先推荐):
1. settlement(0.4 — 起步先建聚落)
2. batch(0.3 — 跑分布)
3. chemistry(0.2 — 反应网络)
4. colonies(0.15)
5. cognition(0.1)
6. earth(0.05 — 校准放最后)

### 1.2 探索侧边栏(`#explore-sidebar`)

- sticky 定位 `top: 142px / right: 24px`,`width: 300px`
- 仅在 onboarding step 5(演化)显示
- 3 部分:
  1. **Header**:`EXPLORE / P12—P17` eyebrow + 标题 + 简介
  2. **Recommendation card**:顶部小卡,显示当前 top reason + "打开 {panel 标题}" 主按钮
  3. **Panel list**:6 个 panel 入口,每项:
     - icon(已加载 = 绿勾,未加载 = 字母)
     - title + blurb
     - status(已加载/推荐/未开始)
     - loaded = mint 左边框;recommended = mint 高亮背景 + 内嵌左边条
     - hover 背景加深 + 微微左移(1px),click 触发对应 dialog
  4. **Footer**:`N / 6 已加载 · tick X · M branch`
- 响应式:< 980px 取消 fixed,变 normal flow

### 1.3 6 个子系统 dialog 整合状态

| Dialog | 点击 sidebar 入口行为 |
|---|---|
| `prebiotic-dialog`(含 P12 chemistry + P13 colonies 两个 section)| showModal dialog |
| `cognition-dialog`(P14) | showModal |
| `settlement-dialog`(P15) | showModal |
| `earth-dialog`(P16) | showModal |
| `batch-dialog`(P17) | showModal |
| V14 dialog | 保留独立(3D 视觉走专门 canvas,不归 sidebar 管) |

— Phase 2 阶段保留 dialog 形态(sidebar 跳转),不强行重做 panel DOM。这样风险最小,sidebar + 推荐算法已交付核心价值。

### 1.4 main.ts 集成

- `mountExplorePanel(id)` 函数:根据 id 找对应 dialog(chemistry/colonies 都 → prebiotic-dialog)→ showModal
- `renderExploreSidebar()` 纯 DOM 渲染函数:每次 Projection 变化调用
- 入口接 6 个 panel 列表项 click + recommendation button click + Enter/Space 键盘可达
- 跟 onboarding step 联动:step 1—4 hidden,step 5 显示
- Projection 推送时 `refreshExplore()` 自动更新 sidebar 状态

### 1.5 测试(`tests/explore.test.ts`,12 tests)

| 类别 | 测试 |
|---|---|
| 元数据 | ALL_EXPLORE_PANELS 顺序;PANEL_META 每 panel 都有 eyebrow/title/blurb/rank/isLoaded/hints |
| 优先级 | brand-new 推荐 settlement;settle 后推荐 batch;两者都 load 后推荐 chemistry;全 load 后 fallback chemistry |
| 状态构建 | active 透传;recommendations 长度 = 6 不重复,loaded 在尾部;all-loaded 时 topReason 含"所有实验都已加载" |
| 工具函数 | topRecommendationMeta 返回正确的 PANEL_META 项;空状态不出错 |

**累计 255/255 tests + build + dev server 全绿**

## 二、验证

```bash
cd /Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/
npx tsc --noEmit              # 0 errors
npm run check                 # 255/255 pass (243 之前 + 12 explore)
npm run build                 # 154ms, dist 32 KB CSS (+3KB) / 140 KB worker
npm run dev -- --port 9151    # HTTP 200, #explore-sidebar 在 dev 上
```

## 三、ROI 排序(下一步选项)

| 选项 | 价值 | 成本 | 推荐度 |
|---|---|---|---|
| Phase 2.5:把 6 个 dialog 真正搬到 explore-stage(主区 panel 切换,不再 showModal) | 体验更统一,sidebar 跳转 → 主区内容实时显示 | 半天 | **高** |
| 25 轮汇总提 PR(100+ commit) | 干净 commit 树,review 友好 | 2 小时 | **高** |
| Phase 3:加入上下文推荐到 onboarding 文本(每步给一句"基于当前状态")| 把 step 4 的"创建世界"和 step 5 的"探索"连起来 | 半天 | 中 |
| Phase 4:探索页 + AI 助手(LLM 推荐) | 上下文算法 + 行为数据 → 智能推荐 | 2 天 | 低(无 LLM 凭证)|
| Phase 5:探索页 tutorial mode(动画引导) | 首次进入有 step-by-step 引导 | 1 天 | 中 |

## 四、留什么没做(诚实交代)

- **6 个 dialog 仍是 dialog**:Phase 2 没把 dialog 搬到 explore-stage 主区(只是 sidebar 跳 dialog)。Phase 2.5 才是真"全部重组"
- **explore-stage 主区目前空**:sidebar 是浮动面板,主屏无 explore 内容展示。下一步把 6 个 dialog DOM 复制(去 dialog 包装)到 explore-stage
- **不持久化 active panel**:用户刷新后 active 回到默认 'settlement'
- **没有 keyboard navigation**(1/2/3 切 panel 之类)
- **没有 "run all missing" 一键跑**:用户得点 6 次
- **没有"教学" / "探索"模式切换**:本轮是探索模式,Phase 3 可加"教学"模式(step-by-step 解说)
- **sidebar 在小屏(< 980px)变 normal flow**:会被 timeline 推到下面,需要 scroll
- **WASM 化 / 跨浏览器一致性 / 仓库内 auto-continue / 真实 API 接入**:战略层 D 未决,等用户拍板

## 五、本轮改动汇总(commit-ready)

```
新增文件:
  src/app/explore.ts                  7 KB — ExplorePanelId / ALL_EXPLORE_PANELS / PANEL_META / ExploreState / recommendExploration / buildExploreState
  tests/explore.test.ts               8 KB — 12 tests(元数据/优先级/状态/工具函数)

修改文件:
  index.html                          +<aside id="explore-sidebar"> 浮动 sidebar(只有 step 5 显示)
  src/app/style.css                   +.explore-sidebar 样式 + panel item 状态 + responsive
  src/app/main.ts                      +mountExplorePanel + renderExploreSidebar + 接 projection + 接 onboarding step
```

dev server http://localhost:9151/ — 进入 step 5(演化)看到右侧浮动 sidebar:
- 顶部小卡:"打开 聚落与文明"(新建 world 后第一推荐)
- 6 个 panel 列表,settlement 高亮(mint 边框)+ 标"推荐"
- hover/click 进对应 dialog
- 每当加载/推进实验,sidebar 实时更新

## 六、用户未决选择(继承)

1. **Phase 2.5 是否立刻开做**(把 dialog 真正搬到 explore-stage 主区)
2. **首次冷启动是否强制 step 1**(仍是不强制,直接到 step 5)
3. **战略层 D 4 项**:WASM 化 / 跨浏览器一致性 / 仓库内 auto-continue
4. **25 轮汇总提 PR** 何时做

—
Mavis 2026-09-07
