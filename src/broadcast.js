'use strict';

/**
 * 广播模块
 * - 接收发送方 socket 及其原始消息，转发给所有其他在线客户端（排除发送方）
 * - 消息格式为 JSON，服务端解析后重新序列化广播；解析失败则原文转发
 * - 每次广播记录一条信息日志（发送方 IP、消息内容、在线人数）
 */

const WebSocket = require('ws');

/**
 * 广播消息给除发送方以外的所有在线客户端
 * @param {object}  options
 * @param {WebSocket}           options.sender   - 发送方 socket 实例
 * @param {string}              options.senderIp - 发送方 IP（用于日志）
 * @param {Buffer|string}       options.rawData  - 原始消息数据
 * @param {Set<WebSocket>}      options.clients  - ws.Server.clients 集合
 * @param {object}              options.logger   - 日志模块实例
 */
function broadcast({ sender, senderIp, rawData, clients, logger }) {
  // ── 解析消息 ──────────────────────────────────────────────────
  const rawStr = rawData.toString('utf8');
  let outgoing; // 最终发往客户端的字符串

  try {
    const parsed = JSON.parse(rawStr);
    outgoing = JSON.stringify(parsed); // 重新序列化，确保格式统一
  } catch (_) {
    // 非 JSON 格式，原文转发
    outgoing = rawStr;
  }

  // ── 统计在线人数 ──────────────────────────────────────────────
  let totalOnline   = 0; // 全部在线（含发送方）
  let sentCount     = 0; // 成功发送数量

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      totalOnline++;
    }
  });

  // ── 逐一转发（跳过发送方） ────────────────────────────────────
  clients.forEach((client) => {
    if (client === sender) return;                        // 跳过发送方
    if (client.readyState !== WebSocket.OPEN) return;    // 跳过未就绪连接

    try {
      client.send(outgoing);
      sentCount++;
    } catch (err) {
      logger.error(`向客户端转发消息失败：${err.message}`);
    }
  });

  // ── 记录广播日志 ──────────────────────────────────────────────
  // 消息内容截断至 200 字符，防止日志行过长
  const preview = outgoing.length > 200 ? outgoing.slice(0, 200) + '……（已截断）' : outgoing;
  logger.info(
    `消息广播 → 发送方：${senderIp}，` +
    `已转发至 ${sentCount} 个客户端（当前在线 ${totalOnline} 人），` +
    `消息内容：${preview}`
  );
}

module.exports = { broadcast };
