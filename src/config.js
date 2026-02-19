'use strict';

/**
 * 配置加载模块
 * - 读取并解析 config.json
 * - 将证书路径、日志路径等相对路径解析为绝对路径
 * - 兼容 pkg 打包后的运行环境
 * - 校验必填字段合法性
 */

const fs   = require('fs');
const path = require('path');

// 无需 mode 枚举，改用 ws.enabled / wss.enabled 布尔值控制

/**
 * 获取程序运行时的根目录
 * - 打包为 exe 后：exe 所在目录
 * - 直接 node 运行：项目根目录
 */
function getRuntimeRoot() {
  if (process.pkg) {
    return path.dirname(process.execPath);
  }
  return path.resolve(__dirname, '..');
}

/**
 * 将相对路径解析为绝对路径（以运行根目录为基准）
 * @param {string} relativePath
 * @returns {string} 绝对路径
 */
function resolveFromRoot(relativePath) {
  const root = getRuntimeRoot();
  return path.isAbsolute(relativePath)
    ? relativePath
    : path.join(root, relativePath);
}

/**
 * 加载并返回配置对象
 * @returns {object} 解析后的配置
 */
function loadConfig() {
  // 配置文件路径：运行根目录下的 config.json
  const configPath = resolveFromRoot('config.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(`找不到配置文件：${configPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`配置文件解析失败：${err.message}`);
  }

  // ── 字段校验 ──────────────────────────────────────────────────

  // WS 配置（enabled 默认为 true）
  const ws = {
    enabled: raw.ws && raw.ws.enabled !== undefined ? Boolean(raw.ws.enabled) : true,
    host:    (raw.ws && raw.ws.host) || '0.0.0.0',
    port:    (raw.ws && Number(raw.ws.port)) || 8070,
  };

  // WSS 配置（enabled 默认为 true）
  const wss = {
    enabled: raw.wss && raw.wss.enabled !== undefined ? Boolean(raw.wss.enabled) : true,
    host:    (raw.wss && raw.wss.host) || '0.0.0.0',
    port:    (raw.wss && Number(raw.wss.port)) || 8071,
  };

  // 至少启用一种协议
  if (!ws.enabled && !wss.enabled) {
    throw new Error('配置错误：ws.enabled 和 wss.enabled 不能同时为 false，至少需启用一种协议');
  }

  // TLS 证书路径（解析为绝对路径）
  const tls = {
    cert: resolveFromRoot((raw.tls && raw.tls.cert) || 'cacerts/cacert.pem'),
    key:  resolveFromRoot((raw.tls && raw.tls.key)  || 'cacerts/privkey.pem'),
  };

  // 单条消息最大字节数（默认 10 MB）
  const maxPayload = (raw.maxPayload !== undefined)
    ? Number(raw.maxPayload)
    : 10 * 1024 * 1024; // 10 MB

  if (maxPayload <= 0) {
    throw new Error('配置项 maxPayload 必须为正整数（单位：字节）');
  }

  // 心跳配置（毫秒）
  const heartbeat = {
    interval: (raw.heartbeat && Number(raw.heartbeat.interval)) || 15000,
    timeout:  (raw.heartbeat && Number(raw.heartbeat.timeout))  || 30000,
  };

  // 日志配置
  const log = {
    dir: resolveFromRoot((raw.log && raw.log.dir) || 'logs'),
  };

  // WSS 启用时校验证书文件是否存在
  if (wss.enabled) {
    if (!fs.existsSync(tls.cert)) {
      throw new Error(`TLS 证书文件不存在：${tls.cert}`);
    }
    if (!fs.existsSync(tls.key)) {
      throw new Error(`TLS 私钥文件不存在：${tls.key}`);
    }
  }

  return { ws, wss, tls, maxPayload, heartbeat, log };
}

module.exports = { loadConfig };
