# UX-2.5 客户体验重塑交付报告(Phase 2.5: explore-stage 主区)

> 日期:2026-09-07
> 阶段:UX-1 phase 2.5 — 5 个 dialog 真正搬到 explore-stage 主区
> 工作区副本:`/Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/`
> 原始目录:`/Users/fuj2ee/Documents/ChatGPT/我的宇宙/`(完全未动,11:37 mtime)

## 一、本轮交付

### 1.1 index.html — 5 个 dialog 改成 section

| 旧 | 新 |
|---|---|
| `<dialog id="prebiotic-dialog">` | `<section id="prebiotic-dialog" class="explore-stage-panel" data-explore="chemistry">` |
| `<dialog id="cognition-dialog">` | `<section ... data-explore="cognition">` |
| `<dialog id="settlement-dialog">` | `<section ... data-explore="settlement">` |
| `<dialog id="earth-dialog">` | `<section ... data-explore="earth">` |
| `<dialog id="batch-dialog">` | `<section ... data-explore="batch">` |

每个 panel 顶部"关闭"按钮文案从"✕"改成"← 返回行星"(更明确)。

保留 3 个外部 dialog(cosmos / galaxy / v14)— 它们是 step 1—3 的"深路径"或专门 canvas 体验,不走 explore 框架。

### 1.2 新增 explore-stage 容器

```html
<section id="explore-stage" class="explore-stage" aria-label="探索主区" hidden>
  <div class="explore-stage-header">
    <button id="explore-back" class="text-button" type="button">← 返回行星</button>
    <span id="explore-stage-title" class="muted small">选择一个探索项开始</span>
  </div>
</section>
```

放在 `<main>` + `<aside id="explore-sidebar">` 后,step 5 才显示。
5 个 explore-stage-panel 隐式挨着 stage(都是同 section 后续节点)— 切 active 时只 hidden 切到对应 panel。

### 1.3 5 个 mountXxx 改造

每个 `mountXxx(send, onStatus)` 加可选第三参数 `onClose: () => void`:
- 移除 `dialog.showModal()` / `dialog.close()` 调用
- 移除 `dialog.addEventListener('cancel', ...)`(cancel 事件不存在于 section)
- close button click → `onClose()`(通知 main.ts 隐藏 stage)
- DOM 引用类型从 `HTMLDialogElement` 放宽到 `HTMLElement`

5 个文件:`prebiotic.ts` / `cognition.ts` / `settlement.ts` / `earth.ts` / `batch.ts` — 同样的改造。

### 1.4 main.ts 接入

| 函数 | 行为 |
|---|---|
| `mountExplorePanel(id)` | hide 其他 panel,显示对应 panel,刷新 sidebar active 状态 |
| `activateExplore(id \| null)` | null → 隐藏 stage + 显示 main(返回行星);id → 隐藏 main + 显示 stage + activate panel |
| `exploreSectionId(id)` | mapping:chemistry + colonies → prebiotic-dialog;cognition → cognition-dialog;settlement → settlement-dialog;earth → earth-dialog;batch → batch-dialog |

5 个 open button:
- 旧:`action(send('pause')); (X-dialog as HTMLDialogElement).showModal();`
- 新:`action(send('pause')); activateExplore('chemistry' | 'cognition' | 'settlement' | 'earth' | 'batch');`

5 个 close button 由 mountXxx 内部 onClose 接管 → `activateExplore(null)`。

sidebar 推荐按钮 + 列表项 click 也走 `activateExplore(id)`,主屏切换体验统一。

`renderExploreSidebar()` 中 `exploreActive ?? recommendExploration(projection)` fallback 避免 null state。

### 1.5 style.css

新增 `.explore-stage` / `.explore-stage-header` / `.explore-stage-panel` 样式:
- stage 容器:大圆角 + 深背景 + 480px minHeight
- panel 内 heading / form 沿用原 dialog 样式(但加 `max-width: 1200px / margin: 0 auto` 居中)
- 内部 5 种 layout(prebiotic / cognition / settlement / earth / batch)用 grid 跨 1100px 断点折叠
- 响应式:< 980px 时 margin 缩为 16px

### 1.6 测试(`tests/explore.test.ts` 加 2 个新)

- **every panel maps to one entry**:state.recommendations 长度 = 6,每个 panel id 都在
- **chemistry + colonies 共享 prebiotic-dialog**:两个 panel id 都在 recommendations 中(虽然 DOM 表面相同,作为 sidebar 两个入口)
- **onClose 不影响 projection 状态**:同一 projection 两次 buildExploreState 结果 deepEqual(关闭只是 UI 信号,不是 state 变更)

