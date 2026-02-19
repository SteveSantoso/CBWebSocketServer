'use strict';

/**
 * 日志模块
 * - 以程序启动时间为文件名（格式：YYYY-MM-DD_HH-mm-ss.log），存储在配置的日志目录中
 * - 同时输出到控制台和日志文件
 * - 提供 info / warn / error 三个级别的方法
 * - 所有日志内容使用中文描述
 * - 兼容 pkg 打包后的运行环境（使用 process.execPath 推导路径）
 */

const fs   = require('fs');
const path = require('path');

/**
 * 获取程序运行时的根目录
 * - 打包为 exe 后：exe 所在目录
 * - 直接 node 运行：项目根目录（server.js 所在目录）
 */
function getRuntimeRoot() {
  // pkg 打包后 process.pkg 会被注入，此时以 exe 所在目录为根
  if (process.pkg) {
    return path.dirname(process.execPath);
  }
  // 普通 node 运行，以项目根目录为准
  return path.resolve(__dirname, '..');
}

/**
 * 将日期对象格式化为 YYYY-MM-DD_HH-mm-ss 字符串
 * @param {Date} date
 * @returns {string}
 */
function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const MM   = pad(date.getMonth() + 1);
  const dd   = pad(date.getDate());
  const HH   = pad(date.getHours());
  const mm   = pad(date.getMinutes());
  const ss   = pad(date.getSeconds());
  return `${yyyy}-${MM}-${dd}_${HH}-${mm}-${ss}`;
}

/**
 * 创建日志实例
 * @param {string} logDir - 日志目录（绝对路径或相对于运行根目录的相对路径）
 * @returns {{ info: Function, warn: Function, error: Function, filePath: string }}
 */
function createLogger(logDir) {
  const root       = getRuntimeRoot();
  const absLogDir  = path.isAbsolute(logDir) ? logDir : path.join(root, logDir);

  // 自动创建日志目录（如不存在）
  if (!fs.existsSync(absLogDir)) {
    fs.mkdirSync(absLogDir, { recursive: true });
  }

  // 以启动时间为文件名
  const startTime  = new Date();
  const fileName   = `${formatTimestamp(startTime)}.log`;
  const filePath   = path.join(absLogDir, fileName);

  /**
   * 写入一条日志记录
   * @param {string} level  - 级别标签，如 【信息】【警告】【错误】
   * @param {string} message - 日志内容
   */
  function write(level, message) {
    const now    = new Date();
    const timeStr = formatTimestamp(now).replace('_', ' ').replace(/-/g, '-');
    const line   = `[${timeStr}] ${level} ${message}\n`;
    // 输出到控制台
    process.stdout.write(line);
    // 追加写入日志文件
    try {
      fs.appendFileSync(filePath, line, 'utf8');
    } catch (err) {
      process.stderr.write(`[日志写入失败] ${err.message}\n`);
    }
  }

  return {
    /** 日志文件完整路径，供外部模块展示 */
    filePath,

    /**
     * 记录普通信息日志
     * @param {string} message
     */
    info(message) {
      write('【信息】', message);
    },

    /**
     * 记录警告日志
     * @param {string} message
     */
    warn(message) {
      write('【警告】', message);
    },

    /**
     * 记录错误日志
     * @param {string} message
     */
    error(message) {
      write('【错误】', message);
    },
  };
}

module.exports = { createLogger };
