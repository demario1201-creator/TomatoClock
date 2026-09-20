'use strict';

/* ==================== 常量 ==================== */

const PHASES = { FOCUS: 'focus', REST: 'rest' };

const DURATIONS_MS = {
  [PHASES.FOCUS]: 25 * 60 * 1000,
  [PHASES.REST]: 5 * 60 * 1000,
};

const PHASE_LABELS = {
  [PHASES.FOCUS]: '专注中',
  [PHASES.REST]: '休息中',
};

const MIN_SPEED = 1;
const MAX_SPEED = 100;
const SPEED_PRESETS = [1, 2, 5, 10, 100];

const BASE_TICK_INTERVAL_MS = 200;
const MIN_TICK_INTERVAL_MS = 16;

const FULL_CIRCLE_DEG = 360;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

const CHIME_CONFIG = {
  [PHASES.FOCUS]: { notes: [660, 880], durationMs: 150 }, // 专注结束：两个上扬短音
  [PHASES.REST]: { notes: [440], durationMs: 300 },       // 休息结束：一个低沉长音
};
const CHIME_PEAK_GAIN = 0.25;
const CHIME_FLOOR_GAIN = 0.0001; // 指数包络不能衰减到 0
const CHIME_ATTACK_SECONDS = 0.01;
const CHIME_NOTE_GAP_MS = 40;

const THEME = { DARK: 'dark', LIGHT: 'light' };

// 这两个键名和 index.html 头部内联脚本里的一致，改动要同步
const THEME_STORAGE_KEY = 'pomodoro.theme';
const STATS_STORAGE_KEY = 'pomodoro.stats';

/* ==================== 纯逻辑层 ==================== */
/* 不碰 DOM，时间由参数传入，因此可单测。所有函数返回新对象，不修改传入的 state。 */

function createInitialState() {
  return {
    phase: PHASES.FOCUS,
    remainingMs: DURATIONS_MS[PHASES.FOCUS],
    isRunning: false,
    lastTickAt: null,
    speed: MIN_SPEED,
  };
}

function clampSpeed(speed) {
  if (!Number.isFinite(speed)) return MIN_SPEED;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(speed)));
}

/*
  核心推进函数，tick / pause / setSpeed 都复用它。

  用「真实时间差 × 倍率」而不是「每 tick 固定减一个值」，同时解决两件事：
  - 后台标签页被节流时，降频只是刷新变卡，累计时间不会走慢；
  - 倍率随时可变，改倍率不需要重算任何绝对时间点。
*/
function advance(state, now) {
  if (!state.isRunning || state.lastTickAt === null) return state;

  const elapsedVirtualMs = (now - state.lastTickAt) * state.speed;
  return {
    ...state,
    remainingMs: Math.max(0, state.remainingMs - elapsedVirtualMs),
    lastTickAt: now,
  };
}

function startTimer(state, now) {
  if (state.isRunning) return state;
  return { ...state, isRunning: true, lastTickAt: now };
}

function pauseTimer(state, now) {
  if (!state.isRunning) return state;
  return { ...advance(state, now), isRunning: false, lastTickAt: null };
}

function resetTimer() {
  return createInitialState(); // 倍率一并归 1×
}

/*
  运行中改倍率必须先按「旧倍率」结算已经流逝的那一段，再写入新倍率。
  否则 now - lastTickAt 这段本该按旧倍率算的时间会被追溯性地按新倍率重算 ——
  从 1× 一把拖到 100× 时，会瞬间掉掉一大截时间。
*/
function setSpeed(state, speed, now) {
  const settled = advance(state, now);
  return { ...settled, speed: clampSpeed(speed) };
}

function tick(state, now) {
  const next = advance(state, now);
  if (next.remainingMs > 0) {
    return { state: next, didSwitchPhase: false, endedPhase: null };
  }

  // 一次 tick 最多切换一次阶段，多余的部分丢弃。
  // 兜底标签页被冻结很久、或倍率极高时单次步进跨越整个阶段的情况。
  const nextPhase = next.phase === PHASES.FOCUS ? PHASES.REST : PHASES.FOCUS;
  return {
    state: { ...next, phase: nextPhase, remainingMs: DURATIONS_MS[nextPhase] },
    didSwitchPhase: true,
    // 返回刚结束的阶段（而非新阶段）—— 提示音是按「哪个阶段结束了」来选的
    endedPhase: next.phase,
  };
}

