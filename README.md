<div align="center">

# 🍅 番茄钟

**专注时，光点向你汇聚；休息时，落叶被风吹散。**

零依赖 · 零构建 · 双击即用

![dependencies](https://img.shields.io/badge/dependencies-0-3fb950?style=flat-square)
![vanilla](https://img.shields.io/badge/vanilla-JS-f7df1e?style=flat-square&logo=javascript&logoColor=black)
![build](https://img.shields.io/badge/build-not%20required-58a6ff?style=flat-square)
![source](https://img.shields.io/badge/source-4%20files-8957e5?style=flat-square)

</div>

---

## ✨ 为什么值得一看

大多数番茄钟只是「一个倒计时」。这个不太一样 —— 它把**时间的流逝画成了看得见的东西**。

| 状态 | 画面 |
|---|---|
| 🔥 **专注** | 白色光点从四周沿直线向圆环汇聚，越靠近中心越快 —— 时间在「被吸走」 |
| 🍃 **休息** | 绿色叶片被风吹着飘落、翻面、打转，风本身还有阵性的起伏 |
| ⏸️ **暂停** | 汇聚与风立刻停住，只留下极慢的自转 —— 粒子像悬在半空，而不是卡死 |
| 🖱️ **鼠标** | 暂停时指针把光点拨开、移开自动弹回；休息时指针是一阵风，把叶片旋开 |

专注与休息之间，**配色、背景渐变、粒子**整套一起换，用 0.7 秒交叉淡化过渡，不是硬切。

---

## 🎯 功能

### 计时

- **可调时间流速 1×–100×** —— 拉到 100× 时，25 分钟的专注只需 15 秒跑完。演示、验证、赶进度都不用真的坐等半小时
- 专注 / 休息自动接力，结束时用 Web Audio **现场合成**提示音（专注结束是两声上扬短音，休息结束是一声低沉长音），仓库里没有任何音频文件
- 一键静音，开始 / 暂停 / 继续 / 重置即时生效
- 圆环进度条由 `conic-gradient` 加双层 `mask` 实现，每个 tick 只写一个 CSS 变量

### 主题

- **深色 / 浅色双主题**，首次打开跟随系统设置，手动切换后记住你的选择
- 首屏**防闪烁**：主题在样式表之前同步写入，浅色用户不会先看到一帧深色
- 粒子的配色也跟着主题走 —— 浅色底上白色光点等于隐形，所以换成暖橙

### 统计

- **今日完成次数**，只统计跑完的专注轮次，休息结束不计
- 存在 localStorage，按本地日期，跨天自动归零

### 细节

- 尊重 `prefers-reduced-motion`：开启后不启动动画循环，只渲染一帧静态画面
- localStorage 读写全部降级处理，隐私模式下静默可用，不会白屏
- 键盘可达：`Esc` 关闭流速面板，所有按钮都有 `focus-visible` 描边和 aria 标签

---

## 🚀 快速开始

不需要安装任何东西。

```bash
git clone https://github.com/demario1201-creator/TomatoClock.git
cd TomatoClock
open index.html          # macOS；Windows 直接双击 index.html
```

想跑本地服务器（例如完整验证 localStorage 行为）：

```bash
python3 -m http.server 8000
# 然后打开 http://localhost:8000
```

---

## 🕹️ 操作

| 控件 | 说明 |
|---|---|
| **开始 / 暂停 / 继续** | 主按钮，文案随状态自动变化 |
| **重置** | 回到 25:00 的专注初始态，流速一并归 1× |
| **🔔 / 🔕** | 开关提示音 |
| **☀️ / 🌙** | 切换深色 / 浅色主题（固定在右上角） |
| **设置流速** | 滑块无级调节，或点 1× / 2× / 5× / 10× / 100× 预设 |
| **今日完成 N 个番茄** | 底部显示当天跑完的专注轮次 |

---

## 📁 项目结构

```
番茄钟/
├── index.html      结构 + 首屏防闪烁内联脚本
├── style.css       主题变量、圆环 mask、布局
├── background.js   canvas 粒子系统
└── script.js       计时逻辑 + 音效 + 主题 + 统计
```

四个文件，没有 `package.json`、没有 `node_modules`、没有构建步骤。

---

## 🔧 技术要点

- **计时模型是「真实时间差 × 倍率」，不是 deadline。** 倍率随时可改，后台标签页被浏览器节流也不会走慢 —— 降频只影响刷新率，不影响累计时间
- **`background.js` 完全不知道计时器的存在**，只接收 `setTimerState({ phase, isRunning, speed })`，两套逻辑互不耦合
- **粒子数组逐帧原地压缩复用**，而不是每帧重建，避免 60fps 下持续产生垃圾对象
- **圆环的渐变是静止的**，「挖空中心」和「截断弧段」都交给 `mask` 做交集，JS 每个 tick 只改 `--angle` 一个变量

---

## 🌐 浏览器支持

现代版本的 Chrome / Edge / Safari / Firefox。

唯一有跨浏览器风险的地方是圆环的 `mask-composite`（需要同时写标准与 `-webkit-` 两套关键字）。降级表现是「圆环不消失」—— 明显可见，不会静默出错。

---

## 📝 说明

第 8 周训练营的练习作品，刻意保持简单：不登录、不接数据库、不做后端、不引入构建工具和第三方依赖。需要持久化的东西一律走 localStorage。

复杂度本身就是成本，所以这里没有的东西，多半是**故意**没有的。
