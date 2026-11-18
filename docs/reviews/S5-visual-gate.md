# S5-J 视觉硬门槛实测报告

- 任务：S5-J 视觉硬门槛与设置屏
- 规格依据：`docs/superpowers/specs/2026-11-11-workflow-orchestration-design.md` §8.6（行 659-667）；设计口径 `docs/orchestra-design-draft.md` 行 2164（G5 必过项）、行 2171（WCAG 2.2 AA 判据）、行 2179（字号写进门禁）
- 计划依据：`docs/superpowers/plans/2026-11-12-dsh-orchestra-s5-panel-memory.md` Task7（行 1109-1233）
- 报告日期：2026-11-18
- 运行环境：Windows 11，node v26.13.1，Chrome 157.0.8103.79（`C:\Program Files\Google\Chrome\Application\chrome.exe`），Edge 157.0.4341.60 备用

## 1. 门槛总览

| 门槛 | 来源 | 判定方式 | 判定 | 结论 |
| --- | --- | --- | --- | --- |
| 正文字号 ≥13px | 规格 §8.6 行 662 | 静态：`FONT_PX.body=14 ≥ FONT_FLOOR_PX.body=13`；实测：面板根容器计算字号 14px | 通过（静态+实测） | 通过 |
| 辅助文字 ≥12px | 规格 §8.6 行 662 | 静态：`FONT_PX.helper=12 ≥ FONT_FLOOR_PX.helper=12`；实测：渲染文本最小 12px，无 <12px 元素 | 通过（静态+实测） | 通过 |
| 左侧菜单与顶部导航 ≥12.5px | 规格 §8.6 行 662 | 静态：`FONT_PX.menu=13 ≥ FONT_FLOOR_PX.menu=12.5`；实测：菜单 13px、顶导 13px | 通过（静态+实测） | 通过 |
| 字号来源单一（禁止散落字面量） | 任务书门槛① | 静态：`tests/client/panel-visual.spec.tsx` 门槛①（棘轮） | 通过（棘轮，历史 15 处已钉死） | 通过（带遗留） |
| 正文对比度 ≥4.5:1 | 规格 §8.6 行 662-663 | 静态：`TEXT_PAIRS` 6 项按 `contrastRatio()` 实测 | 通过 | 通过 |
| 大字/UI 控件对比度 ≥3:1 | 规格 §8.6 行 663 | 静态：`TEXT_PAIRS` 中 link 项 floor=3 实测 6.09 | 通过 | 通过 |
| 1600×1000 无横向溢出 | 规格 §8.6 行 664 | 实测：无头 Chrome，`documentElement.scrollWidth <= clientWidth` | 通过（1600 ≤ 1600） | 通过 |
| 1366×900 无横向溢出 | 规格 §8.6 行 664 | 实测：同上 | 通过（1366 ≤ 1366） | 通过 |
| 长标题截断且提示承载全文 | 规格 §8.6 行 664 | 实测 + 渲染断言：`textContent` 完整、`title` 等长、样式 `text-overflow: ellipsis` | 通过（1366 视口实测截断=true） | 通过 |
| 浅色主题不用黑色底 | 规格 §8.6 行 660 | 实测：面板底色 rgb(255,255,255) | 通过 | 通过 |
| 菜单左侧无装饰性彩条 | 规格 §8.6 行 660 | 实测：侧栏元素底色最大通道差 9（阈值 40） | 通过 | 通过 |
| 页面无运行时错误 | 稳健性 | 实测：无 console error / uncaught | 通过 | 通过 |

未覆盖 / 未能确认项见第 5 节。

## 2. 静态门槛（tests/client/panel-visual.spec.tsx）

### 2.1 用例 → 门槛映射

