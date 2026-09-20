# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目性质

番茄钟静态网页，第 8 周训练营练习。**无构建工具、无第三方依赖、无 `package.json`、无音频文件、非 git 仓库**。双击 [index.html](index.html) 即可在浏览器打开。

## 项目规则（改动前先读这一节）

**1. 保持单页应用，不引入当前不需要的功能。**
不登录、不接数据库、不做后端、不引入构建工具或依赖。需要持久化的东西一律走 localStorage（见「主题与存储」）。新增功能前先确认它真的被需要 —— 这个项目是练习作品，复杂度本身就是成本。

**2. 专注与休息时长集中配置，不把时间数字散落到其他文件。**
`DURATIONS_MS`（[script.js](script.js) 顶部）是**唯一**的时长来源，`createInitialState`、`tick`、`toRingAngle`、`toggleButtonLabel` 都从它派生。改时长只改这一处。

> 已知例外：[index.html](index.html) 里 `<span id="time">25:00</span>` 是 JS 执行前的占位文本，与 `DURATIONS_MS` 重复。改时长时**必须一并改它**，否则首屏会闪一下旧的时长。
>
> 它是 `defer` 脚本运行前的兜底，删掉就会在 JS 执行前显示空白。要消掉这处重复，得让 `render()` 在首屏之前就把值写进去（例如放弃 `defer`、或改成输出时就生成 HTML）—— 属于结构改动，别顺手做。

**3. 改 UI 不碰计时逻辑。**
样式与布局的改动只应落在 `style.css` 和 `index.html` 的结构上，**不应要求修改 [script.js](script.js) 的纯逻辑层**。`render()` 只负责把 state 映射成 DOM 写入，它和 CSS 之间唯一的契约是 `--angle` 这一个变量（以及 `body` 上的 `is-focus` / `is-rest` 两个类）。若某个 UI 改动看起来需要动 `advance` / `tick` / `setSpeed`，那是方案走错了方向，先停下来重新想。

**4. 每次改完功能，实际跑一遍开始 / 暂停 / 重置。**
两条都要做，缺一不可：

```bash
node /tmp/pomodoro-check.js     # 纯逻辑：55 项断言覆盖开始、暂停、重置、阶段切换、倍率结算
agent-browser screenshot ...    # 真实浏览器：确认按钮接线与视觉真的对
```

纯逻辑测试**测不到 DOM 接线**，而接线恰恰出过真 bug（提示音按新阶段而非刚结束的阶段选音色）。所以只跑测试不算验证过 —— 必须真的在浏览器里点一遍「开始 → 暂停 → 继续 → 重置」，确认数字、圆环、按钮文案、背景粒子四者都对得上。

## 常用命令

```bash
# 打开页面
open index.html

# 纯逻辑层单元测试（55 项断言）
node /tmp/pomodoro-check.js

# 浏览器实测（截图、eval、模拟媒体特性）
agent-browser screenshot <file>
```

**测试脚本在 `/tmp/pomodoro-check.js`，不在仓库里** —— 它不受本目录的改动影响，但会在 `script.js` 新增顶层浏览器 API 调用时失效。它用 `vm.runInContext` 加载 `script.js` 并 stub 全局对象，`script.js` 顶层每多读一个浏览器 API，就要在它的 `context` 里补一个 stub（最近一次是主题层引入的 `window.matchMedia`）。

## 文件结构与加载顺序

四个文件，全部是 **classic script（非 ES module）**：

```
index.html    结构 + 首屏防闪烁内联脚本
style.css     主题变量、圆环 mask、布局、面板
background.js canvas 粒子系统（IIFE）
script.js     计时逻辑 + 音效 + 主题 + 统计 + DOM 绑定
```

加载顺序有依赖：内联脚本（同步，定主题）→ `style.css` → `background.js`（defer）→ `script.js`（defer）。`script.js` 的 `init()` 读 `window.PomodoroBackground`，所以 `background.js` 必须排在前面。

**classic script 的顶层 `const` 会落进所有脚本共享的 script 作用域** —— 这正是 `background.js` 整体包在 IIFE 里的原因（否则 `MODES`、`SPARK` 等会和 `script.js` 撞名）。新增脚本文件同样要包。

## script.js 的分层

自上而下四段，按依赖顺序排列：

| 层 | 职责 | 约束 |
|---|---|---|
| 纯逻辑层 | `advance` / `tick` / `setSpeed` / `formatTime` / `toRingAngle` … | 不碰 DOM，时间由 `now` 参数传入，**返回新对象不改传入 state** |
| 音效层 | Web Audio 合成提示音 | 无音频文件 |
| 主题层 + 今日统计 | localStorage 读写 | 全部 try/catch 降级 |
| 渲染层 + `init()` | DOM 缓存、`render()`、事件绑定 | `render()` 有去重 |

### 三条不可违反的约束

**1. 计时模型是「剩余虚拟时间 × 倍率」，不能改成 deadline 模型。**
最直觉的 `deadline = Date.now() + remainingMs` 写法在有倍率时会失效 —— 倍率一变，算好的 deadline 就不再成立。`advance()` 用 `(now - lastTickAt) * state.speed`，既让后台标签页节流不导致走慢（降频只影响刷新率），又让倍率随时可改。

