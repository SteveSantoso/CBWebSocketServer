'use strict';

/**
 * WebSocket 服务端主程序
 * 功能：
 *  - 根据配置启动 WS（明文）和/或 WSS（TLS 加密）服务器
 *  - 客户端连接/断开时记录日志
 *  - 收到消息后广播给其他所有在线客户端（排除发送方）
 *  - 通过原生 ping/pong 帧实现心跳检测，自动清理僵尸连接
 *  - 捕获 SIGINT 信号优雅关闭服务器
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const WebSocket = require('ws');

const { loadConfig }             = require('./src/config');
const { createLogger }           = require('./src/logger');
const { createHeartbeatManager } = require('./src/heartbeat');
const { broadcast }              = require('./src/broadcast');

// ── 初始化配置 ─────────────────────────────────────────────────
let config;
try {
  config = loadConfig();
} catch (err) {
  process.stderr.write(`[致命错误] 配置加载失败：${err.message}\n`);
  process.exit(1);
}

// ── 初始化日志 ─────────────────────────────────────────────────
const logger = createLogger(config.log.dir);
logger.info(`===== CBWebSocketServer 启动中 =====`);
logger.info(`日志文件路径：${logger.filePath}`);
logger.info(`WS 服务：${config.ws.enabled ? '已启用' : '已禁用'}，WSS 服务：${config.wss.enabled ? '已启用' : '已禁用'}`);
logger.info(`单条消息最大字节数：${(config.maxPayload / 1024 / 1024).toFixed(1)} MB（${config.maxPayload} 字节）`);

// ── 工具函数：获取客户端真实 IP ────────────────────────────────
/**
 * 从 WebSocket 请求头中提取客户端 IP
 * @param {http.IncomingMessage} req
 * @returns {string}
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || '未知';
}

// ── 服务器实例集合（用于优雅关闭） ────────────────────────────
const servers = [];

// ── 统一的连接处理逻辑 ────────────────────────────────────────
/**
 * 为一个 noServer 模式的 WebSocket.Server 绑定连接事件处理器
 * @param {WebSocket.Server} wss   - ws 服务器实例（noServer: true）
 * @param {string}           proto - 协议标签，用于日志（'WS' 或 'WSS'）
 * @param {object}           hbMgr - 心跳管理器实例
 */
function attachHandlers(wss, proto, hbMgr) {
  wss.on('connection', (socket, req) => {
    const ip = getClientIp(req);
    logger.info(`客户端已连接 → 协议：${proto}，IP：${ip}，当前在线：${wss.clients.size} 人`);

    // 注册到心跳管理器
    hbMgr.register(socket, ip);

    // ── 消息事件 ──────────────────────────────────────────────
    socket.on('message', (rawData) => {
      // 拦截应用层心跳消息 {"type":"ping"}
      // 用于支持未实现原生 WebSocket pong 的测试客户端
      let parsed = null;
      try { parsed = JSON.parse(rawData.toString('utf8')); } catch (_) {}

      if (parsed && parsed.type === 'ping') {
        // 标记该连接为存活（等同于收到原生 pong）
        hbMgr.markAlive(socket);
        // 回复应用层 pong
        try {
          socket.send(JSON.stringify({ type: 'pong' }));
        } catch (err) {
          logger.error(`回复应用层 pong 失败，IP：${ip}，错误：${err.message}`);
        }
        return; // 不广播心跳消息
      }

      // 普通业务消息：广播给其他客户端
      broadcast({
        sender:   socket,
        senderIp: ip,
        rawData,
        clients:  wss.clients,
        logger,
      });
    });

    // ── 关闭事件 ─────────────────────────────────────────────
    socket.on('close', (code, reason) => {
      hbMgr.unregister(socket);
      const reasonStr = reason ? reason.toString('utf8') : '无';
      logger.info(
        `客户端已断开 → 协议：${proto}，IP：${ip}，` +
        `关闭码：${code}，原因：${reasonStr}，` +
        `当前在线：${wss.clients.size} 人`
      );
    });

    // ── 错误事件 ─────────────────────────────────────────────
    socket.on('error', (err) => {
      hbMgr.unregister(socket);
      logger.error(`客户端连接异常 → 协议：${proto}，IP：${ip}，错误：${err.message}`);
    });
  });

  wss.on('error', (err) => {
    logger.error(`${proto} 服务器错误：${err.message}`);
  });
}

/**
 * 将一个 HTTP/HTTPS 服务器的 WebSocket 升级请求转发给 wsServer 处理
 * 这是 noServer 模式的核心：多个 HTTP 服务器共享同一个 WebSocket 实例
 * @param {http.Server|https.Server} httpSrv - HTTP(S) 服务器
 * @param {WebSocket.Server}         wsServer - WebSocket 服务器（noServer 模式）
 */
function bindUpgrade(httpSrv, wsServer) {
  httpSrv.on('upgrade', (req, socket, head) => {
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer.emit('connection', ws, req);
    });
  });
}

/**
 * 创建并启动 HTTP(S) 监听器
 * - 始终在配置的 host:port 上监听
 * - 若 host 不是 0.0.0.0 / 127.0.0.1，则额外在 127.0.0.1:port 上监听，
 *   保证本机 localhost 始终可以连接
 * @param {object}   options
 * @param {Function} options.serverFactory - 创建 HTTP(S) 服务器的工厂函数（无参数）
 * @param {string}   options.host          - 配置的监听地址
 * @param {number}   options.port          - 监听端口
 * @param {string}   options.proto         - 协议标签（'WS' 或 'WSS'）
 * @param {string}   options.scheme        - URL scheme（'ws' 或 'wss'）
 * @param {WebSocket.Server} options.wsServer - noServer 模式的 ws 实例
 * @param {object}   options.hbMgr         - 心跳管理器
 * @returns {Array}  返回创建的 HTTP 服务器列表（用于优雅关闭）
 */