| 测试名（vitest 用例名） | 对应门槛 | 断言方式 |
| --- | --- | --- |
| 门槛① 面板源码的字号字面量只剩棘轮清单里的历史项，新代码必须走 tokens.ts | 门槛① 字号来源单一 | 扫描 `src/client/panel/**`（除 tokens.ts）的 `fontSize`/`font` 简写字面量，断言实际集合与钉死的 `legacyFontLiterals` 清单完全相等、命中数 ≥15（反空壳）、`settings-screen.tsx` 命中 0，且每个字面量 ≥ `FONT_FLOOR_PX.body` |
| 门槛② 字号下限：FONT_PX 每项不低于 FONT_FLOOR_PX，且下限本身不低于规格 | 门槛② | 断言 `FONT_PX.body ≥ FONT_FLOOR_PX.body` 等三项，且 `FONT_FLOOR_PX ≥ {body:13, helper:12, menu:12.5}` |
| 门槛③ 对比度：TEXT_PAIRS 每项实测比值不低于其下限 | 门槛③ | 遍历 `TEXT_PAIRS`，用 `contrastRatio()` 实算 ≥ 其 floor；并断言 floor ∈ {4.5, 3} 且与语义标签一致 |
| 门槛④ 面板源码没有超过 1366px 的固定宽度或最小宽度 | 门槛④ | 扫描 `width`/`minWidth` 数字字面量，断言最大值 ≤1366、命中数 ≥10（反空壳）、并必须抓到已知的 236/240 |
| 门槛⑤ 长标题完整保留、title 承载全文、样式负责截断 | 门槛⑤ | 渲染 `TaskListScreen`（超长标题），断言 `textContent` 全文、`title` 全文、内联样式含 `text-overflow: ellipsis`/`overflow: hidden`/`white-space: nowrap` |
| 门槛② 实测字号：面板渲染出来的文字不低于规格下限 | 门槛② | 渲染面板，遍历有直接文本节点元素的 `getComputedStyle().fontSize`，断言 ≥ `FONT_FLOOR_PX.helper`；并断言左侧菜单按钮与顶部导航 ≥ `FONT_FLOOR_PX.menu` |
| 设置屏拿不到状态时显示「未知」，不填猜测值 | 设置屏真实性 | 渲染 `SettingsScreen`（不传任何状态），断言 6 个 `dd` 全为「未知」 |
| 设置屏按真实状态显示服务连接、协议、快照、事件流、阶段与版本 | 设置屏真实性 | 传入真实状态，断言 `dd` 依次为 已连接/与服务一致/最新/实时更新/S5/0.1.0 |
| 宿主一行接入：PanelHost 组装客户端、事件流与面板，设置屏读到真实状态 | 宿主入口 | 用 stub `/health` 渲染 `PanelHost`，导航到设置页，断言读到「已连接」「与服务一致」「S5」且确实请求过 `/health` |

### 2.2 原始输出

```
$ pnpm vitest run tests/client/panel-visual.spec.tsx

 RUN  v4.1.8 D:/aboutAI/dsh-orchestra

 ✓ tests/client/panel-visual.spec.tsx (9 tests) 256ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  14:31:29
   Duration  1.63s (transform 220ms, setup 0ms, import 577ms, tests 256ms, environment 641ms)
```

stderr（React 警告，非失败，来自禁改文件 `src/client/panel/shell.tsx:80` 的 `font` 简写与 `fontWeight` 混用）：

```
Warning: Removing a style property during rerender (fontWeight) when a conflicting property is set (font) can lead to styling bugs. To avoid this, don't mix shorthand and non-shorthand properties for the same value; instead, replace the shorthand with separate values.
    at button
    at nav
    at aside
    at div
    at PanelShell (D:/aboutAI/dsh-orchestra/src/client/panel/shell.tsx:80:12)
    at PanelApp (D:/aboutAI/dsh-orchestra/src/client/panel/app.tsx:34:121)
    at PanelHost (D:/aboutAI/dsh-orchestra/src/client/panel-host.tsx:29:117)
```

### 2.3 既有 tests/client 全部用例未被弄红

