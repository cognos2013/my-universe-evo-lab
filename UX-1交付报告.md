# UX-1 客户体验重塑交付报告(Phase 1: 5 步进度)

> 日期:2026-09-07
> 阶段:UX-1 phase 1 — 大屏首屏 + 5 步认知进度(从宇宙到类地行星)
> 工作区副本:`/Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/`
> 原始目录:`/Users/fuj2ee/Documents/ChatGPT/我的宇宙/`(完全未动,11:37 mtime 仍未变)

## 一、本轮决策(用户拍板)

| 问题 | 选择 |
|---|---|
| 冷启动体验 | **大屏首屏 + 5 步进度**(不强制完成,进度一直可见) |
| P12-P17 子系统实验面板 | **下一轮:全部重组成"探索"页 + 上下文面板**(本轮先做 5 步框架) |

## 二、本轮交付(Phase 1)

### 2.1 5 步认知路径

| Step | 标题 | 内容 | CTA |
|---|---|---|---|
| 1 | **宇宙**(COSMOS) | 简介 ΛCDM 简化背景 + H₀/Ωm/ΩΛ 参数 | 打开 cosmos dialog |
| 2 | **星系**(GALAXY) | 8 个预置气体晕,孤立系统,5 Myr 恒星步长 | 打开 galaxies dialog |
| 3 | **恒星 + 行星**(STAR & PLANET) | 三个质量档(0.1/1/10 M☉)的恒星 + 教学值,非观测校准 | 打开 galaxies dialog |
| 4 | **行星**(PLANET) | 场景/种子/温度/精度表单(原 create-form 嵌入主屏) | 提交表单,自动跳 step 5 |
| 5 | **演化**(EVOLVE) | 完整 P1—P9 + P12—P17 实验 | 隐藏 stage,显示原 `<main>` |

### 2.2 顶部进度条(`#onboarding-progress`)

- 5 个圆形 step 圆点 + 标签(宇宙/星系/恒星/行星/演化)
- 连接线:active 圆点之前的实色 + 之后的渐变(从 mint 到灰)
- 状态:
  - **pending**:灰底,不可点(disabled)
  - **completed**:mint 边框,深底
  - **active**:mint 实心 + glow(`box-shadow: 0 0 14px #6de5c460`)
- 顶部右侧"重新开始"按钮(confirm 后清状态)
- sticky 顶部,滚动时固定

### 2.3 主屏 hero(`#onboarding-stage`)

- 大屏 radial gradient(`#14243a → #080e17`)
- 每个 step 一个 `<article class="onboarding-panel" data-step="N">`:
  - eyebrow / h1 标题 / 描述 / 双 CTA(主按钮 + "在面板中打开"副按钮)
  - step 4 含 on-stage `<form id="onboarding-create-form">`(4 个字段 + 提交按钮)— 提交后自动调 `create` + 跳 step 5
- 底部 footer:`← 上一步` / `第 N / 5 步` / `下一步 →`(在 step 4 是"建立世界并演化 →")

### 2.4 状态机(`src/app/onboarding.ts`,7 KB)

| 概念 | 实现 |
|---|---|
| `OnboardingStep = 1 \| 2 \| 3 \| 4 \| 5` | 5 步字面量 |
| `OnboardingState` | `{ step, completedSteps: OnboardingStep[], finishedAtMs: number \| null }` |
| `DEFAULT_ONBOARDING_STATE` | step=1, completed=[], finishedAtMs=null |
| `loadOnboardingState()` | 从 `localStorage['my-universe-onboarding-v1']` 读,失败/缺失/损坏时回退默认 |
| `saveOnboardingState(s)` | 写 localStorage,quota / private mode 静默丢弃 |
| `advanceOnboardingState(s, step)` | 标记 `step` 为当前 + 把 1—step 都加入 completed;step=5 时首次 stamp `finishedAtMs` |
| `isStepReachable(s, target)` | 当前 / 已完成 / 紧邻下一步 → 3 种 reachable |
| `STEP_META` | 每步的 eyebrow / title / body / cta.action 静态元数据(给未来 onboarding 旁白/A11y 用) |