**累计 257/257 tests + build + dev server 全绿**

## 二、验证

```bash
cd /Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/
npx tsc --noEmit              # 0 errors
npm run check                 # 257/257 pass (255 之前 + 2 explore)
npm run build                 # 154ms, dist 33.98 KB CSS (+2KB)
npm run dev -- --port 9151    # HTTP 200, 5 个 section + explore-stage + 3 个外部 dialog
```

## 三、ROI 排序(下一步选项)

| 选项 | 价值 | 成本 | 推荐度 |
|---|---|---|---|
| 26 轮汇总提 PR(110+ commit) | 干净 commit 树,review 友好 | 2 小时 | **高** |
| Phase 3:把 cosmos / galaxy / v14 三个外部 dialog 也并入 explore-stage | 完全统一的探索页体验 | 1 天 | 中 |
| Phase 4:探索页 + 动画 / 过渡(fade in / slide) | 视觉上更平滑 | 半天 | 中 |
| Phase 5:探索页 + AI 助手推荐(LLM) | 智能推荐 | 2 天 | 低(无 LLM) |
| Phase 6:探索页键盘快捷键(1—6 切 panel,Esc 返回行星) | power user 友好 | 2 小时 | 中 |

## 四、留什么没做(诚实交代)

- **3 个外部 dialog(cosmos / galaxy / v14)仍是 dialog**:他们有各自不同的 UI 形态(3D 宇宙 / 星系 grid / Three.js 画布),整合到 explore-stage 需要更复杂布局,留作 Phase 3
- **mountXxx 中不再使用 dialog API,但 mountXxx 模块仍接受 onClose callback(可选)**:这是 Phase 2.5 的兼容层。Phase 3 可以删除 onClose 参数
- **panel 切换没有动画**:直接 hidden 切,无 fade/slide。视觉上略硬,后期可加
- **没有面板级深链 / 路由刷新保留 panel**:刷新后 exploreActive 重置为推荐项
- **没有键盘快捷键**:数字键 1—6 切 panel 之类
- **cosmos-dialog / galaxy-dialog 仍为 dialog**:用户点 onboarding step 1—3 CTA 仍走 showModal(因为 mountCosmos/mountGalaxies 是 dialog 形态)
- **战略层 D 4 项**:WASM 化 / 跨浏览器一致性 / 仓库内 auto-continue

## 五、本轮改动汇总(commit-ready)

```
修改文件:
  index.html                          5 个 dialog -> 5 个 section + 加 explore-stage 容器 + 5 个 close 按钮文案改
  src/app/prebiotic.ts                dialog API 移除 + onClose callback + SAMPLE_NETWORK 移入函数
  src/app/cognition.ts                dialog API 移除 + onClose callback
  src/app/settlement.ts               dialog API 移除 + onClose callback(参数位置:onGenerateCityscape, onClose)
  src/app/earth.ts                    dialog API 移除 + onClose callback
  src/app/batch.ts                    dialog API 移除 + onClose callback
  src/app/main.ts                     5 个 open button 走 activateExplore + mountXxx 接 onClose + exploreSectionId 映射 + explore-stage DOM 引用 + sidebar fallback
  src/app/style.css                   +.explore-stage + .explore-stage-header + .explore-stage-panel + 5 个 layout grid 响应式
  tests/explore.test.ts              +2 tests(panel 映射 / onClose 不影响 state)
```

dev server http://localhost:9151/ — 体验路径:
1. 进站看到 onboarding step 5(演化)直接显示
2. 看到右浮动 sidebar(P12—P17 6 个探索入口)
3. 点推荐按钮或任一 entry → 主屏切到 explore-stage 显示对应 panel(P12 chemistry / P15 settlement 等)
4. 顶部"← 返回行星"按钮 → 主屏切回行星 + 隐藏 stage
5. sidebar 状态实时反映(Projection 变化时)

## 六、用户未决选择(继承)

1. **Phase 3 是否继续**:把 3 个外部 dialog(cosmos / galaxy / v14)也并入 explore-stage
2. **首次冷启动是否强制 step 1**:仍是不强制
3. **26 轮汇总提 PR** 何时做
4. **战略层 D 4 项**:WASM 化 / 跨浏览器一致性 / 仓库内 auto-continue

—
Mavis 2026-09-07