function formatTime(ms) {
  const totalSeconds = Math.ceil(ms / MS_PER_SECOND);
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function toRingAngle(state) {
  const duration = DURATIONS_MS[state.phase];
  if (duration <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, state.remainingMs / duration));
  return ratio * FULL_CIRCLE_DEG;
}

function toggleButtonLabel(state) {
  if (state.isRunning) return '暂停';
  return state.remainingMs < DURATIONS_MS[state.phase] ? '继续' : '开始';
}

/* ==================== 音效层 ==================== */

let isMuted = false;
let audioContext = null;

function ensureAudioContext() {
  if (audioContext) return audioContext;

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;

  try {
    audioContext = new AudioContextCtor();
  } catch (error) {
    console.warn('提示音不可用，将静默运行：', error);
    audioContext = null;
  }
  return audioContext;
}

/*
  浏览器自动播放策略下 AudioContext 默认是 suspended 的，而提示音恰恰是在
  没有用户交互的那一刻（倒计时归零）触发的。所以在「开始」按钮的点击回调里
  主动解锁一次 —— 用户必须先点开始才能计时，这个时机一定存在。
*/
function unlockAudio() {
  const context = ensureAudioContext();
  if (!context || context.state !== 'suspended') return;

  context.resume().catch((error) => {
    console.warn('提示音解锁失败，将静默运行：', error);
  });
}

function playChime(phase) {
  if (isMuted) return;

  const context = ensureAudioContext();
  if (!context) return;
  unlockAudio();

  const { notes, durationMs } = CHIME_CONFIG[phase];
  const durationSeconds = durationMs / MS_PER_SECOND;

  notes.forEach((frequency, index) => {
    const noteDurationMs = durationMs + CHIME_NOTE_GAP_MS;
    const startAt = context.currentTime + (index * noteDurationMs) / MS_PER_SECOND;

    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, startAt);

    // 指数衰减包络，避免直接切断产生的爆音
    gain.gain.setValueAtTime(CHIME_FLOOR_GAIN, startAt);
    gain.gain.exponentialRampToValueAtTime(CHIME_PEAK_GAIN, startAt + CHIME_ATTACK_SECONDS);
    gain.gain.exponentialRampToValueAtTime(CHIME_FLOOR_GAIN, startAt + durationSeconds);

    oscillator.connect(gain).connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + durationSeconds);

    oscillator.addEventListener('ended', () => {
      oscillator.disconnect();
      gain.disconnect();
    });
  });
}

/* ==================== 主题层 ==================== */

const prefersLightQuery = window.matchMedia('(prefers-color-scheme: light)');

function systemTheme() {
  return prefersLightQuery.matches ? THEME.LIGHT : THEME.DARK;
}

function readStoredTheme() {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === THEME.LIGHT || value === THEME.DARK ? value : null;
  } catch (error) {
    console.warn('读取主题设置失败，将跟随系统：', error);
    return null;
  }
}

function storeTheme(theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    console.warn('保存主题设置失败：', error);
  }
}

/* ==================== 今日统计 ==================== */

/*
  只按本地日期存一条 { date, count }：跨天（或换了时区）读到旧日期就归零。
  不引入历史记录 —— 需求只要「今日完成次数」，存多天反而要处理清理。
*/
function todayKey(date) {
  const target = date || new Date();
  const month = String(target.getMonth() + 1).padStart(2, '0');
  const day = String(target.getDate()).padStart(2, '0');
  return `${target.getFullYear()}-${month}-${day}`;
}

function loadCompletedToday() {
  try {
    const raw = window.localStorage.getItem(STATS_STORAGE_KEY);
    if (!raw) return 0;

    const parsed = JSON.parse(raw);
    if (parsed && parsed.date === todayKey() && Number.isFinite(parsed.count)) {
      return Math.max(0, Math.floor(parsed.count));
    }
  } catch (error) {
    console.warn('读取今日完成次数失败，将从 0 开始：', error);
  }
  return 0;
}

function saveCompletedToday(count) {
  try {
    window.localStorage.setItem(
      STATS_STORAGE_KEY,
      JSON.stringify({ date: todayKey(), count }),
    );
  } catch (error) {
    console.warn('保存今日完成次数失败：', error);
  }
}