### 2.5 main.ts 集成

- 启动:`renderOnboarding()` 同步先执行(防 race),然后 `start()` 异步加载存档 / 创建世界
- start() 成功创建或 import 存档 → `advanceOnboardingState(5)` + `persistOnboarding()` + 隐藏 stage、显示 `<main>`(原主页)
- step 1—4 时,stage 可见,`<main>` 隐藏(用 `.hidden` 翻转)
- 重写 `#cosmos-planet` 和 `#new-world` 按钮的 onclick → 走 `goToStep(5)` / `goToStep(4)`,不再 showModal(create-dialog)
- 旧的 5 个 dialog(cosmos / galaxies / create)仍保留 showModal 入口,作为深路径备用
- 进度条 click → `goToStep(N)`(不可达的会 toast 提示"请先完成前面的步骤")
- 上一步/下一步/重置 按钮接好

### 2.6 测试(`tests/onboarding.test.ts`,13 tests)

| 类别 | 测试 |
|---|---|
| 默认 / 加载 | 默认 state;save/load round-trip;corrupt JSON 回退默认;未知字段丢弃 |
| advance | 同 step 幂等;1—N 都标 completed;step=5 首次 stamp finishedAtMs(后续不覆盖) |
| 跳转可达性 | target=current → reachable;completed → reachable;跳 N 步后被阻;已到 N 可再点 N+1 但不能再 N+2 |
| 元数据 | STEP_META 5 步都有 eyebrow/title/body/cta.action 合法;ALL_ONBOARDING_STEPS = [1,2,3,4,5] |

**累计 243/243 tests + build + dev server 全绿**

## 三、修的 1 个 bug

| 现象 | 根因 | 修复 |
|---|---|---|
| `isStepReachable` 对 `completedSteps=[]` 时,`max=0`,下一步应是 2 不是 1 — 但用 `Math.max(...completedSteps)` 得到 0,`target === max+1` 即 `target===1` 通过,跳过一步 | max 应该用 `max(state.step, ...completed)` — 已到 step 1 时下一步是 2 | 改用 `candidates: [state.step, ...completedSteps]` 取 max |

## 四、验证

```bash
cd /Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/
npx tsc --noEmit              # 0 errors
npm run check                 # 243/243 pass (230 之前 + 13 onboarding)
npm run build                 # 154ms, dist 29.56 KB CSS (+4KB) / 140 KB worker
npm run dev -- --port 9151    # HTTP 200, #onboarding-progress + #onboarding-stage + 4 step panels 渲染
```

## 五、Phase 2 计划(下一轮,做"探索"页 + 上下文面板)

| 工作 | 内容 |
|---|---|
| 探索侧边栏(右固定)| 显示"下一步会什么"推荐:行星初始化 → 试化学 / 播种生命;有生命 → 试聚落 / 校准;有聚落 → 试认知 / 看 V14 天际线 |
| 重构 5 个子系统 dialog(P12-P17) | 从 dialog 改为 `<section class="explore-panel" data-context="...">`,按当前 step 上下文选择性显示 |
| 上下文状态机 | 读 `Projection.chemistry/colonies/cognition/settlement/earthData/batches/v14Snapshots` 推断"已有哪些" |
| 7 个 dialog(余下 2 个 V14 + 1 个 create 仍可作为 power user 入口) → 整合 | 历史 dialog `/history-dialog` 也可整合进"探索"页(选时期 → 知识导览)|
| 探索页推荐算法 | 简单规则:缺什么推荐什么;有的话推荐"下一步":校准、批量、可视化 |
| 测试 | 上下文推荐规则 + 5 个 explore panel 显示/隐藏 |

## 六、ROI 排序(Phase 2 后的下一步选项)

