import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { randomUUID } from 'node:crypto';

const DAY = 86_400_000;
const SOURCES = ['api', 'dsh'];
const READ_ACTIONS = new Set(['douyin_status', 'douyin_pause', 'douyin_recall', 'douyin_remember', 'douyin_video_limits_status']);
export const DEFAULT_VIDEO_POLICY = Object.freeze({ version: 1, timeZone: 'Asia/Shanghai', windows: ['00:00-24:00'], sessionMinutes: 10 });
// 定时启动默认关闭：只有用户在控制台明确打开后，定时器才会在允许时段开始新一轮。
// checkIntervalMs：每隔多久看一次是否进了允许时段；maxRetries：一次 tick 内开轮失败重试几次；
// retryBaseMs：重试退避基准（第 n 次重试前等 retryBaseMs * 2^n）。
export const DEFAULT_SCHEDULE = Object.freeze({ version: 1, enabled: false, checkIntervalMs: 30_000, maxRetries: 3, retryBaseMs: 5_000 });
// 每个时段最多用几个 tick 尝试开轮；超过就记一次“错过”，等下一个时段再试，不再追着重试。
export const SCHEDULE_MAX_TICKS_PER_WINDOW = 3;
export function scheduleBackoffMs(attempt, baseMs) {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || !Number.isSafeInteger(baseMs) || baseMs < 0) throw new Error('定时启动退避无效。');
  return Math.min(baseMs * 2 ** attempt, 60_000);
}
function defaultScheduleState() { return { version: 1, started: {}, seen: {}, attempts: {}, missed: [] }; }
export function validateSchedule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('定时启动设置必须是对象。');
  for (const key of Object.keys(input)) if (!['version', 'enabled', 'checkIntervalMs', 'maxRetries', 'retryBaseMs'].includes(key)) throw new Error(`不支持的定时启动设置：${key}`);
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('定时启动开关须是布尔值。');
  if (input.checkIntervalMs !== undefined && (!Number.isSafeInteger(input.checkIntervalMs) || input.checkIntervalMs < 5_000 || input.checkIntervalMs > 600_000)) throw new Error('定时启动检查间隔须是 5 至 600 秒的整数毫秒。');
  if (input.maxRetries !== undefined && (!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 5)) throw new Error('定时启动重试次数须是 0 至 5 的整数。');
  if (input.retryBaseMs !== undefined && (!Number.isSafeInteger(input.retryBaseMs) || input.retryBaseMs < 1_000 || input.retryBaseMs > 60_000)) throw new Error('定时启动退避基准须是 1 至 60 秒的整数毫秒。');
  return { version: 1, enabled: input.enabled ?? DEFAULT_SCHEDULE.enabled, checkIntervalMs: input.checkIntervalMs ?? DEFAULT_SCHEDULE.checkIntervalMs, maxRetries: input.maxRetries ?? DEFAULT_SCHEDULE.maxRetries, retryBaseMs: input.retryBaseMs ?? DEFAULT_SCHEDULE.retryBaseMs };
}
export function validateScheduleState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1) throw new Error('定时启动记录损坏，未重置开轮与错过记录。');
  const badId = value => typeof value !== 'string' || !value;
  for (const field of ['started', 'seen']) {
    if (!input[field] || typeof input[field] !== 'object' || Array.isArray(input[field]) || Object.values(input[field]).some(badId)) throw new Error('定时启动记录损坏，未重置开轮与错过记录。');
  }
  if (!input.attempts || typeof input.attempts !== 'object' || Array.isArray(input.attempts) || Object.values(input.attempts).some(item => !item || !Number.isSafeInteger(item.ticks) || item.ticks < 0 || !Number.isSafeInteger(item.tries) || item.tries < 0 || typeof item.lastError !== 'string' || item.lastError.length > 500 || typeof item.at !== 'string')) throw new Error('定时启动记录损坏，未重置开轮与错过记录。');
  if (!Array.isArray(input.missed) || input.missed.length > 16 || input.missed.some(item => !item || !Number.isSafeInteger(item.windowStart) || !Number.isSafeInteger(item.windowEnd) || typeof item.reason !== 'string' || item.reason.length > 500 || typeof item.at !== 'string')) throw new Error('定时启动记录损坏，未重置开轮与错过记录。');
  return { version: 1, started: { ...input.started }, seen: { ...input.seen }, attempts: { ...input.attempts }, missed: [...input.missed] };
}
const shanghai = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, value) { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file); }
function initialize(file, value) { let descriptor; try { descriptor = fs.openSync(file, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return; throw error; } try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2)); } finally { fs.closeSync(descriptor); } }
function sourceName(source) { if (!SOURCES.includes(source)) throw new Error('刷视频入口只能是 api 或 dsh。'); return source; }
function parseWindow(value) {
  if (typeof value !== 'string' || value.length > 11 || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(value)) throw new Error('时间段请使用 HH:MM-HH:MM，例如 20:00-21:00。');
  const [startHour, startMinute, endHour, endMinute] = value.split(/[:-]/).map(Number);
  if (startHour > 23 || endHour > 24 || startMinute > 59 || endMinute > 59 || (endHour === 24 && endMinute !== 0)) throw new Error('开始时间须在 00:00 至 23:59，结束时间可使用 24:00。');
  const start = startHour * 60 + startMinute; let end = endHour * 60 + endMinute;
  if (start === end) throw new Error('时间段不能为零长度；全天请用 00:00-24:00。');
  if (end < start) end += 1440;
  return { start, end };
}
export function validateVideoPolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('视频时间设置必须是对象。');
  for (const key of Object.keys(input)) if (!['version','timeZone','windows','sessionMinutes'].includes(key)) throw new Error(`不支持的视频设置：${key}`);
  if (input.timeZone !== undefined && input.timeZone !== 'Asia/Shanghai') throw new Error('时间段固定按 Asia/Shanghai 计算。');
  if (!Number.isSafeInteger(input.sessionMinutes) || input.sessionMinutes < 1 || input.sessionMinutes > 1440) throw new Error('单轮时长须是 1 至 1440 分钟的整数，不能关闭时长上限。');
  if (!Array.isArray(input.windows) || input.windows.length < 1 || input.windows.length > 16) throw new Error('请设置 1 至 16 个每日时间段，不能关闭全部时间限制。');
  for (const value of input.windows) parseWindow(value);
  return { version: 1, timeZone: 'Asia/Shanghai', windows: [...new Set(input.windows)], sessionMinutes: input.sessionMinutes };
}
export function allowedWindow(policy, now) {
  if (!Number.isFinite(now)) throw new Error('当前时间无效。');
  const parts = Object.fromEntries(shanghai.formatToParts(new Date(now)).filter((item) => item.type !== 'literal').map((item) => [item.type, Number(item.value)]));
  const midnight = Date.UTC(parts.year, parts.month - 1, parts.day) - 8 * 3600_000;
  const intervals = [];
  for (const offset of [-1, 0, 1]) for (const value of policy.windows) { const { start, end } = parseWindow(value); intervals.push({ startAt: midnight + offset * DAY + start * 60_000, expiresAt: midnight + offset * DAY + end * 60_000 }); }
  intervals.sort((a, b) => a.startAt - b.startAt);
  const merged = [];
  for (const interval of intervals) { const previous = merged.at(-1); if (previous && interval.startAt <= previous.expiresAt) previous.expiresAt = Math.max(previous.expiresAt, interval.expiresAt); else merged.push({ ...interval }); }
  return merged.find((interval) => now >= interval.startAt && now < interval.expiresAt) || null;
}

