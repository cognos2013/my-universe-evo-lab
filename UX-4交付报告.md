# UX-4 客户体验重塑交付报告(Phase 7 / 8 / 9 / 10:历史/分支/创建/教学模式)

> 日期:2026-09-07
> 阶段:UX-1 phase 7—10 — 剩余 dialog 全整合 + 教学模式
> 工作区副本:`/Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/`
> 原始目录:`/Users/fuj2ee/Documents/ChatGPT/我的宇宙/`(无 V14 / explore / onboarding 文件,改动 100% 在副本)

## 一、本轮交付(4 合一)

### 1.1 Phase 7 — history-dialog 并入 explore-stage

| 改动 | 位置 |
|---|---|
| `<dialog id="history-dialog">` → `<section id="history-dialog" class="explore-stage-panel" data-explore="history">` | index.html |
| close button "✕" → "← 返回行星" | index.html |
| `historyDialog.showModal()` 删,`$('open-history')` click → `activateExplore('history')` | src/app/main.ts |
| `exploreSectionId` 加 `'history' → 'history-dialog'` | src/app/main.ts |
| `isHelpOpen` 删 `history-dialog` 引用(因为不再是 dialog) | src/app/main.ts |
| `explore.ts` 加 `history` panel:`eyebrow = 'KNOWLEDGE / COSMIC CHRONICLE'`,`isLoaded = () => true` | src/app/explore.ts |

### 1.2 Phase 8 — branch-dialog 并入 explore-stage

| 改动 | 位置 |
|---|---|
| `<dialog id="branch-dialog">` → `<section ... data-explore="branch">` | index.html |
| `$('open-lab')` click → `activateExplore('branch')` | src/app/main.ts |
| `$('close-lab')` click → `activateExplore(null)` | src/app/main.ts |
| `lab` 引用 + `$('open-lab').addEventListener(... lab.showModal())` 删 | src/app/main.ts |
| `isHelpOpen` 删 `branch-dialog` 引用 | src/app/main.ts |
| `explore.ts` 加 `branch` panel:`isLoaded = () => true`(lab 永远存在,即便只有 main branch) | src/app/explore.ts |

### 1.3 Phase 9 — create-dialog 删除(冗余)

| 改动 | 位置 |
|---|---|
| 删除整个 `<dialog id="create-dialog">` 块(975 字符)— 内容已搬到 onboarding step 4 的 on-stage form | index.html |
| `$('create-dialog')` 引用全删(main.ts 4 处 / 移除 1 处) | src/app/main.ts |
| `onboarding-skip[data-action="create"]` 跳 `goToStep(4)`(打开 step 4 on-stage form) | src/app/main.ts |
| `onboarding-cta-4` click 跳 `goToStep(4)`(同上) | src/app/main.ts |
| 顶部 header `#new-world` button 跳 `goToStep(4)`(在 renderOnboarding 内) | src/app/main.ts |

### 1.4 Phase 10 — 教学模式(guided mode)

| 改动 | 位置 |
|---|---|
| sidebar header 加 `.explore-guided-toggle` checkbox | index.html |
| `localStorage['my-universe-guided-v1']` 持久化(默认 off) | src/app/main.ts |
| 切换 toggle → `setGuidedMode(on)` → 重渲染 sidebar + 调 `applyGuidedHighlight` | src/app/main.ts |
| 激活 panel 时,如 guidedMode 开 → 找 panel 内第一个 `input / select / textarea / button:not(.text-button)` → 加 `.explore-guided-target` class + 紧跟的 tooltip 元素 "👆 试试看这里" | src/app/main.ts |
| CSS:`.explore-guided-target` mint 虚线 + `guided-pulse` 1.4s 呼吸动画;`.explore-guided-tip` mint 背景 + 三角箭头 | src/app/style.css |

### 1.5 explore.ts 现在 11 个 panel

```
cosmos / galaxy / v14 / chemistry / colonies / cognition / settlement / earth / batch / history / branch
```

brand-new world:9 个 missing(P12—P17)+ 5 个 loaded(cosmos/galaxy/v14/history/branch)— 推荐 settlement(rank 1)

### 1.6 测试

`tests/explore.test.ts` 改 4 个 + 加 4 个新:

