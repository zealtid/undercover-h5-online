// Zero-dependency Node.js HTTP + Native RFC 6455 WebSocket Server
// Serves the mobile-first H5 client (`public/index.html`) and hosts live 3-10 player Undercover rooms.
// Hardened for small-scale public deploy: payload caps, room caps, basic IP rate limits.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UndercoverRoom } = require('./engine/fsm');
const { CATEGORIES } = require('./engine/wordBank');
const {
  initDb,
  getStatus: getDbStatus,
  persistGameSettlement,
  upsertWordFeedback
} = require('./engine/db');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
const MAX_MSG_BYTES = Number(process.env.MAX_MSG_BYTES) || 8 * 1024;
const MAX_BUFFER_BYTES = Number(process.env.MAX_BUFFER_BYTES) || 64 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_CREATE_PER_MIN = Number(process.env.RATE_CREATE_PER_MIN) || 8;
const RATE_MSG_PER_MIN = Number(process.env.RATE_MSG_PER_MIN) || 120;
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const FEEDBACK_FILE = path.join(__dirname, 'data', 'word-feedback.jsonl');

function logWordFeedback(entry) {
  try {
    const dir = path.dirname(FEEDBACK_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFile(FEEDBACK_FILE, JSON.stringify(entry) + '\n', () => {});
  } catch (_) {}
}

// Active rooms: roomCode -> UndercoverRoom
const rooms = new Map();
// Active sockets: socket -> { roomCode, playerId, buffer, ip }
const clients = new Map();
// ip -> { windowStart, creates, msgs }
const rateBuckets = new Map();

function clientIp(reqOrSocket, req) {
  const headers = (req && req.headers) || {};
  const xff = headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    return xff.split(',')[0].trim().slice(0, 64);
  }
  const remote = (reqOrSocket && reqOrSocket.remoteAddress) || '';
  return String(remote).replace(/^::ffff:/, '') || 'unknown';
}

function getRateBucket(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.windowStart > RATE_WINDOW_MS) {
    b = { windowStart: now, creates: 0, msgs: 0 };
    rateBuckets.set(ip, b);
  }
  return b;
}

function checkRate(ip, kind) {
  const b = getRateBucket(ip);
  b.msgs += 1;
  if (b.msgs > RATE_MSG_PER_MIN) {
    return { ok: false, error: '请求过于频繁，请稍后再试' };
  }
  if (kind === 'create') {
    b.creates += 1;
    if (b.creates > RATE_CREATE_PER_MIN) {
      return { ok: false, error: '创建房间过于频繁，请稍后再试' };
    }
  }
  return { ok: true };
}

function encodeWsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendJson(socket, obj) {
  if (!socket || socket.destroyed || !socket.writable) return;
  try {
    socket.write(encodeWsFrame(JSON.stringify(obj)));
  } catch (_) {}
}

function findSocketByPlayer(roomCode, playerId) {
  for (const [sock, meta] of clients.entries()) {
    if (meta.roomCode === roomCode && meta.playerId === playerId) return sock;
  }
  return null;
}

function broadcastRoom(room) {
  for (const [sock, meta] of clients.entries()) {
    if (meta.roomCode === room.roomCode && meta.playerId) {
      sendJson(sock, {
        type: 'room:snapshot',
        data: room.getPlayerSnapshot(meta.playerId)
      });
    }
  }
}

/** After in-memory settlement, try one optional DB write; failures only log. */
function maybePersistSettlement(room) {
  if (!room || room.phase !== 'SETTLEMENT' || room._dbSettlementAttempted) return;
  const record = room.getSettlementRecord();
  if (!record) return;
  room._dbSettlementAttempted = true;
  room._dbSettlementOk = false;
  room._dbSettlementPromise = persistGameSettlement(record)
    .then((res) => {
      if (res && res.ok) {
        room._dbSettlementOk = true;
        return res;
      }
      // Allow a later state-change (e.g. feedback) to retry once disk is back
      if (res && !res.skipped) {
        room._dbSettlementAttempted = false;
        console.warn('[db] settlement persist failed for room', room.roomCode);
      }
      return res;
    })
    .catch((err) => {
      room._dbSettlementAttempted = false;
      console.warn('[db] settlement persist error:', err && err.message ? err.message : 'unknown');
      return { ok: false, error: err && err.message ? err.message : 'unknown' };
    });
}

