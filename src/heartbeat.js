'use strict';

/**
 * 心跳管理模块
 * - 使用 WebSocket 协议原生 ping/pong 帧（非应用层消息）
 * - 每隔 heartbeat.interval 毫秒向所有连接发送 ping
 * - 收到 pong 后标记该连接为存活
 * - 超过 heartbeat.timeout 毫秒未响应的连接视为"僵尸连接"并强制断开
 * - 仅在清理僵尸连接时记录一条警告日志，ping/pong 本身不记录日志
 */

const WebSocket = require('ws');

/**
 * 创建心跳管理器
 * @param {object}   options
 * @param {number}   options.interval  - ping 发送间隔（毫秒）
 * @param {number}   options.timeout   - 无响应超时时间（毫秒）
 * @param {object}   options.logger    - 日志模块实例（含 warn / error 方法）
 * @returns {{ register: Function, unregister: Function, start: Function, stop: Function }}
 */
function createHeartbeatManager({ interval, timeout, logger }) {
  // Map: ws 实例 → { isAlive: boolean, lastPingSentAt: number, ip: string }
  const clientMap = new Map();

  // 定时器句柄
  let timer = null;

  /**
   * 注册一个新连接到心跳管理器
   * @param {WebSocket} socket - WebSocket 连接实例
   * @param {string}    ip     - 客户端 IP（用于日志）
   */
  function register(socket, ip) {
    // 首次注册时标记为存活
    clientMap.set(socket, { isAlive: true, lastPingSentAt: Date.now(), ip });

    // 监听 pong 帧：收到即标记为存活
    socket.on('pong', () => {
      const entry = clientMap.get(socket);
      if (entry) {
        entry.isAlive = true;
      }
    });
  }

  /**
   * 从心跳管理器中移除一个连接（连接正常关闭或出错时调用）
   * @param {WebSocket} socket
   */
  function unregister(socket) {
    clientMap.delete(socket);
  }

  /**
   * 启动心跳定时检查
   * 逻辑：
   *  1. 每隔 interval 毫秒执行一次检查
   *  2. 将上一轮存活的连接重置为"待确认"状态（isAlive = false），然后发送 ping
   *  3. 下一轮检查时，若 isAlive 仍为 false，说明超过 timeout 未响应，强制断开
   */
  function start() {
    if (timer) return; // 防止重复启动

    timer = setInterval(() => {
      const now = Date.now();

      clientMap.forEach((entry, socket) => {
        // 若上一轮 ping 发出后至今未收到 pong，且超过 timeout，则清理
        if (!entry.isAlive && (now - entry.lastPingSentAt) >= timeout) {
          logger.warn(
            `僵尸连接已清理 → 客户端 IP：${entry.ip}，` +
            `距上次响应已超过 ${Math.round((now - entry.lastPingSentAt) / 1000)} 秒`
          );
          clientMap.delete(socket);
          try {
            socket.terminate(); // 强制断开，不发送 close 帧
          } catch (_) {
            // 连接可能已经断开，忽略错误
          }
          return;
        }

        // 将连接标记为"待确认"，然后发送 ping
        entry.isAlive = false;
        entry.lastPingSentAt = now;

        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.ping(); // 发送原生 ping 帧
          }
        } catch (err) {
          logger.error(`向客户端 ${entry.ip} 发送心跳包时出错：${err.message}`);
        }
      });
    }, interval);
  }

  /**
   * 停止心跳定时器并清空所有连接记录
   */
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    clientMap.clear();
  }

  /**
   * 应用层心跳接口：主动将某连接标记为存活
   * 供外部模块在收到客户端应用层 ping 消息时调用，
   * 用于支持没有原生 pong 能力的测试客户端
   * @param {WebSocket} socket
   */
  function markAlive(socket) {
    const entry = clientMap.get(socket);
    if (entry) {
      entry.isAlive = true;
    }
  }

  return { register, unregister, start, stop, markAlive };
}

module.exports = { createHeartbeatManager };
