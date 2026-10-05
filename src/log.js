import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 日志落盘：仅在设置了 SAKIBOT_LOG_FILE 时启用；未设置则完全不碰文件系统。
// 用同步追加写入，保证进程被强杀时最后几行也能落盘；写失败只提示一次并熔断，
// 绝不因日志失败而影响机器人本身。
const LOG_FILE = process.env.SAKIBOT_LOG_FILE || '';
let fileReady = false;

function appendFile(line) {
  if (!LOG_FILE) return;
  if (!fileReady) {
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fileReady = true;
    } catch (e) {
      fileReady = false;
      console.error('[log] 日志文件目录创建失败，本次不落盘：' + e.message);
      return;
    }
  }
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    fileReady = false;
    console.error('[log] 写入日志文件失败：' + e.message);
  }
}

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
  const line = `[${ts()}] ${tag} `;
  const text = line + args.map(String).join(' ');
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(text);
  appendFile(text);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};