```
$ pnpm vitest run tests/client

 RUN  v4.1.8 D:/aboutAI/dsh-orchestra

 ✓ tests/client/event-stream.spec.ts (6 tests) 9ms
 ✓ tests/client/workflow-editor.spec.tsx (4 tests) 308ms
 ✓ tests/client/panel-visual.spec.tsx (9 tests) 294ms
 ✓ tests/client/workflow-canvas.spec.tsx (10 tests) 405ms
 ✓ tests/client/panel-pagination.spec.tsx (4 tests) 424ms
 ✓ tests/client/panel-screens.spec.tsx (25 tests) 703ms
 ✓ tests/client/panel-memory.spec.tsx (19 tests) 832ms
 ✓ tests/client/decision-panel.spec.tsx (13 tests) 1029ms
     ✓ 冲突、忙、过期、无权限等失败各自给出可辨识的中文提示  425ms

 Test Files  8 passed (8)
      Tests  90 passed (90)
   Start at  14:31:38
   Duration  2.21s (transform 747ms, setup 0ms, import 1.79s, tests 4.00s, environment 5.28s)
```

### 2.4 类型检查

```
$ pnpm typecheck
$ tsc --noEmit
（exit code 0，无输出）
```

## 3. 无头浏览器实测（scripts/visual-check.mjs）

### 3.1 实测方式

- 用仓库自带 tsdown 把 `src/client/panel-host.tsx` + React 打成一个 IIFE bundle（`node_modules/.cache/dsh-visual-check/panel.bundle.js`），配一个静态 HTML 装载页。
- 页面内 `fetch` 被 stub 成固定 JSON：`/health` → `{ok:true,phase:'S5',epoch:7}`；`/v1/tasks` → 2 条任务（其一标题为 74 字长标题）；`/v1/events` → `{items:[]}`；`/v1/events/stream` → 503（走 SSE 失败回退）。**这里不注入任何视觉判断数据，测量对象是真实渲染出的面板 DOM。**
- 视口用 CDP `Emulation.setDeviceMetricsOverride` 精确设置（`.--window-size` 在本机 headless 下比真实视口少 22×98 像素，不能用窗口尺寸代替视口）。
- 判定数据由页面在 t+0/120/400/1000/2000ms 各采一次，取 t+2000ms 那次（label=t+2000ms）。

### 3.2 原始命令与输出

