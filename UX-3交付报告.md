# UX-3 客户体验重塑交付报告(Phase 3 / 4 / 6:cosmos/galaxy/v14 整合 + 键盘 + 动画)

> 日期:2026-09-07
> 阶段:UX-1 phase 3 + 4 + 6 — explore 全面整合 + 键盘快捷键 + 切换动画
> 工作区副本:`/Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/`
> 原始目录:`/Users/fuj2ee/Documents/ChatGPT/我的宇宙/`(无 V14 / explore / onboarding 文件,改动 100% 在副本)

## 一、本轮交付(3 合一)

### 1.1 Phase 3 — cosmos / galaxy / v14 3 个外部 dialog 整合

| 旧 | 新 |
|---|---|
| `<dialog id="cosmos-dialog">` | `<section id="cosmos-dialog" class="explore-stage-panel" data-explore="cosmos">` |
| `<dialog id="galaxy-dialog">` | `<section ... data-explore="galaxy">` |
| `<dialog id="v14-dialog">` | `<section ... data-explore="v14">` |

3 个 mountXxx(mountCosmos / mountGalaxies / mountV14)同步改造:
- `HTMLDialogElement` 引用放宽为 `HTMLElement`
- 移除 `dialog.showModal()` / `dialog.close()` / `dialog.addEventListener('close' / 'cancel')`
- 加 `onClose: () => void` 可选参数
- `dialog.open` 改 `!dialog.hidden`(cosmos ResizeObserver / v14 帧循环判断)
- close button 文案统一改 "← 返回行星"

3 个外部 dialog(branch / history / create)保留 — 它们的 UI 形态不同(branch / history 是知识导览 / 多分支表;create 是初始化表单,不归入探索),按 deep path 保留。

### 1.2 explore.ts 扩展 — 9 个 panel

| 新 panel | eyebrow | isLoaded | 用途 |
|---|---|---|---|
| `cosmos` | STEP 1 / COSMOS | `() => true` | step 1 入口,常驻 |
| `galaxy` | STEP 2 / GALAXY | `() => true` | step 2 入口,常驻 |
| `v14` | STEP 3 / VISUAL | `p.v14.snapshots.length > 0` | 看 3D 模型 |
| 原有 6 个(chemistry / colonies / cognition / settlement / earth / batch)| — | — | — |

`ALL_EXPLORE_PANELS` 从 6 扩到 9。`recommendExploration` 改动:cosmos / galaxy 是 "step 入口",不再进入 missing 列表(因为 isLoaded 总 true),所以 brand-new world 推荐 settlement(rank 1)而非 cosmos(避免把 sidebar 推到 step 1 重温)。

### 1.3 main.ts 路由

- `exploreSectionId(id)` 加 3 个映射(cosmos / galaxy / v14)
- 5 个 open 按钮(open-cosmos / open-v14 / open-prebiotic / open-cognition / open-settlement / open-earth / open-batch)统一跳 `activateExplore(id)`,不再 `showModal`
- settlement 列表 "📷 生成 3D 天际线" button:`v14Panel.prefillCityscape()` + `activateExplore('v14')`(替代 showModal)
- onboarding step 1—3 CTA 按钮(onboarding-cta-1/2/3):`goToStep(5) + activateExplore('cosmos' | 'galaxy' | 'v14')`(替代 showModal)
- 跨 panel 事件 `document.addEventListener('explore-activate', ...)`:mountGalaxies 内部 "open-galaxies" button 触发后 dispatch,main.ts 监听,实现"在 cosmos panel 里点'打开 galaxies'切换 panel"的链式导航

### 1.4 Phase 6 — 键盘快捷键

| 键 | 行为 |
|---|---|
| `1` — `9` | 切到对应 panel(cosmos/galaxy/v14/chemistry/colonies/cognition/settlement/earth/batch,按 ALL_EXPLORE_PANELS 顺序) |
| `R` | 跳当前推荐(top recommendation) |
| `Esc` | 返回行星(隐藏 explore-stage) |
| 任何键 | 在 `<input>` / `<textarea>` / `<select>` / `contenteditable` 不劫持 |
| 任何键 | 在外部 `<dialog>` 打开时(branch / history / create / cosmos / galaxy / v14)不劫持 |
| step 1—4 时 | 任何数字键不响应(只在 step 5 / 演化阶段启用) |

UI 提示:stage header 右上角加 `<kbd>1</kbd>—<kbd>9</kbd> 切面板 <kbd>R</kbd> 推荐 <kbd>Esc</kbd> 返回` 提示卡,带 keyframes 闪烁动画。

### 1.5 Phase 4 — 切换动画

- `explore-fade-in` keyframes:opacity 0→1 + translateY(6px)→0,180ms ease-out
- 每次 panel 切换时(因 hidden → not hidden)自动触发,无需 JS
- explore-stage-header back button 加 `:active` 缩放反馈

### 1.6 测试

- explore.test.ts 更新:ALL_EXPLORE_PANELS 顺序断言、brand-new world 推荐、all-loaded topReason、UX-2.5 panel 映射(改 9 而非 6)
- 新增 3 个 UX-3 测试:
  - **PANEL_META covers 9 panel ids** + spot-check cosmos/galaxy/v14 eyebrow
  - **cosmos 和 galaxy isLoaded 永远 true**(step 入口,无 controller state 要求)
  - **v14 isLoaded 反映 snapshots.length**(0 时 false,有 snapshot 时 true)