| 选项 | 价值 | 成本 | 推荐度 |
|---|---|---|---|
| Phase 2(探索页) | 把 7 个 dialog 改成上下文驱动 | 1 天 | **高** |
| 23 轮汇总提 PR | 80+ commit 树,review 友好 | 2 小时 | **高** |
| 探索页 + 教程视频/动效 | 视觉引导比纯文字更友好 | 半天 | 中 |
| A/B 测试两种 onboarding(强制 vs 不强制) | 数据看哪种转化更好 | 1 天 | 低(无用户量) |
| 探索页 + AI 助手 | LLM 推荐"下一步"基于用户行为 | 2 天 | 中 |

## 七、留什么没做(诚实交代)

- **首次冷启动强制 5 步**:用户选了"不强制",所以一进站就跳到 step 5 看到行星。如果用户想从 step 1 开始,要主动点进度条。后续 Phase 2 可以加"是否首次"判定,新用户强制第 1 步
- **进度条持久化跨 session**:已完成(用 localStorage)
- **进度条 1—4 内容是简介 + 跳转,不是沉浸式 3D**:Phase 1 选"大屏首屏 + 5 步进度",没选"5 步渐进沉浸",所以 step 1 不是全屏宇宙背景,而是 hero 卡 + "打开 cosmos panel" 按钮。如果想做成沉浸式(每步把 cosmos / galaxies / planet 内容搬进主屏),成本翻倍
- **on-stage create-form 是 step 4 的简化版**:字段同 create-dialog,但没有"导入存档"按钮。如要,补 1 个 `data-action="import"` 跳到导入流程
- **step 3 内容偏弱**:目前是"看星系"按钮(借用 step 2 的 galaxies dialog)。Phase 2 可以做真正的"在晕里选恒星"—— 8 个晕 / 16 颗恒星 grid
- **没动 8 个 dialog 内部**:cosmos / galaxies / create / prebiotic / cognition / settlement / earth / batch 仍是 dialog,Phase 2 才会整合
- **探索页**:Phase 2 工作,本轮没做
- **WASM 化 / 跨浏览器一致性 / 仓库内 auto-continue / 真实 API 接入**:战略层 D 未决,等用户拍板

## 八、本轮改动汇总(commit-ready)

```
新增文件:
  src/app/onboarding.ts                7 KB — OnboardingStep / OnboardingState / STEP_META + load/save/advance/isStepReachable
  tests/onboarding.test.ts             6 KB — 13 tests(默认/加载/advance/可达性/元数据)

修改文件:
  index.html                           +<nav id="onboarding-progress"> 5 步进度条 +<section id="onboarding-stage"> 5 步主屏
  src/app/style.css                    +.onboarding-progress 进度条 +.onboarding-stage 大屏 hero + 5 步 panel 样式 + 响应式
  src/app/main.ts                      +onboarding state / renderOnboarding / goToStep / step CTA 绑定 / on-stage create-form submit / 重写 cosmos-planet + new-world onclick
```

dev server http://localhost:9151/ — 进站看到:
- 顶部 5 步进度条(高亮 step 1 "宇宙",因冷启动 `localStorage` 空 + start() 后跳 step 5,所以默认直接到 step 5)
- 如果想从 step 1 开始:点进度条第 1 步 → stage 出现 hero "从一个宇宙开始" → 点 CTA 看宇宙背景 → 关掉 dialog → 点"下一步" → step 2...
- 任何时候点进度条已通过的圆点可跳回

## 九、用户未决选择(继承)

1. **Phase 2 是否开做**:用户选项里选了"全部重组成探索页",但本轮只做了 5 步框架。Phase 2 是否立刻开做,等用户拍板
2. **首次冷启动是否强制 step 1**:现在是不强制,直接到 step 5(行星已存在)
3. **战略层 D 4 项**:WASM 化 / 跨浏览器一致性 / 仓库内 auto-continue(14 + UX 都没涉及)
4. **23 轮汇总提 PR** 何时做

—
Mavis 2026-09-07