```
$ node scripts/visual-check.mjs --keep

== S5-J 视觉门槛实测（无头 Chrome，两个视口） ==
工作目录: D:\aboutAI\dsh-orchestra\node_modules\.cache\dsh-visual-check
浏览器: C:\Program Files\Google\Chrome\Application\chrome.exe
ℹ entry: node_modules\.cache\dsh-visual-check\entry.tsx
ℹ target: es2020
ℹ tsconfig: tsconfig.json
ℹ Build start
ℹ Hint: consider adding deps.onlyBundle option to avoid unintended bundling of dependencies, or set deps.onlyBundle: false to disable this hint.
See more at https://tsdown.dev/options/dependencies#deps-onlybundle
Detected dependencies in bundle:
- react
- scheduler
- react-dom
ℹ node_modules\.cache\dsh-visual-check\panel.bundle.js  387.92 kB │ gzip: 89.79 kB
ℹ 1 files, total: 387.92 kB
✔ Build complete in 57ms
构建: tsdown -> D:\aboutAI\dsh-orchestra\node_modules\.cache\dsh-visual-check\panel.bundle.js (387924 bytes)
页面: D:\aboutAI\dsh-orchestra\node_modules\.cache\dsh-visual-check\panel.html

---- 视口 1600x1000 ----
命令: C:\Program Files\Google\Chrome\Application\chrome.exe --headless --disable-gpu --no-first-run --no-default-browser-check --disable-extensions --disable-background-networking --disable-component-update --disable-sync --metrics-recording-only --user-data-dir=D:\aboutAI\dsh-orchestra\node_modules\.cache\dsh-visual-check\profile-1600x1000 --remote-debugging-port=0 about:blank
CDP: Emulation.setDeviceMetricsOverride width=1600 height=1000 deviceScaleFactor=1
页面: file:///D:/aboutAI/dsh-orchestra/node_modules/.cache/dsh-visual-check/panel.html
原始测量: {"label":"t+2000ms","innerWidth":1600,"innerHeight":1000,"devicePixelRatio":1,"scrollWidth":1600,"clientWidth":1600,"bodyScrollWidth":1600,"noHorizontalOverflow":true,"rootScrollWidth":1600,"rootClientWidth":1600,"offenders":[],"fonts":{"min":12,"minText":"工作区","below12":[],"histogram":{"12":12,"13":10,"14":4,"16":4,"24":1}},"navFontSize":13,"headerFontSize":13,"longTitle":{"found":true,"titleAttributeLength":74,"textLength":74,"textMatchesTitle":true,"textOverflow":"ellipsis","overflow":"hidden","whiteSpace":"nowrap","renderedWidth":1114,"scrollWidth":1114,"clientWidth":1114,"truncated":false},"appFontSize":14,"appBackground":"rgb(255, 255, 255)","bodyBackground":"rgb(255, 255, 255)","sidebarColors":[{"tag":"BUTTON","background":"rgb(233, 237, 242)","rgb":{"r":233,"g":237,"b":242,"max":242,"min":233,"delta":9},"delta":9}],"navLabels":["任务","等你决定","待核实","流程","记忆","设置"],"mainPresent":true}
  [通过] G0-面板已渲染 —— main 存在
  [通过] G1-视口尺寸精确 —— 实测 1600×1000，目标 1600×1000
  [通过] G2-无横向溢出 —— documentElement.scrollWidth 1600 vs clientWidth 1600；根容器 scrollWidth/clientWidth 1600/1600；越界元素 []
  [通过] G3-正文基础字号≥13px —— 面板根容器计算字号 14px
  [通过] G4-辅助文字≥12px —— 渲染文本最小 12px（工作区）；小于 12px 的元素 []
  [通过] G5-菜单与顶导≥12.5px —— 左侧菜单 13px，顶部导航 13px
  [通过] G6-长标题截断且 title 承载全文 —— title 74 字 / 文本 74 字，一致=true；text-overflow=ellipsis，overflow=hidden，white-space=nowrap；本视口是否被截断=false
  [通过] G7-浅色底不用黑色 —— 面板底色 rgb(255, 255, 255)，页面底色 rgb(255, 255, 255)
  [通过] G8-菜单无装饰性彩条 —— 侧栏元素底色最大通道差 9（阈值 40）；[{"tag":"BUTTON","background":"rgb(233, 237, 242)","rgb":{"r":233,"g":237,"b":242,"max":242,"min":233,"delta":9},"delta":9}]
  [通过] G9-页面无运行时错误 —— 无 console error / uncaught
判定: 通过

---- 视口 1366x900 ----
命令: C:\Program Files\Google\Chrome\Application\chrome.exe --headless --disable-gpu --no-first-run --no-default-browser-check --disable-extensions --disable-background-networking --disable-component-update --disable-sync --metrics-recording-only --user-data-dir=D:\aboutAI\dsh-orchestra\node_modules\.cache\dsh-visual-check\profile-1366x900 --remote-debugging-port=0 about:blank
CDP: Emulation.setDeviceMetricsOverride width=1366 height=900 deviceScaleFactor=1
页面: file:///D:/aboutAI/dsh-orchestra/node_modules/.cache/dsh-visual-check/panel.html
原始测量: {"label":"t+2000ms","innerWidth":1366,"innerHeight":900,"devicePixelRatio":1,"scrollWidth":1366,"clientWidth":1366,"bodyScrollWidth":1366,"noHorizontalOverflow":true,"rootScrollWidth":1366,"rootClientWidth":1366,"offenders":[],"fonts":{"min":12,"minText":"工作区","below12":[],"histogram":{"12":12,"13":10,"14":4,"16":4,"24":1}},"navFontSize":13,"headerFontSize":13,"longTitle":{"found":true,"titleAttributeLength":74,"textLength":74,"textMatchesTitle":true,"textOverflow":"ellipsis","overflow":"hidden","whiteSpace":"nowrap","renderedWidth":1028,"scrollWidth":1114,"clientWidth":1028,"truncated":true},"appFontSize":14,"appBackground":"rgb(255, 255, 255)","bodyBackground":"rgb(255, 255, 255)","sidebarColors":[{"tag":"BUTTON","background":"rgb(233, 237, 242)","rgb":{"r":233,"g":237,"b":242,"max":242,"min":233,"delta":9},"delta":9}],"navLabels":["任务","等你决定","待核实","流程","记忆","设置"],"mainPresent":true}
  [通过] G0-面板已渲染 —— main 存在
  [通过] G1-视口尺寸精确 —— 实测 1366×900，目标 1366×900
  [通过] G2-无横向溢出 —— documentElement.scrollWidth 1366 vs clientWidth 1366；根容器 scrollWidth/clientWidth 1366/1366；越界元素 []
  [通过] G3-正文基础字号≥13px —— 面板根容器计算字号 14px
  [通过] G4-辅助文字≥12px —— 渲染文本最小 12px（工作区）；小于 12px 的元素 []
  [通过] G5-菜单与顶导≥12.5px —— 左侧菜单 13px，顶部导航 13px
  [通过] G6-长标题截断且 title 承载全文 —— title 74 字 / 文本 74 字，一致=true；text-overflow=ellipsis，overflow=hidden，white-space=nowrap；本视口是否被截断=true
  [通过] G7-浅色底不用黑色 —— 面板底色 rgb(255, 255, 255)，页面底色 rgb(255, 255, 255)
  [通过] G8-菜单无装饰性彩条 —— 侧栏元素底色最大通道差 9（阈值 40）；[{"tag":"BUTTON","background":"rgb(233, 237, 242)","rgb":{"r":233,"g":237,"b":242,"max":242,"min":233,"delta":9},"delta":9}]
  [通过] G9-页面无运行时错误 —— 无 console error / uncaught
判定: 通过

结论: 两个视口都通过（scrollWidth <= clientWidth，且视口尺寸与目标一致）
保留工作目录: D:\aboutAI\dsh-orchestra\node_modules\.cache\dsh-visual-check

（exit code 0）
```