| 测试 | 覆盖 |
|---|---|
| `ALL_EXPLORE_PANELS lists 11 panel in order` | 顺序 |
| `buildExploreState lists every panel exactly once` | 11 个 + loaded tail 末尾 branch |
| `UX-2.5: every panel maps to one DOM id` | 改 11 |
| `UX-4: history is always loaded` | read-only knowledge |
| `UX-4: branch is always loaded` | lab controls 永远存在 |
| `UX-4: history/branch appended after P12—P17` | 顺序 |
| `UX-4 Phase 10: guided mode persists via localStorage` | 'on' / 'off' |
| `UX-4 Phase 10: corrupt value → default off` | 异常恢复 |

**累计 265/265 tests + build + dev server 全绿**

## 二、验证

```bash
cd /Users/fuj2ee/workspace/跨智能体管理项目/我的宇宙项目学习/我的宇宙/
npx tsc --noEmit              # 0 errors
npm run check                 # 265/265 pass (260 + 5 UX-4)
npm run build                 # 154ms, dist 36.27 KB CSS (+1.5KB guided highlight)
npm run dev -- --port 9151    # HTTP 200, branch / history / guided toggle 都在
```

原始目录无 V14 / explore / onboarding 文件,改动 100% 在副本。

## 三、ROI 排序(下一步选项)

| 选项 | 价值 | 成本 | 推荐度 |
|---|---|---|---|
| 32 轮汇总提 PR(140+ commit) | 干净 commit 树 | 2 小时 | **高** |
| Phase 11:完整 guided mode 教程(每个 panel 一组引导步骤) | 首次用户更友好 | 半天 | 中 |
| Phase 12:虚拟滚动(>100 snapshot 时列表性能) | 大量 V14 资产下流畅 | 半天 | 中 |
| Phase 13:把所有 8 个外部 dialog 一并废除(create 已删,branch / history 已并) | 0 个 dialog 残留 | 1 小时 | **中**(已 6/7 完成) |

## 四、留什么没做(诚实交代)

- **8 个 `<dialog>` 仍存在(cosmos / galaxy / create / branch / history / v14 + 默认 fallback)**:6 个已并入 explore-stage(用 section),但 isHelpOpen 仍检测 cosmos/galaxy/v14/branch/history 5 个为 modal(因为旧代码可能还在触发 showModal)
- **教学模式只高亮第一个元素**:理想是一组引导步骤(每个 panel 有 N 步,next 翻页),但 phase 10 只做最简版
- **没有首次冷启动 banner 推荐开启 guided mode**:新用户进站不会自动开引导
- **没动 "📷 生成 3D 天际线" button**:它走 `v14Panel.prefillCityscape + activateExplore('v14')`,仍然工作
- **WASM 化 / 跨浏览器一致性 / 仓库内 auto-continue / 真实 API 接入**:战略层 D 未决

## 五、本轮改动汇总(commit-ready)

```
修改文件:
  index.html                          history-dialog / branch-dialog -> section + 删 create-dialog(975 字符)+ sidebar header guided toggle
  src/app/explore.ts                  +history panel + branch panel + ALL_EXPLORE_PANELS = 11
  src/app/main.ts                     +history / branch 路由 + 删 create-dialog 引用 + 删 isHelpOpen 中 5 个 dialog + 4 个 open 跳 activateExplore + guidedMode state + applyGuidedHighlight + 修复 action shadowing
  src/app/style.css                   +.explore-header-row + .explore-guided-toggle + .explore-guided-target + .explore-guided-tip + keyframes
  tests/explore.test.ts               4 个改 11 panel 断言 + 4 个新 UX-4 测试
```

dev server http://localhost:9151/ — 体验路径:
1. step 5 看到 sidebar + explore-stage
2. sidebar 顶部"教学模式"checkbox 勾上 → 高亮当前 panel 第一个元素 + tooltip "👆 试试看这里"
3. `0` 切到宇宙(快捷键 1—9 仍工作)
4. `H` 或 open-history 按钮 → 宇宙年表
5. `B` → 干预与分支(branch panel)
6. `4` 切到化学
7. 关掉教学模式 → 高亮消失
8. 顶部"新建世界" → 跳 onboarding step 4(不再弹 dialog)

## 六、用户未决选择(继承)

1. **Phase 11 是否做**:完整 guided mode 教程(每 panel N 步引导)
2. **32 轮汇总提 PR** 何时做
3. **战略层 D 4 项**:WASM 化 / 跨浏览器一致性 / 仓库内 auto-continue / 真实 API 接入
4. **是否需要 A11y 增强**:ARIA live region / focus management / screen reader 优化

—
Mavis 2026-09-07
