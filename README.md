# 3–10 人多端联机 H5「谁是卧底」（文字版 + V2 语音条预留）

基于零外部依赖的 Node.js（原生 HTTP + RFC 6455 WebSocket）与移动端优先 H5 页面，开箱即用，无需 `npm install` 即可直接启动多端联机房间。

## 快速启动

```bash
# 1. 启动服务（默认监听 3000 端口，支持局域网手机直接访问）
node server.js

# 2. 运行核心状态机单元测试
node tests/fsm.test.js
```

启动后在浏览器或同一局域网下的手机浏览器打开 `http://<你的局域网IP>:3000`，创建房间并将 4 位房间号分享给 3–10 位好友即可联机开玩。

## 公网简单部署

本服务为 **HTTP + 原生 WebSocket**，公网请前置 Nginx/Caddy 做 **HTTPS + WSS** 反代（浏览器在 HTTPS 页只能连 WSS）。

```bash
# 常用环境变量（均可选）
PORT=3000 \
MAX_ROOMS=200 \
RATE_CREATE_PER_MIN=8 \
RATE_MSG_PER_MIN=120 \
node server.js
```

健康检查：`GET /health` → `{ ok, rooms, clients, maxRooms, uptime }`。

已内置：消息大小限制、连接缓冲上限、房间数量上限、按 IP 的建房/消息频率限制、大厅离线 90s 自动清理、房主踢人、开局须全员在线。

## 项目结构

- `server.js`：零依赖静态文件服务 + 原生 WebSocket 网关 + 房间管理与僵尸房清理
- `engine/fsm.js`：权威游戏状态机（3–10 人配置校验、1–2 卧底、3 人双轮特殊规则、视角裁剪防作弊、禁字拦截、平票 PK、幽灵观战频道、断线重连）
- `engine/wordBank.js`：100 组精选中文双词库（日常美食、生活物品、影视动漫、职场休闲）
- `public/index.html`：移动端优先 H5 客户端（支持断线自动重连与时钟校准）
- `tests/fsm.test.js`：自动化规则验证脚本

## V2 扩展「按住说话语音条」接入指南

`engine/fsm.js` 的 `submitSpeech()` 与前端发言区已预留完整协议字段：

1. 前端在轮到当前玩家发言时，通过 `navigator.mediaDevices.getUserMedia({ audio: true })` + `MediaRecorder` 录制 `audio/webm` 或 `audio/mp4`（最长 30 秒）。
2. 松手后将音频文件上传至 OSS / 对象存储或 `POST /api/upload-voice`，拿到 `audioUrl` 与 `durationMs`。
3. 通过 WebSocket 发送 `turn:speak` 事件，携带 `{ speechType: 'voice', audioUrl, durationMs, content: '语音发言' }` 即可无缝复用现有麦序锁、倒计时与公屏渲染逻辑。
