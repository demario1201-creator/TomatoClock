'use strict';

/*
  背景粒子系统。

  与计时器逻辑解耦 —— 它不认识计时器的 state，只暴露一个
  setTimerState({ phase, isRunning, speed })。
  整体包在 IIFE 里：classic script 的顶层 const 会落进所有脚本共享的
  script 作用域，不隔离就会和 script.js 的同名声明撞车。

  专注：白色粒子沿直线向圆环中心汇聚
  休息：绿色叶片被风吹拂
*/

(function () {
  /* ==================== 常量 ==================== */

  const MODES = { FOCUS: 'focus', REST: 'rest' };
  const KINDS = { SPARK: 'spark', LEAF: 'leaf' };
  const MODE_KIND = { [MODES.FOCUS]: KINDS.SPARK, [MODES.REST]: KINDS.LEAF };

  /*
    粒子的颜色画在 canvas 上，拿不到 CSS 变量，所以主题得单独给一份。
    深色下用白光晕；浅色底上白光等于隐形，换成专注色的暖橙。
    叶子同理：浅底上要把明度压深一档才看得出来。
  */
  const THEMES = {
    dark: { sparkColor: '255, 255, 255', leafLightness: [38, 58] },
    light: { sparkColor: '234, 88, 12', leafLightness: [30, 46] },
  };

  function resolveTheme(value) {
    return value === 'light' ? 'light' : 'dark';
  }

  const MAX_DPR = 2; // 3x 屏上全屏 canvas 的像素量翻倍，收益却看不出来
  const MAX_FRAME_SECONDS = 0.05; // 标签页切回来时不让粒子瞬移
  const CENTER_POLL_SECONDS = 0.25; // 圆环位置会因换行/缩放而变，但不必每帧读
  const TRANSITION_SECONDS = 0.7; // 与 style.css 里渐变层的过渡时长保持一致
  const RESIZE_DEBOUNCE_MS = 120;
  const GLOW_SPRITE_SIZE = 64;

  // 倍率 1×～100× 不能线性映射到粒子速度，否则 100× 下会糊成一片。
  // 用幂函数压缩：专注粒子 100× → 约 6.3 倍，叶片自转压得更狠。
  const SPARK_SPEED_EXPONENT = 0.4;
  const LEAF_SPIN_SPEED_EXPONENT = 0.25;
  const PAUSED_SPIN_PORTION = 0.3; // 悬浮时保留的自转/翻面比例，完全停住会像卡死

  // 粒子在圆环边缘被「吸收」：淡出区锚定到圆环半径而非 maxRadius。
  // 用固定比例会因为视口变窄时圆环相对变大，导致淡出区整个落进圆环内部，
  // 粒子在中心堆成团块。
  const FOCUS_FADE_RADIUS_FACTOR = 1.8; // 淡出起点 = 圆环半径 × 此系数
  const FOCUS_FADE_MAX_PORTION = 0.55; // 但不超出 maxRadius 的这个比例
  const FOCUS_DEFAULT_ABSORB_PORTION = 0.2; // getCenter 未提供半径时的兜底
  const FOCUS_ABSORB_MIN_RADIUS = 2;

  /*
    鼠标交互。只在「静止状态」或「休息模式」下生效 ——
    专注计时中不打扰，这也是需求里点名的两个场景。
  */
  const POINTER = {
    followTau: 0.07, // 指针位置平滑的时间常数（秒），滤掉高刷鼠标的逐帧抖动
    // 休息模式：指针附近形成一阵风，把叶片朝外卷开
    leafRadius: 160,
    leafPush: 620, // px/s，叶片被吹开的瞬时速度
    leafSwirl: 0.4, // 切向分量占比，让叶片旋开而不是沿半径直线弹开
    // 静止状态：指针把悬浮的粒子拨开，移开后它们自己弹回
    sparkRadius: 170,
    sparkPush: 320, // px/s，位移的累积速度
    sparkMaxOffset: 48, // px，位移上限，防止指针停住时把粒子顶飞
    sparkSettleTau: 0.2, // 回位的时间常数（秒）
  };

  const SPARK = {
    count: 120,
    spawnPerFrame: 4,
    minSpeed: 34, // px/s（最外圈）
    maxSpeed: 58,
    acceleration: 1.8, // 越靠近中心越快，强化被吸入的感觉
    fadeInPortion: 0.12, // 外缘 12% 淡入，避免在边界凭空出现一圈
    maxDriftSpeed: 14, // px/s，悬浮时的切向漂移速度。给线速度而非角速度，
    //                    否则外围粒子的线速度会与半径成正比，快到不像悬浮
    minSize: 2,
    maxSize: 5.5,
    minAlpha: 0.35,
    maxAlpha: 0.9,
  };

  const LEAF = {
    count: 60, // 铺满全屏后的数量，太少会显得空
    spawnPerFrame: 3,
    minSize: 6,
    maxSize: 13,
    minFallSpeed: 10,
    maxFallSpeed: 26,
    windBase: 30,
    windGust: 26,
    gustFrequency: 0.32, // 每片叶子各自的相位 → 各飘各的
    breezeFrequency: 0.13, // 全局相位 → 整体的风阵起伏
    swayFrequency: 0.9,
    swayAmplitude: 6, // px/s，上下摆动的基准幅度
    minSpin: -1.2,
    maxSpin: 1.2,
    minFlutterSpeed: 0.8,
    maxFlutterSpeed: 2,
    minHue: 88,
    maxHue: 146,
    minSaturation: 40,
    maxSaturation: 62,
    // 明度不在这里写死，按主题取值（见 THEMES.leafLightness）
    veinColor: 'rgba(0, 0, 0, 0.2)',
  };

  /* ==================== 小工具 ==================== */

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  /* ==================== 发光精灵 ==================== */

  // 预生成一张主题色柔光图，之后每颗粒子用它缩放绘制。
  // 比 arc 画硬边圆点柔和得多，也比逐粒子 shadowBlur 快得多。
  function createGlowSprite(sparkColor) {
    const sprite = document.createElement('canvas');
    sprite.width = GLOW_SPRITE_SIZE;
    sprite.height = GLOW_SPRITE_SIZE;

    const spriteCtx = sprite.getContext('2d');
    if (!spriteCtx) return null;

    const half = GLOW_SPRITE_SIZE / 2;
    const gradient = spriteCtx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, `rgba(${sparkColor}, 1)`);
    gradient.addColorStop(0.35, `rgba(${sparkColor}, 0.85)`);
    gradient.addColorStop(0.7, `rgba(${sparkColor}, 0.22)`);
    gradient.addColorStop(1, `rgba(${sparkColor}, 0)`);

    spriteCtx.fillStyle = gradient;
    spriteCtx.fillRect(0, 0, GLOW_SPRITE_SIZE, GLOW_SPRITE_SIZE);
    return sprite;
  }

  /* ==================== 工厂 ==================== */

  function createBackground(canvas, options) {
    const opts = options || {};
    const getCenter = typeof opts.getCenter === 'function' ? opts.getCenter : null;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      console.warn('无法获取 canvas 2d 上下文，背景动画已停用');
      return { setTimerState() {}, setTheme() {}, destroy() {} };
    }

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    let glowSprite = null;
    let resizeTimerId = null;

    // 粒子数组是每帧复用的渲染缓冲，下面用原地压缩而非每帧重建，
    // 避免 60fps 下持续产生垃圾对象。
    const state = {
      width: 0,
      height: 0,
      center: { x: 0, y: 0 },
      maxRadius: 1,
      absorbRadius: 1, // 粒子在此半径处被吸收（圆环外缘）
      fadeStartRadius: 1, // 内从这个半径开始淡出
      mode: MODES.FOCUS,
      theme: resolveTheme(opts.theme),
      // 由计时器驱动的运动状态
      isRunning: false, // 初始为暂停，粒子悬浮
      speed: 1,
      motionFactor: 0, // 风、下落、汇聚等「定向」运动的速度系数，暂停为 0
      spinFactor: PAUSED_SPIN_PORTION, // 自转/翻面等「环境」运动的系数，暂停时保留一点
      // 鼠标交互：interactive 由计时器状态推出（暂停中 / 休息模式）
      interactive: true,
      pointer: { x: 0, y: 0, targetX: 0, targetY: 0, active: false },
      particles: [],
      elapsed: 0,
      lastFrameAt: 0,
      rafId: null,
      sinceCenterPoll: 0,
    };

    glowSprite = createGlowSprite(THEMES[state.theme].sparkColor);

    /* ---------- 尺寸与中心 ---------- */

    // 淡出区必须落在圆环之外，且不能超出粒子场本身
    function updateFadeRadii() {
      const fallback = state.maxRadius * FOCUS_DEFAULT_ABSORB_PORTION;
      state.absorbRadius = Math.max(FOCUS_ABSORB_MIN_RADIUS, state.ringRadius || fallback);

      state.fadeStartRadius = Math.max(
        state.absorbRadius + FOCUS_ABSORB_MIN_RADIUS,
        Math.min(
          state.absorbRadius * FOCUS_FADE_RADIUS_FACTOR,
          state.maxRadius * FOCUS_FADE_MAX_PORTION,
        ),
      );
    }

    function syncCenter() {
      if (!getCenter) {
        state.center = { x: state.width / 2, y: state.height / 2 };
        state.ringRadius = 0;
      } else {
        const center = getCenter();
        if (center) {
          state.center = { x: center.x, y: center.y };
          state.ringRadius = center.radius || 0;
        }
      }
      updateFadeRadii();
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

      state.width = width;
      state.height = height;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 之后一律用 CSS 像素坐标绘制

      syncCenter();

      state.maxRadius = Math.max(1, Math.hypot(
        Math.max(state.center.x, width - state.center.x),
        Math.max(state.center.y, height - state.center.y),
      ));
      updateFadeRadii(); // maxRadius 变了，淡出区要跟着重算

      // 半径超出新范围的粒子直接重生，否则缩小窗口后它们会挤在角落
      state.particles.forEach((particle) => {
        if (particle.kind === KINDS.SPARK && particle.radius > state.maxRadius) {
          resetSpark(particle, false);
        }
      });
    }

    function handleResize() {
      if (resizeTimerId !== null) window.clearTimeout(resizeTimerId);
      resizeTimerId = window.setTimeout(() => {
        resizeTimerId = null;
        resize();
        if (motionQuery.matches) draw();
      }, RESIZE_DEBOUNCE_MS);
    }

    /* ---------- 专注粒子 ---------- */

    function createSpark(spawnAnywhere) {
      const particle = { kind: KINDS.SPARK, fade: 0, x: 0, y: 0, alpha: 0, angle: 0,
                         radius: 0, speed: 0, size: 0, baseAlpha: 1,
                         // 每颗粒子有自己的飘移方向与速率，悬浮时才不会像整体刚性旋转
                         driftSpeed: randomBetween(-SPARK.maxDriftSpeed, SPARK.maxDriftSpeed),
                         // 静态交互：指针拨开产生的位移，移开后靠弹性回位
                         offsetX: 0, offsetY: 0 };
      resetSpark(particle, spawnAnywhere);
      return particle;
    }

    function resetSpark(particle, spawnAnywhere) {
      particle.angle = Math.random() * Math.PI * 2;
      // sqrt 让粒子均匀落在「面积」上；直接用 random 会全挤在中心
      const spread = spawnAnywhere ? Math.sqrt(Math.random()) : 1;
      particle.radius = Math.max(FOCUS_ABSORB_MIN_RADIUS, state.maxRadius * spread);
      particle.speed = randomBetween(SPARK.minSpeed, SPARK.maxSpeed);
      particle.size = randomBetween(SPARK.minSize, SPARK.maxSize);
      particle.baseAlpha = randomBetween(SPARK.minAlpha, SPARK.maxAlpha);
      particle.offsetX = 0;
      particle.offsetY = 0;
      updateSparkAlpha(particle);
    }

    // 透明度沿行程两段：外缘淡入、内侧淡出（淡到圆环边缘刚好为 0）
    function updateSparkAlpha(particle) {
      const progress = clamp01(1 - particle.radius / state.maxRadius);

      let fade = 1;
      if (progress < SPARK.fadeInPortion) {
        fade = progress / SPARK.fadeInPortion;
      }

      if (particle.radius < state.fadeStartRadius) {
        const span = state.fadeStartRadius - state.absorbRadius;
        const t = span > 0 ? (particle.radius - state.absorbRadius) / span : 0;
        fade *= clamp01(t) ** 2; // 平方：越贴近圆环衰减越快
      }

      particle.alpha = particle.baseAlpha * clamp01(fade);
    }

    function updateSpark(particle, dt) {
      const progress = clamp01(1 - particle.radius / state.maxRadius);
      const speedFactor = 1 + SPARK.acceleration * progress;

      // 悬浮时 motionFactor 为 0：只剩很慢的切向飘移，不再向内汇聚。
      // 暂停是在点击回调里同步生效的，所以是「立刻」停住而非渐变。
      // 除以半径 → 线速度恒定，外围粒子不会因为半径大而漂得飞快
      particle.angle += (particle.driftSpeed / Math.max(particle.radius, 1)) * dt;
      particle.radius -= particle.speed * speedFactor * state.motionFactor * dt;

      // 到达圆环边缘即视为被吸收，立刻从外缘重生，形成持续的向内流。
      // 悬浮时半径不再减小，自然不会触发。
      if (particle.radius <= state.absorbRadius) resetSpark(particle, false);

      updateSparkAlpha(particle);

      const baseX = state.center.x + Math.cos(particle.angle) * particle.radius;
      const baseY = state.center.y + Math.sin(particle.angle) * particle.radius;

      /*
        静态交互：粒子悬浮时指针在附近就把它往外拨，移开后再弹回原位。
        位移单独存 offsetX/offsetY，而不是去改 radius/angle —— 后者会被
        「半径触到圆环即吸收」的判定误读，把粒子直接重生掉。
        距离用未加偏移的基准位置算，力就不会和位移互相反馈。
      */
      if (state.pointer.active && state.interactive) {
        const dx = baseX - state.pointer.x;
        const dy = baseY - state.pointer.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < POINTER.sparkRadius && distance > 0.0001) {
          const falloff = 1 - distance / POINTER.sparkRadius;
          const force = POINTER.sparkPush * falloff * falloff * dt;
          particle.offsetX += (dx / distance) * force;
          particle.offsetY += (dy / distance) * force;

          // 位移封顶：指针停着不动时，粒子不会被越顶越远
          const offset = Math.hypot(particle.offsetX, particle.offsetY);
          if (offset > POINTER.sparkMaxOffset) {
            const scale = POINTER.sparkMaxOffset / offset;
            particle.offsetX *= scale;
            particle.offsetY *= scale;
          }
        }
      }

      const settle = Math.exp(-dt / POINTER.sparkSettleTau);
      particle.offsetX *= settle;
      particle.offsetY *= settle;

      particle.x = baseX + particle.offsetX;
      particle.y = baseY + particle.offsetY;
    }

    function drawSpark(particle) {
      const alpha = particle.alpha * particle.fade;
      if (alpha <= 0.01 || !glowSprite) return;

      const size = particle.size;
      ctx.globalAlpha = alpha;
      ctx.drawImage(glowSprite, particle.x - size, particle.y - size, size * 2, size * 2);
    }

    /* ---------- 休息粒子 ---------- */

    function createLeaf(spawnAnywhere) {
      const particle = { kind: KINDS.LEAF, fade: 0, x: 0, y: 0, size: 0,
                         rotation: 0, spin: 0, flutter: 0, flutterSpeed: 0,
                         gustPhase: 0, fallSpeed: 0, color: '' };
      resetLeaf(particle, spawnAnywhere);
      return particle;
    }

    function resetLeaf(particle, spawnAnywhere) {
      particle.size = randomBetween(LEAF.minSize, LEAF.maxSize);
      particle.rotation = Math.random() * Math.PI * 2;
      particle.spin = randomBetween(LEAF.minSpin, LEAF.maxSpin);
      particle.flutter = Math.random() * Math.PI * 2;
      particle.flutterSpeed = randomBetween(LEAF.minFlutterSpeed, LEAF.maxFlutterSpeed);
      particle.gustPhase = Math.random() * Math.PI * 2;
      particle.fallSpeed = randomBetween(LEAF.minFallSpeed, LEAF.maxFallSpeed);

      // 色相/饱和度固定，明度只记一个 0~1 的系数：
      // 这样切主题时不用重建粒子，重算一次 color 就行
      particle.hue = randomBetween(LEAF.minHue, LEAF.maxHue);
      particle.saturation = randomBetween(LEAF.minSaturation, LEAF.maxSaturation);
      particle.lightnessT = Math.random();
      particle.color = leafColor(particle);

      if (spawnAnywhere) {
        particle.x = Math.random() * state.width;
        particle.y = Math.random() * state.height;
      } else {
        particle.x = -particle.size * 2; // 风向右吹，新叶从左侧进场
        particle.y = Math.random() * state.height;
      }
    }

    // 明度按当前主题的取值范围插值，浅色主题整体压深一档
    function leafColor(particle) {
      const [minLightness, maxLightness] = THEMES[state.theme].leafLightness;
      const lightness = minLightness + (maxLightness - minLightness) * particle.lightnessT;
      return `hsl(${particle.hue.toFixed(0)}, ${particle.saturation.toFixed(0)}%, ${lightness.toFixed(0)}%)`;
    }

    // 每片叶子两个正弦叠加：自身相位 + 全局相位（整体风阵）
    function computeWind(particle) {
      const gust = Math.sin(state.elapsed * LEAF.gustFrequency + particle.gustPhase);
      const breeze = Math.sin(state.elapsed * LEAF.breezeFrequency);
      return LEAF.windBase + LEAF.windGust * (0.6 * gust + 0.4 * breeze);
    }

    function updateLeaf(particle, dt) {
      const motion = state.motionFactor; // 风与下落：暂停为 0
      const spin = state.spinFactor; // 自转与翻面：暂停时保留一部分
      const sway = Math.sin(state.elapsed * LEAF.swayFrequency + particle.gustPhase);

      // 风与下落：暂停时完全停止，叶子悬在半空不再被吹走
      particle.x += computeWind(particle) * motion * dt;
      particle.y += particle.fallSpeed * motion * dt;

      // 摆动、自转、翻面：悬浮时靠它们显出生气，否则像被冻住
      particle.y += sway * LEAF.swayAmplitude * spin * dt;
      particle.rotation += particle.spin * spin * dt;
      particle.flutter += particle.flutterSpeed * spin * dt;

      applyLeafGust(particle, dt);

      if (particle.x - particle.size > state.width) {
        particle.x = -particle.size;
        particle.y = Math.random() * state.height;
      } else if (particle.y - particle.size > state.height) {
        particle.y = -particle.size;
        particle.x = Math.random() * state.width;
      }
    }

    /*
      休息模式的鼠标交互：指针周围是一阵风，把叶片朝外卷开。

      用「直接位移」而不是速度累积 —— 叶片本来就是被风推着走的，
      指针移开后它自然会被风向带回原来的流向，不需要额外的回位逻辑。
      加一点切向分量（leafSwirl），叶片才是旋开而不是沿半径直线弹开。
    */
    function applyLeafGust(particle, dt) {
      if (!state.interactive || !state.pointer.active) return;

      const dx = particle.x - state.pointer.x;
      const dy = particle.y - state.pointer.y;
      const radius = POINTER.leafRadius;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq >= radius * radius) return;

      const distance = Math.max(Math.sqrt(distanceSq), 0.001);
      const falloff = 1 - distance / radius;
      const push = POINTER.leafPush * falloff * falloff * dt;
      const nx = dx / distance;
      const ny = dy / distance;

      particle.x += (nx - ny * POINTER.leafSwirl) * push;
      particle.y += (ny + nx * POINTER.leafSwirl) * push;
    }

    function drawLeaf(particle) {
      if (particle.fade <= 0.01) return;

      const size = particle.size;

      ctx.save();
      ctx.globalAlpha = particle.fade;
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.rotation);
      // 周期性水平压扁 —— 叶子「翻面侧过来」的关键
      ctx.scale(Math.cos(particle.flutter), 1);

      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.quadraticCurveTo(size * 0.85, 0, 0, size);
      ctx.quadraticCurveTo(-size * 0.85, 0, 0, -size);
      ctx.closePath();
      ctx.fill();

      ctx.beginPath();
      ctx.strokeStyle = LEAF.veinColor;
      ctx.lineWidth = Math.max(0.5, size * 0.08);
      ctx.moveTo(0, -size * 0.75);
      ctx.lineTo(0, size * 0.75);
      ctx.stroke();

      ctx.restore();
    }

    /* ---------- 粒子集合 ---------- */

    function targetCountFor(mode) {
      return MODE_KIND[mode] === KINDS.SPARK ? SPARK.count : LEAF.count;
    }

    function spawnPerFrameFor(mode) {
      return MODE_KIND[mode] === KINDS.SPARK ? SPARK.spawnPerFrame : LEAF.spawnPerFrame;
    }

    function createParticleFor(mode, spawnAnywhere) {
      return MODE_KIND[mode] === KINDS.SPARK
        ? createSpark(spawnAnywhere)
        : createLeaf(spawnAnywhere);
    }

    function updateParticles(dt) {
      const activeKind = MODE_KIND[state.mode];
      const particles = state.particles;
      let writeIndex = 0;

      for (let readIndex = 0; readIndex < particles.length; readIndex += 1) {
        const particle = particles[readIndex];

        if (particle.kind !== activeKind) {
          // 旧模式的粒子把自己正在做的动作做完，再淡出移除
          particle.fade -= dt / TRANSITION_SECONDS;
          if (particle.fade <= 0) continue;
        } else if (particle.fade < 1) {
          particle.fade = Math.min(1, particle.fade + dt / TRANSITION_SECONDS);
        }

        if (particle.kind === KINDS.SPARK) updateSpark(particle, dt);
        else updateLeaf(particle, dt);

        particles[writeIndex] = particle;
        writeIndex += 1;
      }
      particles.length = writeIndex;

      // 按帧逐步补充，避免新模式粒子一次性涌入
      let activeCount = 0;
      for (let i = 0; i < particles.length; i += 1) {
        if (particles[i].kind === activeKind) activeCount += 1;
      }

      const missing = targetCountFor(state.mode) - activeCount;
      const toSpawn = Math.min(missing, spawnPerFrameFor(state.mode));
      for (let i = 0; i < toSpawn; i += 1) {
        // 补齐时铺满全屏，而不是从边缘入场：叶片横向速度只有几十 px/s，
        // 若首批全从左缘进入，切换后右侧要空上几十秒。稳态下叶片靠环绕
        // 复用、不再新增，所以这里只影响阶段切换的填充过程。
        particles.push(createParticleFor(state.mode, true));
      }
    }

    // 首屏与「减少动态效果」模式用：一次性铺满，不做渐进淡入
    function fillParticlesImmediately() {
      const target = targetCountFor(state.mode);
      const particles = [];
      for (let i = 0; i < target; i += 1) {
        const particle = createParticleFor(state.mode, true);
        particle.fade = 1;
        particles.push(particle);
      }
      state.particles = particles;
    }

    /* ---------- 绘制与循环 ---------- */

    function draw() {
      ctx.clearRect(0, 0, state.width, state.height);

      const particles = state.particles;
      for (let i = 0; i < particles.length; i += 1) {
        if (particles[i].kind === KINDS.SPARK) drawSpark(particles[i]);
        else drawLeaf(particles[i]);
      }

      ctx.globalAlpha = 1; // spark 直接写 globalAlpha，这里收尾复位
    }

    function frame(now) {
      const dt = Math.min((now - state.lastFrameAt) / 1000, MAX_FRAME_SECONDS);
      state.lastFrameAt = now;

      if (Number.isFinite(dt) && dt > 0) {
        state.elapsed += dt;

        state.sinceCenterPoll += dt;
        if (state.sinceCenterPoll >= CENTER_POLL_SECONDS) {
          state.sinceCenterPoll = 0;
          syncCenter();
        }

        updatePointer(dt);
        updateParticles(dt);
      }

      draw();
      state.rafId = window.requestAnimationFrame(frame);
    }

    function start() {
      if (state.rafId !== null) return;

      if (motionQuery.matches) {
        // 尊重系统设置：场景保留，但不动
        fillParticlesImmediately();
        syncCenter();
        draw();
        return;
      }

      state.lastFrameAt = window.performance.now();
      state.rafId = window.requestAnimationFrame(frame);
    }

    function stop() {
      if (state.rafId === null) return;
      window.cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }

    /* ---------- 指针 ---------- */

    // 指数平滑，让指针位置有点跟随感，也滤掉高刷鼠标的逐帧抖动。
    // 用时间常数而不是固定比例，帧率变化时手感才一致。
    function updatePointer(dt) {
      const pointer = state.pointer;
      if (!pointer.active) return;

      const follow = 1 - Math.exp(-dt / POINTER.followTau);
      pointer.x += (pointer.targetX - pointer.x) * follow;
      pointer.y += (pointer.targetY - pointer.y) * follow;
    }

    function handlePointerMove(event) {
      const pointer = state.pointer;
      pointer.targetX = event.clientX;
      pointer.targetY = event.clientY;

      // 首次进入直接落位，否则会从上一次的坐标一路滑过来
      if (!pointer.active) {
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        pointer.active = true;
      }
    }

    // 指针离开窗口后必须置灰，否则残留的坐标会一直吹着那片叶子
    function handlePointerLeave() {
      state.pointer.active = false;
    }

    /* ---------- 事件 ---------- */

    // rAF 在后台本就被浏览器降频，显式停掉更省电（适合长期挂着的页面）
    function handleVisibilityChange() {
      if (document.hidden) stop();
      else start();
    }

    function handleMotionPreferenceChange() {
      stop();
      start();
    }

    /* ---------- 对外接口 ---------- */

    /*
      计时器状态的唯一入口。运行状态与倍率都会即时影响粒子运动 ——
      点击暂停是在按钮回调里同步走到这里的，所以粒子「立刻」转为悬浮，
      而不是走阶段切换那套 0.7 秒渐变。
    */
    function setTimerState(next) {
      const phase = next.phase === MODES.REST ? MODES.REST : MODES.FOCUS;
      const isRunning = Boolean(next.isRunning);
      const speed = Number.isFinite(next.speed) && next.speed > 0 ? next.speed : 1;

      if (phase === state.mode && isRunning === state.isRunning && speed === state.speed) return;

      const didPhaseChange = phase !== state.mode;

      state.mode = phase;
      state.isRunning = isRunning;
      state.speed = speed;
      // 鼠标交互只开在「静止状态」和「休息模式」：专注计时中不打扰
      state.interactive = !isRunning || phase === MODES.REST;
      // 暂停 → 0：风、下落、汇聚全部停下；倍率用幂函数压缩，线性放大会糊成一片
      state.motionFactor = isRunning ? Math.pow(speed, SPARK_SPEED_EXPONENT) : 0;
      state.spinFactor = isRunning ? Math.pow(speed, LEAF_SPIN_SPEED_EXPONENT) : PAUSED_SPIN_PORTION;

      if (motionQuery.matches && didPhaseChange) {
        fillParticlesImmediately();
        draw();
      }
      // 非降级模式下无需额外动作：旧粒子淡出、新粒子按帧补入，由帧循环完成交替
    }

    // 换主题要同时换两样东西：光晕精灵（贴图）和叶片明度（按主题算出来的颜色）。
    // 后者只是重算 color 字符串，不必重建粒子。
    function setTheme(theme) {
      const next = resolveTheme(theme);
      if (next === state.theme) return;

      state.theme = next;
      glowSprite = createGlowSprite(THEMES[next].sparkColor);
      state.particles.forEach((particle) => {
        if (particle.kind === KINDS.LEAF) particle.color = leafColor(particle);
      });

      // 「减少动态效果」下帧循环没在跑，得手动补一帧
      if (motionQuery.matches) draw();
    }

    function destroy() {
      stop();
      if (resizeTimerId !== null) window.clearTimeout(resizeTimerId);

      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('blur', handlePointerLeave);
      document.removeEventListener('pointerleave', handlePointerLeave);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      motionQuery.removeEventListener('change', handleMotionPreferenceChange);

      state.particles = [];
      ctx.clearRect(0, 0, state.width, state.height);
    }

    /* ---------- 启动 ---------- */

    resize();
    fillParticlesImmediately();

    window.addEventListener('resize', handleResize);
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('blur', handlePointerLeave);
    // document 上的 pointerleave 负责「指针移出窗口」；window blur 兜住切走标签页
    document.addEventListener('pointerleave', handlePointerLeave);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    motionQuery.addEventListener('change', handleMotionPreferenceChange);

    start();

    return { setTimerState, setTheme, destroy };
  }

  window.PomodoroBackground = { create: createBackground };
})();