// 复用 Node.js 时间、文件与定时器，以及本项目的本机持久状态方式，无新增依赖。
export class VideoLimits {
  constructor({ stateDir = resolveRuntimePaths().stateDir, now = Date.now } = {}) {
    Object.assign(this, { stateDir, now }); fs.mkdirSync(stateDir, { recursive: true });
    this.policyFile = path.join(stateDir, 'video-policy.json'); this.sessionsFile = path.join(stateDir, 'video-sessions.json'); this.guardFile = path.join(stateDir, 'video-control.guard');
    this.scheduleFile = path.join(stateDir, 'video-schedule.json'); this.scheduleStateFile = path.join(stateDir, 'video-schedule-state.json');
    initialize(this.policyFile, DEFAULT_VIDEO_POLICY); initialize(this.sessionsFile, { version: 1, current: null });
    initialize(this.scheduleFile, DEFAULT_SCHEDULE); initialize(this.scheduleStateFile, defaultScheduleState());
    this.enforcing = false;
  }
  control(action) {
    let descriptor; const token = randomUUID();
    try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('视频设置正在更新，或控制锁需要人工核对；未自动删除。'), { status: 409 }); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    try { return action(); } finally { const guard = read(this.guardFile); if (guard.token === token && guard.pid === process.pid) fs.unlinkSync(this.guardFile); }
  }
  state() {
    const policy = validateVideoPolicy(read(this.policyFile)); const sessions = read(this.sessionsFile); const now = this.now();
    if (!Number.isFinite(now)) throw new Error('当前时间无效，未允许刷视频。');
    const window = allowedWindow(policy, now); const session = sessions.current;
    if (session && (!Number.isFinite(session.startAt) || !Number.isFinite(session.expiresAt) || session.expiresAt < session.startAt || session.expiresAt > session.startAt + 1440 * 60_000)) throw new Error('视频会话时间无效，未允许刷视频。');
    const expiresAt = session ? Math.min(session.expiresAt, session.startAt + policy.sessionMinutes * 60_000, window?.expiresAt ?? now) : null;
    let reason = '';
    if (!window) reason = '当前不在允许刷视频的时间段。';
    else if (!session) reason = `请点击“开始新一轮”，本轮上限 ${policy.sessionMinutes} 分钟。`;
    else if (session.status !== 'active') reason = session.reason || '当前这轮已经结束，请显式开始新一轮。';
    else if (now < session.startAt || now >= expiresAt) reason = '本轮刷视频时间已用完，请显式开始新一轮。';
    return { protocol: 'video-limits-v1', timeZone: 'Asia/Shanghai', now, policy, session: session ? { ...session, expiresAt } : null, window, allowed: !reason, reason, remainingSeconds: !reason ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0 };
  }
  schedule() { return validateSchedule(read(this.scheduleFile)); }
  scheduleState() { return validateScheduleState(read(this.scheduleStateFile)); }
  configureSchedule(input, { explicit = false } = {}) {
    if (!explicit) throw new Error('定时启动只能由用户在控制台明确打开或修改。');
    const config = validateSchedule(input);
    return this.control(() => { write(this.scheduleFile, config); return this.schedule(); });
  }
  // 定时启动：每隔 checkIntervalMs 看一次允许时段。默认关闭；只应创建一个调度器
  //（由 AutonomousWatch.startAutoSchedule 创建，见 autonomous-watch.mjs），
  // 两个调度器会抢着开轮——开轮本身有锁不会开出两轮，但失败记录会翻倍。
  // 语义：每个允许时段最多自动开一轮；开轮失败时当次 tick 内按退避重试，
  // 下个 tick 还能接着追，直到用完 SCHEDULE_MAX_TICKS_PER_WINDOW 个 tick，
  // 再失败就记一条 missed，等下一个时段；时段结束时只收尾本调度器开的那轮，
  // 手动开的轮次不由它结束。用户已配好的时段（video-policy.json）原样不动。
  createAutoScheduler({ onSlotStart, onSlotEnd, onEvent = () => {}, delayImpl = (ms) => delay(ms) } = {}) {
    if (onSlotStart !== undefined && typeof onSlotStart !== 'function') throw new Error('定时启动缺少时段开始回调。');
    if (onSlotEnd !== undefined && typeof onSlotEnd !== 'function') throw new Error('定时启动缺少时段结束回调。');
    if (typeof onEvent !== 'function' || typeof delayImpl !== 'function') throw new Error('定时启动缺少事件或延时接口。');
    const stopped = { current: false, ticking: false };
    const windowKey = (window) => String(window.startAt);
    const prune = (runtime, now) => {
      for (const field of ['started', 'seen', 'attempts']) for (const key of Object.keys(runtime[field])) if (Number(key) < now - 48 * 3600_000) delete runtime[field][key];
      runtime.missed = runtime.missed.filter(item => now - Date.parse(item.at) < 7 * DAY).slice(-16);
    };
    const tick = async () => {
      if (stopped.current || stopped.ticking) return { skipped: true };
      stopped.ticking = true;
      try {
        const config = this.schedule();
        if (!config.enabled) return { enabled: false };
        let current;
        try { current = this.state(); } catch (error) { onEvent({ type: 'schedule.state_error', message: `定时启动读取视频时间状态失败：${error.message}` }); return { error: error.message }; }
        const runtime = this.scheduleState();
        const now = this.now();
        prune(runtime, now);
        const active = current.allowed && current.session?.status === 'active';
        if (current.window && active) {
          // 轮次进行中（手动开的也算）：记下本时段已有过一轮，不再重复启动。
          const key = windowKey(current.window);
          if (!runtime.seen[key]) { runtime.seen[key] = current.session.id; write(this.scheduleStateFile, runtime); }
          return { enabled: true, inWindow: true, active: true };
        }
        if (current.window && !active) {
          const key = windowKey(current.window);
          if (runtime.started[key] || runtime.seen[key]) return { enabled: true, inWindow: true, startedAlready: true };
          const attempt = runtime.attempts[key] || { ticks: 0, tries: 0, lastError: '', at: '' };
          if (attempt.ticks >= SCHEDULE_MAX_TICKS_PER_WINDOW) {
            if (!runtime.missed.some(item => item.windowStart === current.window.startAt)) {
              runtime.missed.push({ windowStart: current.window.startAt, windowEnd: current.window.expiresAt, reason: attempt.lastError || '定时启动多次重试均失败。', at: new Date(now).toISOString() });
              runtime.missed = runtime.missed.slice(-16);
              write(this.scheduleStateFile, runtime);
              onEvent({ type: 'schedule.slot_missed', message: `本时段定时启动失败 ${attempt.tries} 次，已记录为错过，下个时段再试：${attempt.lastError}`.slice(0, 300) });
            }
            return { enabled: true, inWindow: true, missed: true };
          }
          attempt.ticks += 1; attempt.at = new Date(now).toISOString();
          let started = null;
          for (let n = 0; n < Math.max(1, config.maxRetries); n++) {
            try {
              const state = this.markSession('dsh', { explicit: true });
              started = state.session; break;
            } catch (error) {
              attempt.tries += 1; attempt.lastError = String(error?.message || error).slice(0, 200); attempt.at = new Date(this.now()).toISOString();
              runtime.attempts[key] = attempt; write(this.scheduleStateFile, runtime);
              onEvent({ type: 'schedule.start_failed', message: `定时启动第 ${attempt.tries} 次失败：${attempt.lastError}`.slice(0, 300) });
              if (n + 1 < config.maxRetries) await delayImpl(scheduleBackoffMs(n, config.retryBaseMs));
            }
          }
          if (started) {
            runtime.started[key] = started.id; delete runtime.attempts[key]; write(this.scheduleStateFile, runtime);
            onEvent({ type: 'schedule.slot_started', message: `定时启动成功，已开始新一轮（时段至 ${new Date(current.window.expiresAt).toISOString()}）。` });
            try { await onSlotStart?.({ sessionId: started.id, window: current.window }); } catch (error) { onEvent({ type: 'schedule.watch_start_failed', message: `定时启动后开始自主观看失败：${String(error?.message || error).slice(0, 200)}` }); }
            return { enabled: true, inWindow: true, started: started.id };
          }
          runtime.attempts[key] = attempt; write(this.scheduleStateFile, runtime);
          return { enabled: true, inWindow: true, failed: true, tries: attempt.tries };
        }
        // 不在允许时段：只收尾本调度器开的那轮；手动开的轮次不由它结束。
        for (const [key, sessionId] of Object.entries(runtime.started)) {
          if (current.session?.id === sessionId && current.session?.status === 'active') {
            try { this.endSession({ explicit: true, reason: '允许时段结束，自动结束本轮。' }); } catch {}
            onEvent({ type: 'schedule.slot_ended', message: '允许时段结束，已自动结束本轮。' });
            try { await onSlotEnd?.({ sessionId }); } catch (error) { onEvent({ type: 'schedule.watch_stop_failed', message: `时段结束时停止自主观看失败：${String(error?.message || error).slice(0, 200)}` }); }
          }
          delete runtime.started[key];
        }
        write(this.scheduleStateFile, runtime);
        return { enabled: true, inWindow: false };
      } finally { stopped.ticking = false; }
    };
    const config = this.schedule();
    const timer = setInterval(() => { void tick().catch((error) => onEvent({ type: 'schedule.tick_error', message: String(error?.message || error).slice(0, 200) })); }, config.checkIntervalMs); timer.unref?.();
    return { stop: () => { stopped.current = true; clearInterval(timer); }, tick, config: () => this.schedule(), state: () => this.scheduleState() };
  }
  savePolicy(input, { explicit = false } = {}) {
    if (!explicit) throw new Error('视频时间设置只能由用户在控制台明确修改。');
    const policy = validateVideoPolicy(input);
    return this.control(() => { write(this.policyFile, policy); const sessions = read(this.sessionsFile); if (sessions.current?.status === 'active') { const now = this.now(); const window = allowedWindow(policy, now); sessions.current.expiresAt = Math.min(sessions.current.expiresAt, sessions.current.startAt + policy.sessionMinutes * 60_000, window?.expiresAt ?? now); if (!window || now >= sessions.current.expiresAt) { sessions.current.status = 'expired'; sessions.current.reason = '保存后的时间设置已结束当前这轮。'; } write(this.sessionsFile, sessions); } return this.state(); });
  }
  markSession(source, { explicit = false } = {}) {
    sourceName(source); if (!explicit) throw new Error('不能由视频工具自动重置时钟，请在控制台显式开始新一轮。');
    return this.control(() => {
      const policy = validateVideoPolicy(read(this.policyFile)); const now = this.now(); const window = allowedWindow(policy, now);
      if (!window) throw Object.assign(new Error('当前不在允许时间段，未开始新一轮。'), { status: 409 });
      const expiresAt = Math.min(now + policy.sessionMinutes * 60_000, window.expiresAt);
      write(this.sessionsFile, { version: 1, current: { id: randomUUID(), startAt: now, expiresAt, startedBy: source, status: 'active', sources: { [source]: { startAt: now, expiresAt } } } });
      return this.state();
    });
  }
  endSession({ explicit = false, reason = '用户结束当前这轮。' } = {}) {
    if (!explicit) throw new Error('结束当前这轮需要用户明确操作。');
    return this.control(() => { const sessions = read(this.sessionsFile); if (sessions.current) { sessions.current.status = 'ended'; sessions.current.reason = reason; sessions.current.endedAt = this.now(); write(this.sessionsFile, sessions); } return this.state(); });
  }
  beforeAction(source, name) {
    sourceName(source);
    if (name.startsWith('douyin_chat_')) return { allowed: true };
    if (READ_ACTIONS.has(name)) { try { return { allowed: true, state: this.state() }; } catch (error) { return { allowed: true, state: { allowed: false, reason: error.message } }; } }
    return this.control(() => {
      const state = this.state(); const sessions = read(this.sessionsFile);
      if (!state.allowed) { if (sessions.current?.status === 'active') { sessions.current.status = 'expired'; sessions.current.reason = state.reason; write(this.sessionsFile, sessions); } return { allowed: false, reason: state.reason, state: this.state() }; }
      sessions.current.sources[source] ||= { startAt: sessions.current.startAt, expiresAt: state.session.expiresAt };
      sessions.current.sources[source].expiresAt = state.session.expiresAt; sessions.current.sources[source].lastActionAt = this.now();
      write(this.sessionsFile, sessions); const updated = this.state(); return { allowed: updated.allowed, ...(updated.allowed ? {} : { reason: updated.reason }), state: updated };
    });
  }
  async enforce({ sources = SOURCES, pause, onDeny = () => {} } = {}) {
    if (this.enforcing) return;
    this.enforcing = true;
    try {
      let state; try { state = this.state(); } catch (error) { state = { allowed: false, reason: `视频时间状态不可读：${error.message}` }; }
      if (state.allowed) return state;
      if (state.session?.status === 'active') { try { state = this.control(() => { const current = this.state(); if (!current.allowed) { const sessions = read(this.sessionsFile); sessions.current.status = 'expired'; sessions.current.reason = current.reason; write(this.sessionsFile, sessions); } return this.state(); }); } catch {} }
      if (state.allowed) return state;
      onDeny(state);
      const pauseResults = await Promise.allSettled(sources.map((source) => { sourceName(source); return pause?.(source, state); }));
      return { ...state, pauseResults: pauseResults.map((result) => ({ status: result.status, ...(result.status === 'fulfilled' ? { result: result.value } : { message: result.reason?.message || String(result.reason) }) })) };
    } finally { this.enforcing = false; }
  }
  watch({ intervalMs = 1000, ...options } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 1000) throw new Error('视频时限检查间隔须为 10 至 1000 毫秒。');
    const timer = setInterval(() => { void this.enforce(options).catch(() => {}); }, intervalMs); timer.unref?.();
    return () => clearInterval(timer);
  }
}