**累计 260/260 tests + build + dev server 全绿**

## 二、验证

```bash
cd /Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/
npx tsc --noEmit              # 0 errors
npm run check                 # 260/260 pass (257 之前 + 3 UX-3)
npm run build                 # 154ms, dist 34.80 KB CSS (+1KB for kbd hint)
npm run dev -- --port 9151    # HTTP 200, 9 个 panel + kbd hint 都在
```

## 三、ROI 排序(下一步选项)

| 选项 | 价值 | 成本 | 推荐度 |
|---|---|---|---|
| 28 轮汇总提 PR(120+ commit) | 干净 commit 树,review 友好 | 2 小时 | **高** |
| Phase 7:把 history-dialog(宇宙年表)也并入 explore-stage | 完全统一探索 | 1 天 | 中 |
| Phase 8:把 branch-dialog(干预与分支)并入 explore-stage | 减少外部 dialog 数 | 半天 | 中 |
| Phase 9:把 create-dialog(创建行星)整合到 onboarding step 4 only | 不再作为外部 dialog | 2 小时 | 中 |
| Phase 10:探索页 + 教学模式(step-by-step 解说) | 教学友好 | 1 天 | 中 |

## 四、留什么没做(诚实交代)

- **branch-dialog(干预与分支)、history-dialog(宇宙年表)、create-dialog(创建行星)仍是外部 `<dialog>`**:它们的 UI 形态不同(branch 是 form + list;history 是左导航 + 右文章;create 是创建表单)。Phase 7—9 才会并入
- **没有 panel keyboard navigation**(1—6 切 panel 之外,Tab 顺序还没在 panel 间优化)
- **动画只有 fade-in**:没有 slide / scale / morph。简化实现
- **cosmos / galaxy 始终 isLoaded true**:理论上用户可能没初始化 galaxy(没动 8 个气体晕),但 sidebar 标"已加载"会让人误以为已操作。这是 UI 简化,后续可以让 isLoaded 反映 `book.astronomy !== null`
- **v14 prefillCityscape 仍是独立 API**:虽然 v14 panel 整合了,但 settlement 📷 button 还是会预填 spec 然后 activate — 这是 UX 保留,不是 bug
- **focus management**:激活新 panel 后焦点不会自动移到 panel 内第一个可交互元素
- **无障碍**:键盘 hint 用 `<kbd>` 但没有 ARIA live region 通知用户 panel 切换
- **WASM 化 / 跨浏览器一致性 / 仓库内 auto-continue**:战略层 D 未决

## 五、本轮改动汇总(commit-ready)

```
修改文件:
  index.html                          3 个外部 dialog -> section + kbd hint 加入 stage header
  src/app/cosmos.ts                   dialog API 移除 + onClose + ResizeObserver 用 !hidden
  src/app/galaxies.ts                 dialog API 移除 + onClose + open-galaxies 触发 explore-activate 事件
  src/app/v14.ts                      dialog API 移除 + onClose + close 按钮内置 frame loop cancel + 改 !hidden
  src/app/explore.ts                  +cosmos / galaxy / v14 panel + 9 panel ALL_EXPLORE_PANELS + 调整 galaxy isLoaded 永远 true + 调整 v14 isLoaded 看 snapshots
  src/app/main.ts                     5+ open 按钮 + onboarding CTA + settlement prefill 跳 activateExplore + 3 mountXxx 接 onClose + exploreSectionId 加 3 映射 + explore-activate 事件监听 + 键盘 1-9 / R / Esc 监听 + focus 检查
  src/app/style.css                   +explore-fade-in 动画 + .explore-kbd-hint + kbd-flash keyframes
  tests/explore.test.ts               5 个测试改 9 panel 断言 + 3 个新 UX-3 测试
```

dev server http://localhost:9151/ — 体验路径:
1. 进站 → onboarding step 5(演化)
2. sidebar 显示 9 个 panel(cosmos / galaxy / v14 + 6 个 P12—P17)
3. **键盘**:`1` 看宇宙 / `2` 看星系 / `3` 看 3D 视觉 / `4` 化学 / `5` 聚落 / `6` 认知 / `7` 文明 / `8` 校准 / `9` 批量
4. **R** 跳推荐(settlement)
5. **Esc** 返回行星
6. **mouse**:点 sidebar 入口 / 点 onboarding step 1—3 CTA / 在 cosmos panel 里点"星系与恒星实验 →"直接切
7. 切 panel 时 fade-in 180ms 平滑过渡

## 六、用户未决选择(继承)

1. **Phase 7—10 是否继续**:把剩余 3 个 dialog(branch / history / create)并入 explore-stage
2. **首次冷启动是否强制 step 1**:仍是不强制
3. **28 轮汇总提 PR** 何时做
4. **战略层 D 4 项**:WASM 化 / 跨浏览器一致性 / 仓库内 auto-continue / 真实 API 接入

—
Mavis 2026-09-07