关键数字摘录（全部来自上面的原始测量）：

| 视口 | innerWidth×innerHeight | documentElement scrollWidth / clientWidth | 根容器 scrollWidth / clientWidth | 越界元素 | 长标题是否被截断 |
| --- | --- | --- | --- | --- | --- |
| 1600×1000 | 1600×1000 | 1600 / 1600 | 1600 / 1600 | 0 | false（宽度富余，未触发截断） |
| 1366×900 | 1366×900 | 1366 / 1366 | 1366 / 1366 | 0 | true（scrollWidth 1114 > clientWidth 1028） |

字号实测（两个视口一致）：面板根容器 14px；左侧菜单 13px；顶部导航 13px；渲染文本最小 12px（文案「工作区」）；<12px 元素 0 个；字号分布 {12:12, 13:10, 14:4, 16:4, 24:1}。

### 3.3 首跑失败与修复记录（供复现参考）

首跑（同一脚本、修复前）判定为「未通过」，退出码 1，原始测量：

```
1600×1000: {"innerWidth":1600,"innerHeight":1000,"scrollWidth":1714,"clientWidth":1585,"noHorizontalOverflow":false,"rootScrollWidth":1585,"rootClientWidth":1585,"offenders":[],"bodyScrollWidth":1714}
1366×900: {"innerWidth":1366,"innerHeight":900,"scrollWidth":1705,"clientWidth":1351,"noHorizontalOverflow":false,"rootScrollWidth":1351,"rootClientWidth":1351,"offenders":[]}
```

原因：撑宽 body 的是测量工具自身的 `<div id="visual-result">` 里那段无空格 JSON 文本，不是面板——证据是根容器 `rootScrollWidth == rootClientWidth` 且越界元素列表为空。修复：给 `#visual-result` 加 `display:none`（`textContent` 仍可读，不参与布局）。另外首跑时 tsdown 误加载了仓库 `tsdown.config.ts` 导致构建两遍、React 一度被外部化；修复：构建时 `config: false`。侧栏饱和色判定首跑误报（正则转义在模板字面量里被吃掉）；修复：页面只报 RGB 通道差原始数值，判定放到 Node 侧（阈值 40）。