/* ==================== 渲染层 ==================== */

const dom = {};
let lastRenderKey = '';
let lastTitle = '';
let background = null;

const DOM_IDS = {
  bg: 'bg',
  ring: 'ring',
  status: 'status',
  time: 'time',
  speedBadge: 'speedBadge',
  toggleBtn: 'toggleBtn',
  resetBtn: 'resetBtn',
  muteBtn: 'muteBtn',
  speedBtn: 'speedBtn',
  speedPanel: 'speedPanel',
  speedValue: 'speedValue',
  speedRange: 'speedRange',
  speedPresets: 'speedPresets',
  themeBtn: 'themeBtn',
  statsCount: 'statsCount',
};

function cacheDom() {
  const missing = [];

  Object.entries(DOM_IDS).forEach(([key, id]) => {
    const element = document.getElementById(id);
    if (!element) missing.push(id);
    dom[key] = element;
  });

  if (missing.length > 0) {
    console.error(`初始化失败，缺少 DOM 元素：#${missing.join('、#')}`);
    return false;
  }
  return true;
}

function render(state) {
  const timeText = formatTime(state.remainingMs);
  const angleDeg = toRingAngle(state);
  const renderKey = `${timeText}|${angleDeg.toFixed(2)}|${state.phase}|${state.isRunning}|${state.speed}`;

  if (renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;

  dom.ring.style.setProperty('--angle', `${angleDeg}deg`);
  dom.time.textContent = timeText;
  dom.status.textContent = PHASE_LABELS[state.phase];
  dom.toggleBtn.textContent = toggleButtonLabel(state);

  document.body.classList.toggle('is-focus', state.phase === PHASES.FOCUS);
  document.body.classList.toggle('is-rest', state.phase === PHASES.REST);

  // 背景不仅要知道阶段，还要知道运行状态与倍率：暂停时粒子悬浮，
  // 倍率越高汇聚越快。render() 在去重块内调用，所以只在状态真变化时触发。
  if (background) {
    background.setTimerState({
      phase: state.phase,
      isRunning: state.isRunning,
      speed: state.speed,
    });
  }

  const isBoosted = state.speed !== MIN_SPEED;
  dom.speedBadge.hidden = !isBoosted;
  if (isBoosted) dom.speedBadge.textContent = `${state.speed}×`;

  // 高倍率下每个 tick 都会走到这里，标题单独去重避免无谓的重排
  const title = `${timeText} · ${PHASE_LABELS[state.phase]}`;
  if (title !== lastTitle) {
    document.title = title;
    lastTitle = title;
  }
}

function buildPresetButtons(onSelect) {
  const fragment = document.createDocumentFragment();

  SPEED_PRESETS.forEach((speed) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset';
    button.dataset.speed = String(speed);
    button.textContent = `${speed}×`;
    button.addEventListener('click', () => onSelect(speed));
    fragment.appendChild(button);
  });

  dom.speedPresets.replaceChildren(fragment);
}

function syncSpeedControls(speed) {
  dom.speedRange.value = String(speed);
  dom.speedValue.textContent = `${speed}×`;

  dom.speedPresets.querySelectorAll('.preset').forEach((button) => {
    button.classList.toggle('is-active', Number(button.dataset.speed) === speed);
  });
}

function setSpeedPanelOpen(isOpen) {
  dom.speedPanel.hidden = !isOpen;
  dom.speedBtn.setAttribute('aria-expanded', String(isOpen));
}

function renderStats(count) {
  dom.statsCount.textContent = String(count);
}

/*
  只负责「让界面跟上主题」：图标由 CSS 按 data-theme 出，这里不写 textContent，
  否则首屏会先渲染 HTML 里的空按钮、再被 JS 补上图标。
*/
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;

  const isLight = theme === THEME.LIGHT;
  dom.themeBtn.setAttribute('aria-pressed', String(isLight));
  dom.themeBtn.setAttribute('aria-label', isLight ? '切换到深色模式' : '切换到浅色模式');

  if (background) background.setTheme(theme);
}

/* ==================== 初始化 ==================== */