function startListeners({ serverFactory, host, port, proto, scheme, wsServer, hbMgr }) {
  const httpServers = [];

  // 是否需要额外监听 127.0.0.1
  const needLoopback = (host !== '0.0.0.0' && host !== '127.0.0.1' && host !== '::1');

  // ── 主监听器（配置的 host）─────────────────────────────────
  const primaryServer = serverFactory();
  bindUpgrade(primaryServer, wsServer);

  primaryServer.listen(port, host, () => {
    logger.info(`${proto} 服务已启动 → ${scheme}://${host}:${port}`);
    if (needLoopback) {
      logger.info(`${proto} 同时监听本地回环 → ${scheme}://127.0.0.1:${port}`);
    }
    hbMgr.start();
  });
  primaryServer.on('error', (err) => {
    logger.error(`${proto} 主监听器（${host}:${port}）失败：${err.message}`);
  });
  httpServers.push(primaryServer);

  // ── 本地回环监听器（127.0.0.1）────────────────────────────
  if (needLoopback) {
    const loopbackServer = serverFactory();
    bindUpgrade(loopbackServer, wsServer);

    loopbackServer.listen(port, '127.0.0.1', () => {
      // 回环监听器启动成功，无需重复打印（主监听器已输出）
    });
    loopbackServer.on('error', (err) => {
      // 回环监听失败不影响主服务，仅记录警告
      logger.warn(`${proto} 本地回环监听器（127.0.0.1:${port}）失败：${err.message}`);
    });
    httpServers.push(loopbackServer);
  }

  return httpServers;
}

// ── 启动 WS 服务器（明文）────────────────────────────────────
if (config.ws.enabled) {
  const hbMgr = createHeartbeatManager({
    interval: config.heartbeat.interval,
    timeout:  config.heartbeat.timeout,
    logger,
  });

  // noServer 模式：WebSocket 实例不绑定任何 HTTP 服务器，
  // 由 bindUpgrade() 手动转发升级请求，支持多个 HTTP 实例共享
  const wsServer = new WebSocket.Server({ noServer: true, maxPayload: config.maxPayload });
  attachHandlers(wsServer, 'WS', hbMgr);

  const httpServers = startListeners({
    serverFactory: () => http.createServer(),
    host:   config.ws.host,
    port:   config.ws.port,
    proto:  'WS',
    scheme: 'ws',
    wsServer,
    hbMgr,
  });

  servers.push({ label: 'WS', httpServers, wsServer, hbMgr });
}

// ── 启动 WSS 服务器（TLS 加密）──────────────────────────────
if (config.wss.enabled) {
  // 读取证书文件
  let tlsOptions;
  try {
    tlsOptions = {
      cert: fs.readFileSync(config.tls.cert),
      key:  fs.readFileSync(config.tls.key),
    };
  } catch (err) {
    logger.error(`读取 TLS 证书失败：${err.message}，WSS 服务将不会启动`);
    // 若 WS 也未启用则无服务可用，直接退出
    if (!config.ws.enabled) {
      process.exit(1);
    }
    // WS 已启用，跳过 WSS
    tlsOptions = null;
  }

  if (tlsOptions) {
    const hbMgr = createHeartbeatManager({
      interval: config.heartbeat.interval,
      timeout:  config.heartbeat.timeout,
      logger,
    });

    const wssServer = new WebSocket.Server({ noServer: true, maxPayload: config.maxPayload });
    attachHandlers(wssServer, 'WSS', hbMgr);

    const httpServers = startListeners({
      serverFactory: () => https.createServer(tlsOptions),
      host:   config.wss.host,
      port:   config.wss.port,
      proto:  'WSS',
      scheme: 'wss',
      wsServer: wssServer,
      hbMgr,
    });

    servers.push({ label: 'WSS', httpServers, wsServer: wssServer, hbMgr });
  }
}

// ── 优雅关闭（捕获 Ctrl+C / SIGINT）──────────────────────────
function gracefulShutdown(signal) {
  logger.info(`收到信号 ${signal}，正在关闭所有服务器……`);

  let pendingCount = servers.length;
  if (pendingCount === 0) {
    logger.info('===== CBWebSocketServer 已停止 =====');
    process.exit(0);
  }

  servers.forEach(({ label, httpServers, wsServer, hbMgr }) => {
    // 停止心跳定时器
    hbMgr.stop();

    // 关闭所有已连接的 WebSocket 客户端
    wsServer.clients.forEach((client) => {
      try { client.terminate(); } catch (_) {}
    });

    // 关闭 WebSocket 服务器，再逐一关闭所有 HTTP 监听器
    wsServer.close(() => {
      let httpPending = httpServers.length;
      httpServers.forEach((srv) => {
        srv.close(() => {
          httpPending--;
          if (httpPending === 0) {
            logger.info(`${label} 服务器已关闭`);
            pendingCount--;
            if (pendingCount === 0) {
              logger.info('===== CBWebSocketServer 已停止 =====');
              process.exit(0);
            }
          }
        });
      });
    });
  });

  // 5 秒内若未能优雅关闭，则强制退出
  setTimeout(() => {
    logger.warn('服务器未能在 5 秒内优雅关闭，强制退出');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 捕获未处理的异常，防止程序意外崩溃
process.on('uncaughtException', (err) => {
  logger.error(`未捕获的异常：${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`未处理的 Promise 拒绝：${reason}`);
});