## 4. 交付物与入口

| 文件 | 作用 |
| --- | --- |
| `src/client/panel/settings-screen.tsx` | 设置屏：服务连接、协议一致性、快照新鲜度、事件流状态、当前阶段、面板版本；任一项取不到就显示「未知」，不编造 |
| `src/client/panel-host.tsx` | 宿主正式入口：`createPanelHost(options)` 返回一个可直接渲染的组件，内部组装 `ApiClient` + `createConnectedEventStream` + `PanelApp`，外部一行接入；`src/index.ts` 未被改动 |
| `tests/client/panel-visual.spec.tsx` | 5 条静态硬门槛 + 字号实测 + 设置屏真实态 + 宿主集成，共 9 例 |
| `scripts/visual-check.mjs` | 无头 Chrome 两视口实测；退出码 0=全通过 / 1=有视口未通过 / 2=环境不可用 |
| `docs/reviews/S5-visual-gate.md` | 本报告 |

## 5. 未覆盖项、未能确认项与风险

未能确认（本次未测，不能据此判通过）：

1. **对比度未在浏览器里实测**。§8.6 的 4.5:1 / 3:1 只在静态层用 `src/client/panel/contrast.ts` 的 `contrastRatio()` 对 `TEXT_PAIRS` 6 项实算通过；页面里 `--bg`/`--fg` 之外的半透明叠层、渐变、禁用态、hover/active 态的实际像素对比度未做逐像素采样。
2. **未覆盖非默认路由的视觉**。实测与静态渲染断言都走默认「任务」页；「等你决定」「待核实」「流程」「记忆」「设置」页的横向溢出与长标题截断未实测（`PanelApp` 对未接真实数据的路由会显示占位文案）。
3. **未覆盖深色/高对比主题**。本面板目前只有浅色主题，未验证主题切换后的浅色无黑底门槛。
4. **未覆盖浏览器缩放、字体回退与系统字号放大**（如 Windows 显示缩放 125%／150%）。
5. **未覆盖真实后端数据**。实测用 stub `fetch` 返回固定 JSON，`/health` 的 `phase=S5`、`epoch=7` 是构造值；真实服务返回不同 phase 时的设置屏显示未验证。
6. **未覆盖长标题在「详情」页标题栏的截断**，只验证了任务列表行标题。
7. **未做信息密度与「默认视图不出现 session_id/agent_id/node_run_id/event_id/batch_id」的浏览器实测**（该条在静态层由计划 Task7 的其它测试覆盖，本任务边界内未重复）。

风险：

1. **字号字面量是棘轮而不是清零**。`src/client/panel/**` 里仍有 15 处历史字面量（决策收件箱、记忆面板、流程画布/编辑器/列表、任务详情、任务列表、外壳品牌字），它们都 ≥13px，不违反 §8.6 的字号下限，但违反「字号一律取自 tokens.ts」这一约定。这些文件在禁改边界内，只能钉死清单阻止增长，清理需要单独一轮。
2. **React 警告：`font` 简写与 `fontWeight` 混用**（`src/client/panel/shell.tsx:80` 附近的导航按钮样式在激活态切换时重渲染触发）。只影响样式一致性、不影响任何门槛判定，但属真实缺陷，修复需改 `shell.tsx`，在本任务禁改边界内，未处理。
3. **脚本依赖 tsdown 的 iife 打包结果**，构建产物落在 `node_modules/.cache/dsh-visual-check/`（非仓库文件）。若将来 tsdown 产物结构变化，脚本会以退出码 2 明确报错，不会静默通过。
4. **脚本只在 Chrome 上实测过**，Edge（157.0.4341.60）可用但本次未跑；可用 `DSH_VISUAL_BROWSER` 环境变量切换浏览器。
5. **`src/client/panel/app.tsx` 正在被他人修改**（不在本任务边界）。本次设置屏通过 `additionalScreens` 注入，宿主与设置屏不依赖该文件的内部实现，但若后续 `PanelApp` 的 props 契约变化，`src/client/panel-host.tsx` 需要同步调整。