// 粒子要汇聚到圆环中心，而非视口中心 —— .app 是整块垂直居中的，
// 圆环上方有状态标签、下方有按钮（窄屏还会换成两行），两者并不重合。
// 同时把圆环半径交给背景：粒子的淡出区锚定在圆环边缘，
// 这样任何视口下中心都保持干净，不会在圆环里堆成团块。
function readRingCenter() {
  const rect = dom.ring.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    radius: rect.width / 2,
  };
}

function createBackground(theme) {
  if (!window.PomodoroBackground) {
    console.warn('background.js 未加载，背景动画已停用');
    return null;
  }
  // 主题要在这里就给到：粒子的配色是画在 canvas 上的，CSS 变量管不到，
  // 建好之后再改会看到一帧旧配色。
  return window.PomodoroBackground.create(dom.bg, {
    getCenter: readRingCenter,
    theme,
  });
}

function init() {
  if (!cacheDom()) return;

  let theme = readStoredTheme() || systemTheme();
  background = createBackground(theme);
  applyTheme(theme);

  let completedToday = loadCompletedToday();
  renderStats(completedToday);

  let state = createInitialState();
  let tickTimerId = null;
  let tickIntervalMs = null;

  function stopTicking() {
    if (tickTimerId === null) return;
    window.clearInterval(tickTimerId);
    tickTimerId = null;
    tickIntervalMs = null;
  }

  // 倍率越高刷新越快，否则 100× 下每 tick 会跳 20 虚拟秒
  function startTicking() {
    const nextIntervalMs = Math.max(MIN_TICK_INTERVAL_MS, BASE_TICK_INTERVAL_MS / state.speed);

    if (tickTimerId !== null && tickIntervalMs === nextIntervalMs) return;
    stopTicking();

    tickIntervalMs = nextIntervalMs;
    tickTimerId = window.setInterval(handleTick, nextIntervalMs);
  }

  function handleTick() {
    const result = tick(state, Date.now());
    state = result.state;

    if (result.didSwitchPhase) {
      playChime(result.endedPhase);
      // 只有「专注」跑完才算一个番茄，休息结束不计
      if (result.endedPhase === PHASES.FOCUS) {
        completedToday += 1;
        saveCompletedToday(completedToday);
        renderStats(completedToday);
      }
    }
    render(state);
  }

  function applySpeed(speed) {
    state = setSpeed(state, speed, Date.now());
    syncSpeedControls(state.speed); // 回写钳制后的值，滑块不信任传入值
    if (state.isRunning) startTicking();
    render(state);
  }

  dom.toggleBtn.addEventListener('click', () => {
    if (state.isRunning) {
      state = pauseTimer(state, Date.now());
      stopTicking();
    } else {
      unlockAudio(); // 借这次用户交互解锁音频
      state = startTimer(state, Date.now());
      startTicking();
    }
    render(state);
  });

  dom.resetBtn.addEventListener('click', () => {
    state = resetTimer();
    stopTicking();
    syncSpeedControls(state.speed);
    render(state);
  });

  dom.muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    dom.muteBtn.textContent = isMuted ? '🔕' : '🔔';
    dom.muteBtn.setAttribute('aria-pressed', String(isMuted));
    dom.muteBtn.setAttribute('aria-label', isMuted ? '开启提示音' : '关闭提示音');
  });

  dom.themeBtn.addEventListener('click', () => {
    theme = theme === THEME.LIGHT ? THEME.DARK : THEME.LIGHT;
    storeTheme(theme); // 手动选过之后就固定下来，不再跟随系统
    applyTheme(theme);
  });

  prefersLightQuery.addEventListener('change', () => {
    if (readStoredTheme()) return;
    theme = systemTheme();
    applyTheme(theme);
  });

  dom.speedBtn.addEventListener('click', () => {
    setSpeedPanelOpen(dom.speedPanel.hidden);
  });

  dom.speedRange.addEventListener('input', (event) => {
    applySpeed(Number(event.target.value));
  });

  document.addEventListener('click', (event) => {
    if (dom.speedPanel.hidden) return;
    if (dom.speedBtn.contains(event.target)) return;
    if (dom.speedPanel.contains(event.target)) return;
    setSpeedPanelOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || dom.speedPanel.hidden) return;
    setSpeedPanelOpen(false);
    dom.speedBtn.focus();
  });

  buildPresetButtons(applySpeed);
  syncSpeedControls(state.speed);
  render(state);
}

init();
