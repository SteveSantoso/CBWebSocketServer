# CBWebSocketServer

基于 Node.js 的 WebSocket 服务端，支持 WS / WSS 双协议、点对点心跳检测、僵尸连接自动清理、客户端广播通信，可打包为独立 Windows exe 运行。

---

## 目录结构

```
CBWebSocketServer/
├── cacerts/
│   ├── cacert.pem          # TLS CA 证书（用于 WSS）
│   └── privkey.pem         # TLS 私钥（用于 WSS）
├── dist/                   # 打包输出目录
│   ├── CBWebSocketServer.exe
│   ├── config.json         # 部署时随 exe 一起发布
│   └── cacerts/            # 部署时随 exe 一起发布
├── logs/                   # 日志目录（自动创建）
│   └── YYYY-MM-DD_HH-mm-ss.log
├── src/
│   ├── logger.js           # 日志模块
│   ├── config.js           # 配置加载模块
│   ├── heartbeat.js        # 心跳管理模块
│   └── broadcast.js        # 广播模块
├── server.js               # 主程序入口
├── config.json             # 配置文件
├── package.json
└── .gitignore
```

---

## 快速开始

### 直接运行（需安装 Node.js 20+）

```bash
npm install
npm start
```

### 使用打包的 exe 运行

将以下三项放在同一目录，双击 `CBWebSocketServer.exe` 即可：

```
CBWebSocketServer.exe
config.json
cacerts/
  ├── cacert.pem
  └── privkey.pem
```

---

## 配置说明

编辑 `config.json`，修改后重启服务生效。

```json
{
  "ws": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 8070
  },
  "wss": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 8071
  },
  "tls": {
    "cert": "cacerts/cacert.pem",
    "key": "cacerts/privkey.pem"
  },
  "maxPayload": 10485760,
  "heartbeat": {
    "interval": 5000,
    "timeout": 15000
  },
  "log": {
    "dir": "logs"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `ws.enabled` | boolean | 是否启用明文 WS 服务 |
| `ws.host` | string | WS 监听地址，`0.0.0.0` 表示监听所有网卡 |
| `ws.port` | number | WS 监听端口（默认 `8070`） |
| `wss.enabled` | boolean | 是否启用 TLS 加密 WSS 服务 |
| `wss.host` | string | WSS 监听地址 |
| `wss.port` | number | WSS 监听端口（默认 `8071`） |
| `tls.cert` | string | TLS 证书路径（相对于 exe / server.js 所在目录） |
| `tls.key` | string | TLS 私钥路径 |
| `maxPayload` | number (bytes) | 单条消息最大字节数（默认 `10485760`，即 10 MB），超出则断开连接 |
| `heartbeat.interval` | number (ms) | 心跳发送间隔（默认 `5000`，即 5 秒） |
| `heartbeat.timeout` | number (ms) | 无响应超时时间，超时后清理僵尸连接（默认 `15000`，即 15 秒） |
| `log.dir` | string | 日志目录路径（相对或绝对路径均可） |

> `ws.enabled` 与 `wss.enabled` 不能同时为 `false`，否则启动报错。

---

## 心跳机制

服务端每隔 `heartbeat.interval` 毫秒向所有连接发送心跳探测。  
客户端需在 `heartbeat.timeout` 毫秒内响应，否则该连接将被视为**僵尸连接**并强制断开。

支持两种心跳响应方式，任一方式响应均可保持连接：

### 方式一：原生 WebSocket ping/pong 帧（推荐）

大多数浏览器和标准 WebSocket 库会自动处理底层 ping/pong，无需额外代码。

### 方式二：应用层 JSON 心跳（适用于测试工具 / 不支持原生 pong 的客户端）

客户端主动发送：
```json
{"type": "ping"}
```

服务端回复：
```json
{"type": "pong"}
```

---

## 消息广播

- 消息格式为 **JSON**，服务端解析后广播给其他所有在线客户端
- **不回显**：发送方自身不会收到自己发送的消息
- 若消息不是合法 JSON，则原文以字符串形式广播
- 内置类型 `{"type":"ping"}` 会被服务端拦截处理，**不参与广播**

### 示例

客户端 A 发送：
```json
{"type": "chat", "content": "你好"}
```

在线的客户端 B、C 均收到：
```json
{"type": "chat", "content": "你好"}
```

客户端 A 不收到回显。

---

## 日志

- 每次启动以**启动时间**为文件名创建新日志文件，格式：`YYYY-MM-DD_HH-mm-ss.log`
- 日志存放在 `logs/` 目录（exe 运行时为 exe 所在目录的 `logs/`）
- 同时输出到控制台和日志文件，编码为 UTF-8
- 记录内容：服务器启动/停止、客户端连接/断开、广播消息（含完整内容）、僵尸连接清理、异常错误
- **不记录**每次 ping/pong 心跳帧详情

### 日志示例

```
[2026-02-19 18-46-02] 【信息】 ===== CBWebSocketServer 启动中 =====
[2026-02-19 18-46-02] 【信息】 WS 服务：已启用，WSS 服务：已启用
[2026-02-19 18-46-02] 【信息】 WS  服务已启动 → ws://0.0.0.0:8070
[2026-02-19 18-46-02] 【信息】 WSS 服务已启动 → wss://0.0.0.0:8071
[2026-02-19 18-46-10] 【信息】 客户端已连接 → 协议：WS，IP：127.0.0.1，当前在线：1 人
[2026-02-19 18-46-15] 【信息】 消息广播 → 发送方：127.0.0.1，已转发至 2 个客户端（当前在线 3 人），消息内容：{"type":"chat","content":"你好"}
[2026-02-19 18-47-01] 【警告】 僵尸连接已清理 → 客户端 IP：192.168.1.5，距上次响应已超过 15 秒
[2026-02-19 18-47-30] 【信息】 客户端已断开 → 协议：WS，IP：127.0.0.1，关闭码：1000，原因：正常关闭，当前在线：0 人
```

---

## 打包为 exe

```bash
npm run build
```

输出文件：`dist/CBWebSocketServer.exe`（约 43 MB，含 Node.js 20 运行时，无需目标机器安装 Node.js）

> 打包目标平台为 `node20-win-x64`，即 Windows 64 位系统。

---

## 技术栈

| 组件 | 说明 |
|------|------|
| [ws](https://github.com/websockets/ws) | WebSocket 服务端库 |
| [@yao-pkg/pkg](https://github.com/yao-pkg/pkg) | Node.js 应用打包工具 |
| Node.js 20 | 运行时环境 |