function onRoomStateChange(room) {
  broadcastRoom(room);
  maybePersistSettlement(room);
}

function createUniqueRoom() {
  if (rooms.size >= MAX_ROOMS) {
    return { ok: false, error: '服务器房间已满，请稍后再试' };
  }
  let code;
  let attempts = 0;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
    if (attempts > 50) {
      return { ok: false, error: '暂时无法分配房间号，请重试' };
    }
  } while (rooms.has(code));
  const room = new UndercoverRoom(code, onRoomStateChange);
  rooms.set(code, room);
  return { ok: true, room };
}

function handleMessage(socket, rawText) {
  if (rawText.length > MAX_MSG_BYTES) {
    return sendJson(socket, { type: 'error', message: '消息过大' });
  }

  let msg;
  try {
    msg = JSON.parse(rawText);
  } catch {
    return sendJson(socket, { type: 'error', message: '无效的消息格式' });
  }

  const meta = clients.get(socket);
  if (!meta) return;

  const rate = checkRate(meta.ip, msg.type === 'room:create' ? 'create' : 'msg');
  if (!rate.ok) return sendJson(socket, { type: 'error', message: rate.error });

  if (msg.type === 'ping') {
    return sendJson(socket, { type: 'pong', serverNow: Date.now() });
  }

  if (msg.type === 'room:create') {
    const created = createUniqueRoom();
    if (!created.ok) return sendJson(socket, { type: 'error', message: created.error });
    const room = created.room;
    const res = room.addPlayer({ nickname: msg.nickname, avatar: msg.avatar || '🦊' });
    if (!res.ok) {
      rooms.delete(room.roomCode);
      return sendJson(socket, { type: 'error', message: res.error });
    }
    meta.roomCode = room.roomCode;
    meta.playerId = res.player.id;
    sendJson(socket, {
      type: 'session:joined',
      roomCode: room.roomCode,
      playerId: res.player.id,
      reconnectToken: res.player.token,
      categories: CATEGORIES
    });
    broadcastRoom(room);
    return;
  }

  if (msg.type === 'room:join') {
    const code = String(msg.roomCode || '').trim();
    if (!/^\d{4}$/.test(code)) {
      return sendJson(socket, { type: 'error', message: '房间号须为 4 位数字', code: 'ROOM_INVALID' });
    }
    const room = rooms.get(code);
    if (!room) {
      return sendJson(socket, { type: 'error', message: `房间 ${code} 不存在或已关闭`, code: 'ROOM_NOT_FOUND' });
    }
    const res = room.addPlayer({
      nickname: msg.nickname,
      avatar: msg.avatar || '🐼',
      reconnectToken: msg.reconnectToken || null
    });
    if (!res.ok) return sendJson(socket, { type: 'error', message: res.error });
    meta.roomCode = room.roomCode;
    meta.playerId = res.player.id;
    sendJson(socket, {
      type: 'session:joined',
      roomCode: room.roomCode,
      playerId: res.player.id,
      reconnectToken: res.player.token,
      reconnected: res.reconnected,
      categories: CATEGORIES
    });
    broadcastRoom(room);
    return;
  }

  const room = meta.roomCode ? rooms.get(meta.roomCode) : null;
  if (!room || !meta.playerId) {
    return sendJson(socket, { type: 'error', message: '请先加入房间' });
  }

  let res = { ok: true };
  switch (msg.type) {
    case 'room:config':
      res = room.updateConfig(meta.playerId, msg.config || {});
      break;
    case 'player:ready':
      res = room.toggleReady(meta.playerId);
      break;
    case 'game:start':
      res = room.startGame(meta.playerId);
      break;
    case 'turn:speak':
      res = room.submitSpeech(meta.playerId, {
        speechType: msg.speechType || 'text',
        content: msg.content || '',
        audioUrl: msg.audioUrl || null,
        durationMs: msg.durationMs || 0
      });
      break;
    case 'vote:cast':
      res = room.castVote(meta.playerId, msg.targetPlayerId);
      break;
    case 'ghost:chat':
      res = room.sendGhostMessage(meta.playerId, msg.content || '');
      break;
    case 'game:self_reveal_start':
      res = room.startSelfReveal(meta.playerId);
      break;
    case 'game:self_reveal_guess':
      res = room.submitSelfRevealGuess(meta.playerId, msg.guessWord || '');
      break;
    case 'ghost:place_bet':
      res = room.placeGhostBet(meta.playerId, msg.betType, msg.target);
      break;
    case 'game:reset':
      res = room.resetToLobby(meta.playerId);
      break;
    case 'word:feedback': {
      res = room.submitWordFeedback(meta.playerId, msg.rating);
      if (res.ok && !res.unchanged && res.wordPair) {
        logWordFeedback({
          ts: Date.now(),
          roomCode: room.roomCode,
          playerId: meta.playerId,
          rating: res.rating,
          wordId: res.wordPair.id,
          category: res.wordPair.category,
          civilianWord: res.wordPair.civilianWord,
          undercoverWord: res.wordPair.undercoverWord,
          stats: res.stats
        });
        // Wait for settlement row when possible so game_id FK does not race
        void (async () => {
          if (room._dbSettlementPromise) {
            try {
              await room._dbSettlementPromise;
            } catch (_) {}
          }
          await upsertWordFeedback({
            playerId: meta.playerId,
            wordPairId: res.wordPair.id,
            rating: res.rating,
            roomCode: room.roomCode,
            gameId: room._dbSettlementOk ? room.gameId : null,
            civilianWord: res.wordPair.civilianWord,
            undercoverWord: res.wordPair.undercoverWord
          });
        })().catch((err) => {
          console.warn('[db] feedback upsert error:', err && err.message ? err.message : 'unknown');
        });
        sendJson(socket, { type: 'word:feedback:ack', rating: res.rating, stats: res.stats });
      }
      break;
    }
    case 'room:kick': {
      const targetId = msg.targetPlayerId;
      const kickedSock = findSocketByPlayer(room.roomCode, targetId);
      if (kickedSock) {
        const kickedMeta = clients.get(kickedSock);
        if (kickedMeta) {
          kickedMeta.roomCode = null;
          kickedMeta.playerId = null;
        }
      }
      res = room.kickPlayer(meta.playerId, targetId);
      if (res.ok) {
        if (kickedSock) {
          sendJson(kickedSock, {
            type: 'session:kicked',
            message: '你已被房主移出房间'
          });
        }
        return;
      }
      // kick failed — restore binding if we cleared it
      if (kickedSock) {
        const kickedMeta = clients.get(kickedSock);
        if (kickedMeta && !kickedMeta.playerId) {
          kickedMeta.roomCode = room.roomCode;
          kickedMeta.playerId = targetId;
        }
      }
      break;
    }
    case 'room:leave':
      room.removePlayer(meta.playerId);
      meta.roomCode = null;
      meta.playerId = null;
      sendJson(socket, { type: 'session:left' });
      return;
    default:
      res = { ok: false, error: `未知事件: ${msg.type}` };
  }

  if (res && !res.ok) {
    sendJson(socket, { type: 'error', message: res.error });
  }
}