**2. 运行中改倍率必须先按旧倍率结算再写入新倍率。**
`setSpeed()` 第一行是 `advance(state, now)`。若直接 `{ ...state, speed }`，`now - lastTickAt` 这段本该按旧倍率算的时间会被追溯性地按新倍率重算 —— 从 1× 拖到 100× 会瞬间掉掉一大截时间。这是本项目最容易踩的坑，已有测试锁定。

**3. `tick()` 一次最多切换一个阶段。**
兜底标签页被冻结很久、或倍率极高时单次步进跨越整个阶段。另外 `tick()` 返回的是 `endedPhase`（**刚结束**的阶段），不是 `state.phase`（已是新阶段）—— 提示音按前者选音色，统计按前者判断是否计数。

## 圆环进度条

JS 每个 tick 只写一个 CSS 变量 `--angle`（360deg 满 → 0deg 空）。

渐变**静止**（颜色锚定在绝对角度），「挖空中心」和「截断弧段」都由 `mask` 做交集：`mask-composite: intersect` 与 `-webkit-mask-composite: source-in` 是两套关键字，**必须各写一遍**。这是全项目唯一的跨浏览器风险点，降级表现是「圆环不消失」——明显错误而非静默错误。

## 背景粒子系统

**职责分离**：两套 CSS 径向渐变层靠 `opacity` 交叉淡化（GPU 合成、零 JS），canvas 只画粒子。`background.js` 的 `TRANSITION_SECONDS` 必须与 `style.css` 里 `.bg-layer` 的 `transition: opacity` 时长保持一致。

**两种运动分开控制**，这是「粒子随进度条同步」的核心：
- `motionFactor` —— **定向**运动（粒子汇聚、风、下落）。暂停时为 0，即「立刻悬浮」。暂停状态是在按钮回调里同步传进 `setTimerState` 的，所以不走阶段切换那套 0.7 秒渐变。
- `spinFactor` —— **环境**运动（叶片自转、翻面、摆动）。暂停时保留 `PAUSED_SPIN_PORTION`（0.3），完全停住会像卡死。

倍率用**幂函数压缩**：`speed^0.4`（粒子）/ `speed^0.25`（叶片自转）。线性映射会让 100× 糊成一片。改这两个常量即调整高倍率下的观感。

**其他要点**：
- 粒子数组是复用的渲染缓冲，逐帧**原地压缩**（read/write 双指针）而非重建，避免 60fps 下持续产生垃圾。
- 汇聚中心来自 `script.js` 传入的 `getCenter` 回调（`background.js` 不认识 DOM）。帧循环里节流到 250ms 轮询，**不用 `ResizeObserver`** —— 圆环尺寸固定，换行/缩放只会改变它的**位置**。
- 粒子淡出区锚定到**圆环半径**而非 `maxRadius`。用固定比例会在窄视口下（圆环相对变大）让淡出区整个落进圆环内部，粒子在中心堆成团块。
- `prefers-reduced-motion: reduce` 下**不启动 rAF**，只画一帧静态画面。因此 `setTimerState()` / `setTheme()` 在该模式下必须手动调 `draw()`。
- 主题必须在 `create()` 时就传入：粒子的配色画在 canvas 上，拿不到 CSS 变量，建好后再改会闪一帧旧配色。

## 主题与存储

- `data-theme` 挂在 `<html>` 上，由 `index.html` 的**内联脚本在样式表之前同步写入**（防首屏闪烁）。该脚本里的 `'pomodoro.theme'` 与 `script.js` 的 `THEME_STORAGE_KEY` 是硬编码重复，**改动必须同步两处**。
- 两个维度**正交**：`data-theme` 管明暗，`body.is-focus` / `body.is-rest` 管阶段配色。浅色下阶段色需要单独一套深一档的值，否则亮色铺浅底会糊成一片。
- 主题切换按钮的图标由 CSS `::before` 出（JS 不写 `textContent`），否则首屏会先渲染空按钮再被补上。
- localStorage 两个键：`pomodoro.theme`、`pomodoro.stats`（只存 `{ date, count }`，按**本地**日期，跨天或换时区读到旧日期即归零）。全部包在 try/catch 里，隐私模式下静默降级。
- 只有**专注**跑完才计入「今日完成」，休息结束不计数。

## 验证注意事项

这些是本项目实测踩过的坑，不是通用建议：

- **headless Chrome 抓不到 GPU 加速的 canvas 图层**。`Page.captureScreenshot` 会得到空图，跨任务 `getImageData` 返回 0 个点亮像素 —— 这是验证工具伪影，不是应用 bug（同任务内回读是有效的）。绕过办法：给 `clearRect` 打补丁，在其后 `queueMicrotask(() => canvas.toDataURL())` 存下帧，再注入一个 `position:fixed` 的 `<img>` 覆盖层去截图。
- **粒子运动的速度指标必须用足够短的时间窗逐帧比较**。稳态下粒子的空间分布与速度**无关**（速度只改变时间尺度），所以任何瞬时空间指标都区分不出倍率。窗口太长（≥300ms）时 1× 和 100× 双双饱和，也测不出差异。
- `agent-browser set viewport` 需要 reload 才生效，逐条独立执行。
- **Safari 无法自动化验证**（机器上只有 Chrome 和 lightpanda 引擎）。`-webkit-mask-composite` 与 canvas 动画需在 Safari 里手动检查 —— 这一点至今未做。
