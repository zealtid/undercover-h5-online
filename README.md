# 3–10 人多端联机 H5「谁是卧底」（文字版 + V2 语音条预留）

基于零外部依赖的 Node.js（原生 HTTP + RFC 6455 WebSocket）与移动端优先 H5 页面，开箱即用，无需 `npm install` 即可直接启动多端联机房间。

## 快速启动

```bash
# 1. 启动服务（默认监听 127.0.0.1:3000，仅本机可访问）
node server.js

# 2. 运行核心状态机单元测试
node tests/fsm.test.js

# 3. 运行外置词库测试
node tests/wordBank.test.js

# 4. 运行昵称校验与音效提示测试
node tests/nickname-audio.test.js
```

本机浏览器打开 `http://127.0.0.1:3000`。若要让同一局域网下的手机访问，需显式绑定所有网卡：

```bash
HOST=0.0.0.0 node server.js
```

然后用手机打开 `http://<你的局域网IP>:3000`，创建房间并将 4 位房间号分享给 3–10 位好友即可联机开玩。

建房/加入必须填写 1–12 字的自定义昵称（空白或「N号玩家」等程序默认名会被拒绝，断线重连沿用原昵称）。提示音由浏览器 Web Audio 本地合成，无外部音频文件；需点击建房/加入后才能解锁声音，首页和对局页均有静音开关，不保证锁屏或后台仍能出声。

## 公网简单部署

本服务为 **HTTP + 原生 WebSocket**，公网请前置 Nginx/Caddy 做 **HTTPS + WSS** 反代（浏览器在 HTTPS 页只能连 WSS）。

```bash
# 常用环境变量（均可选）
HOST=127.0.0.1 \
PORT=3000 \
WORD_BANK_PATH=data/words.json \
MAX_ROOMS=200 \
RATE_CREATE_PER_MIN=8 \
RATE_MSG_PER_MIN=120 \
node server.js
```

健康检查：`GET /health` → `{ ok, rooms, clients, maxRooms, uptime }`。

## 外置词库

默认从仓库内 `data/words.json` 加载词库（相对 `engine/wordBank.js` 为 `../data/words.json`）。设置 `WORD_BANK_PATH` 可改用其他文件：相对路径相对启动时的 `process.cwd()` 解析，也支持绝对路径。

文件格式为 `{ "version": 1, "categories": ["全部", ...], "pairs": [{ "id", "a", "b", "category", "difficulty" }] }`：

- `categories` 必须以 `"全部"` 开头，并覆盖 `pairs` 中出现的全部分类；词对自身不得用 `"全部"` 作为分类。
- 每个词对的 `id` 须为非空且不重复；`a`、`b` 须非空且去空白后不相同；词对之间也不得重复或顺序对调（比较时去空白、大小写不敏感）。
- 启动时严格校验：文件不存在、JSON 非法、缺少 `pairs` 或为空、重复 id、相同词对、未知分类等错误都会抛出明确错误并拒绝启动，不会静默跳过坏数据或回退空库。

改词库后需重启进程才会生效（不提供热加载或词库 HTTP 接口）；重启也会清空内存中的房间，请避开对局中的玩家。

已内置：消息大小限制、连接缓冲上限、房间数量上限、按 IP 的建房/消息频率限制、大厅离线 90s 自动清理、房主踢人、开局须全员在线。

## 项目结构

- `server.js`：零依赖静态文件服务 + 原生 WebSocket 网关 + 房间管理与僵尸房清理
- `engine/fsm.js`：权威游戏状态机（3–10 人配置校验、1–2 卧底、3 人双轮特殊规则、视角裁剪防作弊、禁字拦截、平票 PK、幽灵观战频道、断线重连）
- `engine/wordBank.js`：从 `data/words.json` 加载并严格校验词库（默认 376 组，7 个真实分类 + 虚拟「全部」）
- `data/words.json`：外置词库数据文件（376 组：日常美食/生活物品/影视动漫/职场休闲各 49 组，上班生活/网络生活/旅行出行各 60 组）
- `public/index.html`：移动端优先 H5 客户端（支持断线自动重连与时钟校准）
- `tests/fsm.test.js`：自动化规则验证脚本
- `tests/wordBank.test.js`：外置词库加载、校验与抽词验证脚本

## V2 扩展「按住说话语音条」接入指南

`engine/fsm.js` 的 `submitSpeech()` 与前端发言区已预留完整协议字段：

1. 前端在轮到当前玩家发言时，通过 `navigator.mediaDevices.getUserMedia({ audio: true })` + `MediaRecorder` 录制 `audio/webm` 或 `audio/mp4`（最长 30 秒）。
2. 松手后将音频文件上传至 OSS / 对象存储或 `POST /api/upload-voice`，拿到 `audioUrl` 与 `durationMs`。
3. 通过 WebSocket 发送 `turn:speak` 事件，携带 `{ speechType: 'voice', audioUrl, durationMs, content: '语音发言' }` 即可无缝复用现有麦序锁、倒计时与公屏渲染逻辑。