function parseWsFrames(socket, meta) {
  let buf = meta.buffer;
  while (buf.length >= 2) {
    const firstByte = buf[0];
    const secondByte = buf[1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLen = secondByte & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < 4) break;
      payloadLen = buf.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buf.length < 10) break;
      payloadLen = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }

    if (payloadLen > MAX_MSG_BYTES) {
      sendJson(socket, { type: 'error', message: '消息过大' });
      socket.end();
      return;
    }

    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + payloadLen) break;

    let payload = buf.subarray(offset + maskLen, offset + maskLen + payloadLen);
    if (masked) {
      const maskKey = buf.subarray(offset, offset + 4);
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i] ^ maskKey[i % 4];
      }
      payload = unmasked;
    }

    buf = buf.subarray(offset + maskLen + payloadLen);

    if (opcode === 0x8) {
      socket.end();
      break;
    } else if (opcode === 0x9) {
      const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
      socket.write(pong);
    } else if (opcode === 0x1) {
      handleMessage(socket, payload.toString('utf8'));
    }
  }
  meta.buffer = buf;
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
const SHARED_JS = path.join(PUBLIC_DIR, 'shared.js');

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/health') {
    const db = getDbStatus();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    });
    return res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      clients: clients.size,
      maxRooms: MAX_ROOMS,
      uptime: Math.floor(process.uptime()),
      db: {
        enabled: db.enabled,
        configured: db.configured
      }
    }));
  }

  // Shared client helpers (same module the backend requires); no directory listing.
  if (url === '/shared.js') {
    fs.readFile(SHARED_JS, 'utf8', (err, js) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Failed to load shared helpers');
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(js);
    });
    return;
  }

  // Only serve the single H5 page (no directory listing)
  if (url !== '/' && url !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }

  fs.readFile(INDEX_HTML, 'utf8', (err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Failed to load H5 client');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY'
    });
    res.end(html);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers['upgrade'] !== 'websocket') {
    socket.destroy();
    return;
  }

  // Soft cap concurrent sockets
  if (clients.size >= MAX_ROOMS * 12) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const meta = {
    roomCode: null,
    playerId: null,
    buffer: Buffer.alloc(0),
    ip: clientIp(socket, req)
  };
  clients.set(socket, meta);

  socket.on('data', chunk => {
    if (meta.buffer.length + chunk.length > MAX_BUFFER_BYTES) {
      sendJson(socket, { type: 'error', message: '连接缓冲溢出' });
      socket.end();
      return;
    }
    meta.buffer = Buffer.concat([meta.buffer, chunk]);
    parseWsFrames(socket, meta);
  });

  const cleanup = () => {
    const info = clients.get(socket);
    clients.delete(socket);
    if (info && info.roomCode && info.playerId) {
      const room = rooms.get(info.roomCode);
      if (room) room.markDisconnected(info.playerId);
    }
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

// GC: zombie rooms + lobby offline prune + rate bucket sweep
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.phase === 'LOBBY') {
      room.pruneOfflineLobbyPlayers(90 * 1000);
    }
    const onlineCount = room.players.filter(p => p.online).length;
    if ((onlineCount === 0 && now - room.lastActiveAt > 3 * 60 * 1000) ||
        now - room.lastActiveAt > 30 * 60 * 1000) {
      room.clearTimer();
      rooms.delete(code);
    }
  }
  for (const [ip, b] of rateBuckets.entries()) {
    if (now - b.windowStart > RATE_WINDOW_MS * 2) rateBuckets.delete(ip);
  }
}, 60 * 1000);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Undercover H5 Online Server running at http://${HOST}:${PORT} (HOST=${HOST}, PORT=${PORT})`);
    console.log(`Limits: maxRooms=${MAX_ROOMS}, msgBytes=${MAX_MSG_BYTES}, create/min=${RATE_CREATE_PER_MIN}`);
    // Optional DB: probe after listen so rooms stay available if PG is down
    void initDb().then((ok) => {
      if (!ok) {
        const st = getDbStatus();
        if (!st.configured) {
          console.log('[db] UNDERCOVER_PG* not set; memory-only mode');
        }
      }
    });
  });
}

module.exports = { server, rooms };
