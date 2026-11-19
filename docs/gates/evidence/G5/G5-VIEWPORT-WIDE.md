# G5 门证据：G5-VIEWPORT-WIDE — 面板在 1600×1000 视口无横向溢出

- 编号：G5-VIEWPORT-WIDE
- 判定语：面板在 1600×1000 视口无横向溢出
- 证明用例：node scripts/visual-check.mjs
- 复现命令：node scripts/visual-check.mjs
- 结果：通过（退出码 0）
- 生成：scripts/gen-g5-evidence.ts（就绪矩阵 docs/reviews/S5-g5-item-map.md）

## 输出摘录

```text
== S5-J 视觉门槛实测（无头 Chrome，两个视口） ==
工作目录: D:\aboutAI\dsh-orchestra\node_modules\.cache\dsh-visual-check-et9axw
浏览器: C:\Program Files\Google\Chrome\Application\chrome.exe
ℹ entry: node_modules\.cache\dsh-visual-check-et9axw\entry.tsx
ℹ target: es2020
ℹ tsconfig: tsconfig.json
ℹ Build start
ℹ Hint: consider adding deps.onlyBundle option to avoid unintended bundling of dependencies, or set deps.onlyBundle: false to disable this hint.
See more at https://tsdown.dev/options/dependencies#deps-onlybundle
Detected dependencies in bundle:
- react
- scheduler
- react-dom
ℹ node_modules\.cache\dsh-visual-check-et9axw\panel.bundle.js  659.52 kB │ gzip: 145.97 kB
ℹ 1 files, total: 659.52 kB
✔ Build complete in 86ms
构建: tsdown -> D:\aboutAI\dsh-orchestra\node_modules\.cache\dsh-visual-check-et9axw\panel.bundle.js (659517 bytes)
页面: D:\aboutAI\dsh-orchestra\node_modules\.cache\dsh-visual-check-et9axw\panel.html

---- 视口 1600x1000 ----
命令: C:\Program Files\Google\Chrome\Application\chrome.exe --headless --disable-gpu --no-first-run --no-default-browser-check --disable-extensions --disable-background-networking --disable-component-update --disable-sync --metrics-recording-only --user-data-dir=D:\aboutAI\dsh-orchestra\node_modules\.cache\dsh-visual-check-et9axw\profile-1600x1000-NImHOL --remote-debugging-port=0 about:blank
CDP: Emulation.setDeviceMetricsOverride width=1600 height=1000 deviceScaleFactor=1
页面: file:///D:/aboutAI/dsh-orchestra/node_modules/.cache/dsh-visual-check-et9axw/panel.html
原始测量: {"label":"t+2000ms","innerWidth":1600,"innerHeight":1000,"devicePixelRatio":1,"scrollWidth":1600,"clientWidth":1600,"bodyScrollWidth":1600,"noHorizontalOverflow":true,"rootScrollWidth":1600,"rootClientWidth":1600,"offenders":[],"fonts":{"min":12,"minText":"0","below12":[],"histogram":{"12":22,"13":50,"14":11,"16":1,"24":1,"13.3333":2}},"navFontSize":13,"headerFontSize":13,"longTitle":{"found":true,"titleAttributeLength":74,"textLength":74,"textMatchesTitle":true,"textOverflow":"ellipsis","overflow":"hidden","whiteSpace":"nowrap","renderedWidth":276,"scrollWidth":971,"clientWidth":276,"truncated":true},"appFontSize":14,"appBackground":"rgb(255, 255, 255)","bodyBackground":"rgb(255, 255, 255)","sidebarColors":[{"tag":"BUTTON","background":"rgb(233, 237, 242)","rgb":{"r":233,"g":237,"b":242,"max":242,"min":233,"delta":9},"delta":9}],"navLabels":["总览","任务","审批中心","操作核验","Workflow 管理","事件日志","记忆","设置"],"mainPresent":true}
  [通过] G0-面板已渲染 —— main 存在
  [通过] G1-视口尺寸精确 —— 实测 1600×1000，目标 1600×1000
  [通过] G2-无横向溢出 —— documentElement.scrollWidth 1600 vs clientWidth 1600；根容器 scrollWidth/clientWidth 1600/1600；越界元素 []
  [通过] G3-正文基础字号≥13px —— 面板根容器计算字号 14px
  [通过] G4-辅助文字≥12px —— 渲染文本最小 12px（0）；小于 12px 的元素 []
  [通过] G5-菜单与顶导≥12.5px —— 左侧菜单 13px，顶部导航 13px
  [通过] G6-长标题截断且 title 承载全文 —— title 74 字 / 文本 74 字，一致=true；text-overflow=ellipsis，overflow=hidden，white-space=nowrap；本视口是否被截断=true
  [通过] G7-浅色底不用黑色 —— 面板底色 rgb(255, 255, 255)，页面底色 rgb(255, 255, 255)
  [通过] G8-菜单无装饰性彩条 —— 侧栏元素底色最大通道差 9（阈值 40）；[{"tag":"BUTTON","background":"rgb(233, 237, 242)","rgb":{"r":233,"g":237,"b":242,"max":242,"min":233,"delta":9},"delta":9}]
  [通过] G9-页面无运行时错误 —— 无 console error / uncaught
判定: 通过

---- 视口 1366x900 ----
命令: C:\Program Files\Google\Chrome\Application\chrome.exe --headless --disable-gpu --no-first-run --no-default-browser-check --disable-extensions --disable-background-networking --disable-component-update --disable-sync --metrics-recording-only --user-data-dir=D:\aboutAI\dsh-orchestra\node_modules\.cache\dsh-visual-check-et9axw\profile-1366x900-wKS07p --remote-debugging-port=0 about:blank
CDP: Emulation.setDeviceMetricsOverride width=1366 height=900 deviceScaleFactor=1
页面: file:///D:/aboutAI/dsh-orchestra/node_modules/.cache/dsh-visual-check-et9axw/panel.html
原始测量: {"label":"t+2000ms","innerWidth":1366,"innerHeight":900,"devicePixelRatio":1,"scrollWidth":1366,"clientWidth":1366,"bodyScrollWidth":1366,"noHorizontalOverflow":true,"rootScrollWidth":1366,"rootClientWidt
…（输出已截断）
```
