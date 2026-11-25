// Authoritative Finite State Machine (FSM) for 3-10 Player Online "Who is the Undercover"
// Designed for zero-trust multiplayer: View Projection strips secret roles & other words before broadcast.
// V1 supports text speaking; speech schema reserves `speechType: 'text' | 'voice'` and `audioUrl` for V2 Push-to-Talk.

const crypto = require('crypto');
const { WORD_BANK } = require('./wordBank');
const { validateNickname } = require('./nickname');

const PHASES = {
  LOBBY: 'LOBBY',
  SPEAKING: 'SPEAKING',
  VOTING: 'VOTING',
  TIE_PK: 'TIE_PK',
  SPY_GUESS: 'SPY_GUESS',
  SETTLEMENT: 'SETTLEMENT'
};

const ROLES = {
  CIVILIAN: 'CIVILIAN',
  UNDERCOVER: 'UNDERCOVER',
  BLANK: 'BLANK'
};

const DEFAULT_CONFIG = {
  spyCount: 1,            // 1 or 2 (3-5 players locked to 1; 6-10 players allow 1 or 2)
  blankCount: 0,          // 0 or 1 (only allowed when playerCount >= 6)
  category: '全部',
  speakTimeoutSec: 45,
  voteTimeoutSec: 30,
  revealRoleOnOut: false, // Default: hide eliminated player's role until settlement
  preferCivilianFirst: true,
  delayedSpyReveal: true,   // M1：双卧底第 2 轮起互认（仅 spyCount === 2 生效）
  easterEggMode: false,     // M2：房主开关，开启后按概率触发彩蛋局
  easterEggRate: 0.08,      // M2：触发概率（建议 0.05 ~ 0.10）
  allowSpySelfReveal: true, // M3：允许主动发起自爆猜词
  enableGhostBet: true,     // M4：开启观战席上帝押注
  allowSpectators: true,    // 是否允许外部观战（对局中或满 10 人时自动落入观战席）
  maxSpectators: 20,        // 观战席人数上限
  spectatorGodView: false   // false=推理观战（防报点）；true=上帝视角观战
};

function normalizeGuessWord(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '');
}

function generateId(prefix = 'p') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function generateRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Validate and clamp room config based on current player count (3-10).
 */
function sanitizeConfig(config, playerCount) {
  const next = { ...DEFAULT_CONFIG, ...config };
  const n = Math.max(3, Math.min(10, playerCount || 3));
  if (n <= 5) {
    next.spyCount = 1;
    next.blankCount = 0;
  } else {
    next.spyCount = next.spyCount === 2 ? 2 : 1;
    next.blankCount = next.blankCount === 1 ? 1 : 0;
  }
  next.speakTimeoutSec = Math.max(15, Math.min(120, Number(next.speakTimeoutSec) || 45));
  next.voteTimeoutSec = Math.max(15, Math.min(90, Number(next.voteTimeoutSec) || 30));
  next.delayedSpyReveal = next.delayedSpyReveal !== false;
  next.easterEggMode = next.easterEggMode === true;
  const rate = Number(next.easterEggRate);
  next.easterEggRate = Number.isFinite(rate) ? Math.max(0.05, Math.min(0.10, rate)) : 0.08;
  next.allowSpySelfReveal = next.allowSpySelfReveal !== false;
  next.enableGhostBet = next.enableGhostBet !== false;
  next.allowSpectators = next.allowSpectators !== false;
  const maxSp = Number(next.maxSpectators);
  next.maxSpectators = Number.isFinite(maxSp) ? Math.max(1, Math.min(50, Math.floor(maxSp))) : 20;
  next.spectatorGodView = next.spectatorGodView === true;
  // Never accept client-supplied test hooks via room:config
  delete next._forceEasterEggType;
  return next;
}

/**
 * Server-side taboo character check: returns matched forbidden char or null.
 */
function checkTabooWord(text, secretWord) {
  if (!secretWord || !text) return null;
  const normalizedText = text.trim().toLowerCase();
  const normalizedWord = secretWord.trim().toLowerCase();
  if (normalizedText.includes(normalizedWord)) return secretWord;
  // Block any single CJK character from the secret word
  for (const ch of normalizedWord) {
    if (/[\u4e00-\u9fa5]/.test(ch) && normalizedText.includes(ch)) {
      return ch;
    }
  }
  return null;
}

class UndercoverRoom {
  constructor(roomCode = generateRoomCode(), onStateChange = () => {}) {
    this.roomCode = roomCode;
    this.onStateChange = onStateChange;
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();

    this.phase = PHASES.LOBBY;
    this.config = { ...DEFAULT_CONFIG };
    this.hostId = null;

    // Players list (ordered by seat 1..10)
    // { id, seat, nickname, avatar, token, online, ready, alive, role, word, disconnectedAt }
    this.players = [];

    // External spectator gallery (completely separate from this.players)
    // { id, nickname, avatar, token, online, wantToPlay, joinedAt, disconnectedAt }
    this.spectators = [];

    // Per-round state
    this.roundNumber = 0;
    this.speakingSubRound = 1; // Used for 3-player game (requires 2 speaking rounds before 1st vote)
    this.usedWordIds = new Set();
    this.currentWordPair = null; // { id, civilianWord, undercoverWord, category }

    // Turn state
    this.turnOrder = [];      // array of playerIds
    this.turnIndex = 0;
    this.currentSpeakerId = null;
    this.speeches = [];       // { id, round, subRound, playerId, seat, nickname, speechType: 'text'|'voice', content, audioUrl?, durationMs?, ts }

    // Voting state
    this.votes = {};          // voterId -> targetId
    this.pkCandidates = [];   // non-empty during TIE_PK or PK re-vote
    this.consecutiveTies = 0;
    this.lastVoteSummary = null; // { round, tally, eliminatedId, eliminatedRole?, isTie, note }

    // Ghost / Spectator chat (only visible to eliminated players)
    this.ghostMessages = [];  // { id, playerId, seat, nickname, content, ts }

    // M2: Easter egg round type (null | 'ALL_SAME' | 'ALL_DIFFERENT')
    this.easterEggType = null;
    this.completedVoteRounds = 0;

    // M3: Self-reveal guess
    this.guessingPlayerId = null;
    this.pausedPhase = null;
    this.selfRevealNotice = null; // { seat, nickname, status, note }

    // M4: Ghost bets
    // { [playerId]: { finalWinner: 'CIVILIAN'|'UNDERCOVER'|null, byRound: { [round]: targetId }, score: 0 } }
    this.ghostBets = {};
    this.bestSpectator = null;
    this.ghostBetRefundNote = null;
    // Test-only: set before startGame to force easter egg type (never via client config)
    this._forceEasterEggType = null;

    // Settlement
    this.winner = null;       // 'CIVILIAN' | 'UNDERCOVER' | 'EASTER_EGG' | null
    this.winReason = '';
    // Word-pair feedback at settlement: playerId -> 'up' | 'down'
    this.wordFeedbacks = {};
    // Optional DB persistence: UUID generated at startGame, reused on retry
    this.gameId = null;
    this.gameStartedAt = null;
    this.gameEndedAt = null;
    this._dbSettlementAttempted = false;
    this._dbSettlementOk = false;
    this._dbSettlementPromise = null;

    // Timer
    this.phaseEndsAt = null;
    this._timerHandle = null;
  }

  getWordFeedbackStats() {
    let up = 0;
    let down = 0;
    Object.values(this.wordFeedbacks).forEach(v => {
      if (v === 'up') up += 1;
      else if (v === 'down') down += 1;
    });
    return { up, down };
  }

  touch() {
    this.lastActiveAt = Date.now();
  }

  clearTimer() {
    if (this._timerHandle) {
      clearTimeout(this._timerHandle);
      this._timerHandle = null;
    }
    this.phaseEndsAt = null;
  }

  scheduleTimer(seconds, callback) {
    this.clearTimer();
    this.phaseEndsAt = Date.now() + seconds * 1000;
    this._timerHandle = setTimeout(() => {
      this._timerHandle = null;
      callback();
    }, seconds * 1000);
  }

  nextFreeSeat() {
    const usedSeats = new Set(this.players.map(p => p.seat));
    let seat = 1;
    while (usedSeats.has(seat) && seat <= 10) seat++;
    return seat <= 10 ? seat : null;
  }

  transferHostAway(fromId) {
    const nextPlayer = this.players.find(p => p.online && p.id !== fromId);
    if (nextPlayer) {
      this.hostId = nextPlayer.id;
      nextPlayer.ready = true;
      return;
    }
    const nextSpectator = this.spectators.find(s => s.online && s.id !== fromId);
    this.hostId = nextSpectator ? nextSpectator.id : null;
  }

  addSpectatorMember({ nickname, avatar }) {
    const nameCheck = validateNickname(nickname);
    if (!nameCheck.ok) {
      return { ok: false, error: nameCheck.error };
    }
    if (!this.config.allowSpectators) {
      return {
        ok: false,
        error: this.phase !== PHASES.LOBBY ? '对局已开始且未开放观战' : '房间已满且未开放观战'
      };
    }
    if (this.spectators.length >= this.config.maxSpectators) {
      return { ok: false, error: '观战席已满' };
    }
    const spectator = {
      id: generateId('sp'),
      nickname: nameCheck.value,
      avatar,
      token: generateId('tk'),
      online: true,
      wantToPlay: false,
      joinedAt: Date.now(),
      disconnectedAt: null
    };
    this.spectators.push(spectator);
    if (!this.hostId) this.hostId = spectator.id;
    this.emitUpdate();
    return { ok: true, player: spectator, memberType: 'spectator', reconnected: false };
  }

  addPlayer({ nickname, avatar = '🦊', reconnectToken = null }) {
    this.touch();
    // 1. Reconnect by token — players first, then spectators
    if (reconnectToken) {
      const existing = this.players.find(p => p.token === reconnectToken);
      if (existing) {
        existing.online = true;
        existing.disconnectedAt = null;
        const nameCheck = validateNickname(nickname);
        if (nameCheck.ok && this.phase === PHASES.LOBBY) {
          existing.nickname = nameCheck.value;
        }
        this.emitUpdate();
        return { ok: true, player: existing, memberType: 'player', reconnected: true };
      }
      const existingSp = this.spectators.find(s => s.token === reconnectToken);
      if (existingSp) {
        existingSp.online = true;
        existingSp.disconnectedAt = null;
        const nameCheck = validateNickname(nickname);
        if (nameCheck.ok) existingSp.nickname = nameCheck.value;
        this.emitUpdate();
        return { ok: true, player: existingSp, memberType: 'spectator', reconnected: true };
      }
    }

    // 2. Mid-game or full seats → external spectator gallery
    if (this.phase !== PHASES.LOBBY || this.players.length >= 10) {
      return this.addSpectatorMember({ nickname, avatar });
    }

    const seat = this.nextFreeSeat();
    if (seat == null) {
      return this.addSpectatorMember({ nickname, avatar });
    }

    const nameCheck = validateNickname(nickname);
    if (!nameCheck.ok) {
      return { ok: false, error: nameCheck.error };
    }
    const player = {
      id: generateId('pl'),
      seat,
      nickname: nameCheck.value,
      avatar,
      token: generateId('tk'),
      online: true,
      ready: false,
      alive: true,
      role: null,
      word: null,
      disconnectedAt: null
    };

    this.players.push(player);
    this.players.sort((a, b) => a.seat - b.seat);
    if (!this.hostId) {
      this.hostId = player.id;
      player.ready = true;
    }

    this.config = sanitizeConfig(this.config, this.players.length);
    this.emitUpdate();
    return { ok: true, player, memberType: 'player', reconnected: false };
  }

  markDisconnected(memberId) {
    const spectator = this.spectators.find(s => s.id === memberId);
    if (spectator) {
      spectator.online = false;
      spectator.disconnectedAt = Date.now();
      if (this.hostId === memberId) this.transferHostAway(memberId);
      this.emitUpdate();
      return;
    }

    const player = this.players.find(p => p.id === memberId);
    if (!player) return;
    player.online = false;
    player.disconnectedAt = Date.now();

    if (this.hostId === memberId) this.transferHostAway(memberId);
    this.emitUpdate();
  }

  removePlayer(memberId) {
    const spIdx = this.spectators.findIndex(s => s.id === memberId);
    if (spIdx >= 0) {
      this.spectators.splice(spIdx, 1);
      if (this.hostId === memberId) this.transferHostAway(memberId);
      this.emitUpdate();
      return;
    }

    if (this.phase !== PHASES.LOBBY) {
      this.markDisconnected(memberId);
      return;
    }
    this.players = this.players.filter(p => p.id !== memberId);
    if (this.hostId === memberId) this.transferHostAway(memberId);
    this.config = sanitizeConfig(this.config, this.players.length);
    this.emitUpdate();
  }

  /**
   * Lobby-only: move between player seats and spectator gallery.
   */
  switchSeat(memberId, targetRole) {
    this.touch();
    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, error: '仅大厅阶段可换座' };
    }
    if (targetRole !== 'player' && targetRole !== 'spectator') {
      return { ok: false, error: '无效的座位目标' };
    }

    if (targetRole === 'spectator') {
      const player = this.players.find(p => p.id === memberId);
      if (!player) {
        if (this.spectators.find(s => s.id === memberId)) {
          return { ok: false, error: '你已在观战席' };
        }
        return { ok: false, error: '玩家不存在' };
      }
      if (!this.config.allowSpectators) {
        return { ok: false, error: '本房未开放观战' };
      }
      if (this.spectators.length >= this.config.maxSpectators) {
        return { ok: false, error: '观战席已满' };
      }

      this.players = this.players.filter(p => p.id !== memberId);
      const spectator = {
        id: player.id,
        nickname: player.nickname,
        avatar: player.avatar,
        token: player.token,
        online: player.online,
        wantToPlay: false,
        joinedAt: Date.now(),
        disconnectedAt: player.disconnectedAt || null
      };
      this.spectators.push(spectator);

      if (this.hostId === memberId) this.transferHostAway(memberId);
      this.config = sanitizeConfig(this.config, this.players.length);
      this.emitUpdate();
      return { ok: true, memberType: 'spectator' };
    }

    // spectator -> player
    const spectator = this.spectators.find(s => s.id === memberId);
    if (!spectator) {
      if (this.players.find(p => p.id === memberId)) {
        return { ok: false, error: '你已在参战席' };
      }
      return { ok: false, error: '观战者不存在' };
    }
    if (this.players.length >= 10) {
      return { ok: false, error: '参战席已满（最多 10 人）' };
    }
    const seat = this.nextFreeSeat();
    if (seat == null) {
      return { ok: false, error: '参战席已满（最多 10 人）' };
    }

    this.spectators = this.spectators.filter(s => s.id !== memberId);
    const player = {
      id: spectator.id,
      seat,
      nickname: spectator.nickname,
      avatar: spectator.avatar,
      token: spectator.token,
      online: spectator.online,
      ready: false,
      alive: true,
      role: null,
      word: null,
      disconnectedAt: spectator.disconnectedAt || null
    };
    this.players.push(player);
    this.players.sort((a, b) => a.seat - b.seat);
    if (!this.hostId) {
      this.hostId = player.id;
      player.ready = true;
    }
    this.config = sanitizeConfig(this.config, this.players.length);
    this.emitUpdate();
    return { ok: true, memberType: 'player' };
  }

  toggleQueueNext(spectatorId, wantToPlay) {
    this.touch();
    const spectator = this.spectators.find(s => s.id === spectatorId);
    if (!spectator) {
      return { ok: false, error: '仅外部观战者可预约下一局' };
    }
    spectator.wantToPlay = wantToPlay === true;
    this.emitUpdate();
    const queue = this.spectators
      .filter(s => s.online && s.wantToPlay)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    const queueIndex = queue.findIndex(s => s.id === spectatorId);
    return {
      ok: true,
      wantToPlay: spectator.wantToPlay,
      queueIndex: spectator.wantToPlay ? queueIndex + 1 : null,
      queueLength: queue.length
    };
  }

  promoteQueuedSpectators() {
    const queued = this.spectators
      .filter(s => s.online && s.wantToPlay)
      .sort((a, b) => a.joinedAt - b.joinedAt);

    while (this.players.length < 10 && queued.length > 0) {
      const sp = queued.shift();
      const seat = this.nextFreeSeat();
      if (seat == null) break;
      this.spectators = this.spectators.filter(s => s.id !== sp.id);
      const player = {
        id: sp.id,
        seat,
        nickname: sp.nickname,
        avatar: sp.avatar,
        token: sp.token,
        online: sp.online,
        ready: false,
        alive: true,
        role: null,
        word: null,
        disconnectedAt: sp.disconnectedAt || null
      };
      this.players.push(player);
      if (!this.hostId) {
        this.hostId = player.id;
        player.ready = true;
      }
    }
    this.players.sort((a, b) => a.seat - b.seat);
    this.config = sanitizeConfig(this.config, this.players.length);
  }

  updateConfig(actorId, partialConfig) {
    this.touch();
    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, error: '仅在大厅阶段可修改配置' };
    }
    if (actorId !== this.hostId) {
      return { ok: false, error: '仅房主可修改房间配置' };
    }
    this.config = sanitizeConfig({ ...this.config, ...partialConfig }, this.players.length);
    this.emitUpdate();
    return { ok: true, config: this.config };
  }

  toggleReady(playerId) {
    this.touch();
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: '对局已开始' };
    const p = this.players.find(x => x.id === playerId);
    if (!p) return { ok: false, error: '玩家不存在' };
    if (p.id === this.hostId) {
      p.ready = true;
    } else {
      p.ready = !p.ready;
    }
    this.emitUpdate();
    return { ok: true, ready: p.ready };
  }

  pickWordPair() {
    let pool = WORD_BANK.filter(w =>
      this.config.category === '全部' ? true : w.category === this.config.category
    );
    if (pool.length === 0) pool = WORD_BANK;

    let unused = pool.filter(w => !this.usedWordIds.has(w.id));
    if (unused.length === 0) {
      // Reset deduplication set when exhausted
      this.usedWordIds.clear();
      unused = pool;
    }

    const picked = unused[Math.floor(Math.random() * unused.length)];
    this.usedWordIds.add(picked.id);

    // Bidirectional 50/50 randomization
    const flip = Math.random() < 0.5;
    return {
      id: picked.id,
      category: picked.category,
      civilianWord: flip ? picked.a : picked.b,
      undercoverWord: flip ? picked.b : picked.a
    };
  }

  /**
   * Flatten unique words from the configured category; fall back to full bank if too few.
   */
  pickDistinctWords(count) {
    const flatten = (pool) => {
      const seen = new Set();
      const words = [];
      for (const w of pool) {
        for (const term of [w.a, w.b]) {
          const key = term.trim().toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            words.push(term);
          }
        }
      }
      return words;
    };

    let pool = WORD_BANK.filter(w =>
      this.config.category === '全部' ? true : w.category === this.config.category
    );
    if (pool.length === 0) pool = WORD_BANK;
    let words = flatten(pool);
    if (words.length < count) {
      words = flatten(WORD_BANK);
    }
    return shuffle(words).slice(0, count);
  }

  buildEasterEggReason(extraNote = '') {
    const prefix = extraNote ? `${extraNote} ` : '';
    if (this.easterEggType === 'ALL_SAME') {
      const word = this.currentWordPair ? this.currentWordPair.civilianWord : '';
      return `${prefix}哈哈被骗了吧！本局是【全员相同词】彩蛋局，所有人拿的都是『${word}』！`;
    }
    return `${prefix}哈哈被骗了吧！本局是【全员不同词】彩蛋局，每人各拿一词！`;
  }

  kickPlayer(actorId, targetId) {
    this.touch();
    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, error: '仅大厅阶段可踢出玩家' };
    }
    if (actorId !== this.hostId) {
      return { ok: false, error: '仅房主可踢出玩家' };
    }
    if (!targetId || targetId === actorId) {
      return { ok: false, error: '无法踢出自己' };
    }
    const target = this.players.find(p => p.id === targetId);
    if (!target) return { ok: false, error: '玩家不存在' };
    this.removePlayer(targetId);
    return { ok: true, kickedId: targetId, kickedNickname: target.nickname };
  }

  /**
   * Lobby maintenance: drop players who have been offline too long (default 90s).
   */
  pruneOfflineLobbyPlayers(maxOfflineMs = 90 * 1000) {
    if (this.phase !== PHASES.LOBBY) return [];
    const now = Date.now();
    const removed = [];
    for (const p of [...this.players]) {
      if (!p.online && p.disconnectedAt && now - p.disconnectedAt >= maxOfflineMs) {
        removed.push({ id: p.id, nickname: p.nickname });
        this.removePlayer(p.id);
      }
    }
    return removed;
  }

  /**
   * Drop external spectators offline longer than maxOfflineMs (default 60s).
   */
  pruneOfflineSpectators(maxOfflineMs = 60 * 1000) {
    const now = Date.now();
    const before = this.spectators.length;
    const removed = [];
    this.spectators = this.spectators.filter((s) => {
      if (s.online || !s.disconnectedAt || now - s.disconnectedAt < maxOfflineMs) {
        return true;
      }
      removed.push({ id: s.id, nickname: s.nickname });
      if (this.hostId === s.id) this.transferHostAway(s.id);
      return false;
    });
    if (this.spectators.length !== before) this.emitUpdate();
    return removed;
  }

  onlineMemberCount() {
    const playersOnline = this.players.filter(p => p.online).length;
    const spectatorsOnline = this.spectators.filter(s => s.online).length;
    return playersOnline + spectatorsOnline;
  }

  startGame(actorId) {
    this.touch();
    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, error: '对局已在进行中' };
    }
    if (actorId !== this.hostId) {
      return { ok: false, error: '仅房主可以开始游戏' };
    }
    if (this.players.length < 3 || this.players.length > 10) {
      return { ok: false, error: '游戏人数需在 3–10 人之间' };
    }
    const offline = this.players.filter(p => !p.online);
    if (offline.length > 0) {
      return { ok: false, error: `还有 ${offline.length} 位玩家离线，请踢出或等待重连` };
    }
    const unready = this.players.filter(p => p.id !== this.hostId && !p.ready);
    if (unready.length > 0) {
      return { ok: false, error: `还有 ${unready.length} 位玩家未准备` };
    }

    this.config = sanitizeConfig(this.config, this.players.length);
    this.currentWordPair = this.pickWordPair();
    // Stable UUID for optional DB write; must stay the same across persist retries
    this.gameId = crypto.randomUUID();
    this.gameStartedAt = Date.now();
    this._dbSettlementAttempted = false;
    this._dbSettlementOk = false;
    this._dbSettlementPromise = null;

    // M2: roll easter egg (never announced until settlement)
    // Tests may set room._forceEasterEggType; never accept it from client config.
    this.easterEggType = null;
    if (this.config.easterEggMode) {
      if (this._forceEasterEggType === 'ALL_SAME' || this._forceEasterEggType === 'ALL_DIFFERENT') {
        this.easterEggType = this._forceEasterEggType;
      } else if (Math.random() < this.config.easterEggRate) {
        this.easterEggType = Math.random() < 0.5 ? 'ALL_SAME' : 'ALL_DIFFERENT';
      }
    }

    const n = this.players.length;
    if (this.easterEggType === 'ALL_SAME') {
      this.players.forEach((p) => {
        p.alive = true;
        p.role = ROLES.CIVILIAN;
        p.word = this.currentWordPair.civilianWord;
      });
    } else if (this.easterEggType === 'ALL_DIFFERENT') {
      const words = this.pickDistinctWords(n);
      this.players.forEach((p, idx) => {
        p.alive = true;
        p.role = ROLES.UNDERCOVER;
        p.word = words[idx] || this.currentWordPair.undercoverWord;
      });
    } else {
      // Assign roles normally
      const roleBag = [];
      for (let i = 0; i < this.config.spyCount; i++) roleBag.push(ROLES.UNDERCOVER);
      for (let i = 0; i < this.config.blankCount; i++) roleBag.push(ROLES.BLANK);
      while (roleBag.length < n) roleBag.push(ROLES.CIVILIAN);

      const shuffledRoles = shuffle(roleBag);
      this.players.forEach((p, idx) => {
        p.alive = true;
        p.role = shuffledRoles[idx];
        if (p.role === ROLES.CIVILIAN) p.word = this.currentWordPair.civilianWord;
        else if (p.role === ROLES.UNDERCOVER) p.word = this.currentWordPair.undercoverWord;
        else p.word = ''; // BLANK (白板)
      });
    }

    this.roundNumber = 1;
    this.speakingSubRound = 1;
    this.completedVoteRounds = 0;
    this.speeches = [];
    this.ghostMessages = [];
    this.votes = {};
    this.pkCandidates = [];
    this.consecutiveTies = 0;
    this.lastVoteSummary = null;
    this.winner = null;
    this.winReason = '';
    this.wordFeedbacks = {};
    this.guessingPlayerId = null;
    this.pausedPhase = null;
    this.selfRevealNotice = null;
    this.ghostBets = {};
    this.bestSpectator = null;
    this.ghostBetRefundNote = null;

    this.beginSpeakingRound(null);
    return { ok: true };
  }

  beginSpeakingRound(pkIds = null) {
    this.votes = {};
    if (pkIds && pkIds.length > 0) {
      this.phase = PHASES.TIE_PK;
      this.pkCandidates = [...pkIds];
      this.turnOrder = [...pkIds];
    } else {
      this.phase = PHASES.SPEAKING;
      this.pkCandidates = [];
      const alivePlayers = this.players.filter(p => p.alive);
      // Choose starting speaker: random alive civilian in round 1 if preferCivilianFirst
      let startIdx = Math.floor(Math.random() * alivePlayers.length);
      if (this.roundNumber === 1 && this.speakingSubRound === 1 && this.config.preferCivilianFirst) {
        const civIndices = alivePlayers
          .map((p, i) => (p.role === ROLES.CIVILIAN ? i : -1))
          .filter(i => i >= 0);
        if (civIndices.length > 0) {
          startIdx = civIndices[Math.floor(Math.random() * civIndices.length)];
        }
      }
      this.turnOrder = [
        ...alivePlayers.slice(startIdx).map(p => p.id),
        ...alivePlayers.slice(0, startIdx).map(p => p.id)
      ];
    }

    this.turnIndex = 0;
    this.currentSpeakerId = this.turnOrder[0] || null;
    this.scheduleTurnTimeout();
    this.emitUpdate();
  }

  scheduleTurnTimeout() {
    const sec = this.phase === PHASES.TIE_PK
      ? Math.min(25, this.config.speakTimeoutSec)
      : this.config.speakTimeoutSec;
    this.scheduleTimer(sec, () => {
      if (this.currentSpeakerId) {
        this.submitSpeech(this.currentSpeakerId, {
          speechType: 'text',
          content: '（超时未发言）',
          isTimeout: true
        });
      }
    });
  }

  /**
   * Submit text speech (V1). Voice payload is reserved for V2 but still taboo-checked;
   * voice without a valid audioUrl is rejected so clients cannot bypass bans.
   */
  submitSpeech(playerId, { speechType = 'text', content = '', audioUrl = null, durationMs = 0, isTimeout = false }) {
    this.touch();
    if (this.spectators.find(s => s.id === playerId)) {
      return { ok: false, error: '观战模式不可参与当前操作' };
    }
    if (this.phase !== PHASES.SPEAKING && this.phase !== PHASES.TIE_PK) {
      return { ok: false, error: '当前不是发言阶段' };
    }
    if (playerId !== this.currentSpeakerId) {
      return { ok: false, error: '还没轮到你发言' };
    }
    const speaker = this.players.find(p => p.id === playerId);
    if (!speaker || !speaker.alive) {
      return { ok: false, error: '你已出局，无法发言' };
    }

    const isVoice = speechType === 'voice';
    if (isVoice && !isTimeout) {
      // V1: voice channel reserved — reject until upload + audioUrl are wired in V2
      if (!audioUrl || typeof audioUrl !== 'string' || !/^https:\/\/.+/i.test(audioUrl)) {
        return { ok: false, error: '语音发言尚未开放，请使用文字发言' };
      }
      const dur = Number(durationMs) || 0;
      if (dur <= 0 || dur > 30000) {
        return { ok: false, error: '语音时长无效（需 1–30 秒）' };
      }
    }

    let cleanContent = String(content || '').trim().slice(0, 80);
    if (!isTimeout) {
      if (!isVoice && !cleanContent) {
        return { ok: false, error: '请输入一句描述词语的话' };
      }
      // Always taboo-check any textual content (blocks voice+text cheat)
      if (cleanContent) {
        const taboo = checkTabooWord(cleanContent, speaker.word);
        if (taboo) {
          return { ok: false, error: `发言包含原词禁字「${taboo}」，请换一种描述方式` };
        }
      }
    }

    this.speeches.push({
      id: generateId('sp'),
      round: this.roundNumber,
      subRound: this.phase === PHASES.TIE_PK ? 'PK' : this.speakingSubRound,
      playerId: speaker.id,
      seat: speaker.seat,
      nickname: speaker.nickname,
      avatar: speaker.avatar,
      speechType: isVoice ? 'voice' : 'text',
      content: cleanContent || (isVoice ? '语音发言' : ''),
      audioUrl: isVoice ? String(audioUrl).slice(0, 500) : null,
      durationMs: isVoice ? Math.min(30000, Number(durationMs) || 0) : 0,
      isTimeout,
      ts: Date.now()
    });

    // Advance turn
    this.turnIndex++;
    if (this.turnIndex < this.turnOrder.length) {
      this.currentSpeakerId = this.turnOrder[this.turnIndex];
      this.scheduleTurnTimeout();
      this.emitUpdate();
      return { ok: true };
    }

    // All speakers in this sub-round finished
    this.currentSpeakerId = null;
    this.clearTimer();

    // Special 3-player rule: require 2 speaking sub-rounds before the decisive vote
    if (this.phase === PHASES.SPEAKING && this.players.length === 3 && this.speakingSubRound < 2) {
      this.speakingSubRound = 2;
      this.beginSpeakingRound(null);
      return { ok: true };
    }

    // Move to VOTING
    this.beginVotingPhase();
    return { ok: true };
  }

  beginVotingPhase() {
    this.phase = PHASES.VOTING;
    this.votes = {};
    this.scheduleTimer(this.config.voteTimeoutSec, () => {
      this.resolveVotes();
    });
    this.emitUpdate();
  }

  castVote(voterId, targetId) {
    this.touch();
    if (this.spectators.find(s => s.id === voterId)) {
      return { ok: false, error: '观战模式不可参与当前操作' };
    }
    if (this.phase !== PHASES.VOTING) {
      return { ok: false, error: '当前不是投票阶段' };
    }
    const voter = this.players.find(p => p.id === voterId);
    const target = this.players.find(p => p.id === targetId);
    if (!voter || !voter.alive) {
      return { ok: false, error: '仅存活玩家可以投票' };
    }
    if (!target || !target.alive) {
      return { ok: false, error: '投票目标无效或已出局' };
    }
    if (voterId === targetId) {
      return { ok: false, error: '不能投票给自己' };
    }
    if (this.pkCandidates.length > 0 && !this.pkCandidates.includes(targetId)) {
      return { ok: false, error: '平票重投仅可投给平票候选人' };
    }
    if (this.votes[voterId]) {
      return { ok: false, error: '本轮已投票，不可修改' };
    }

    this.votes[voterId] = targetId;

    const eligibleVoters = this.getEligibleVoters();
    const allVoted = eligibleVoters.every(p => Boolean(this.votes[p.id]));
    if (allVoted) {
      this.resolveVotes();
    } else {
      this.emitUpdate();
    }
    return { ok: true };
  }

  getEligibleVoters() {
    const alive = this.players.filter(p => p.alive);
    // In PK vote, if there are non-PK alive players, everyone except PK candidates votes;
    // if all alive players are tied (e.g. 3-way tie in 3-player game), all alive players re-vote.
    if (this.pkCandidates.length > 0 && this.pkCandidates.length < alive.length) {
      return alive.filter(p => !this.pkCandidates.includes(p.id));
    }
    return alive;
  }

  resolveVotes() {
    this.clearTimer();
    const tally = {};
    Object.values(this.votes).forEach(targetId => {
      tally[targetId] = (tally[targetId] || 0) + 1;
    });

    const entries = Object.entries(tally);
    if (entries.length === 0) {
      // Everyone abstained — does not count toward consecutive tie PK chain
      this.consecutiveTies = 0;
      this.pkCandidates = [];
      this.lastVoteSummary = {
        round: this.roundNumber,
        tally,
        eliminatedId: null,
        isTie: true,
        note: '本轮全员弃权，无人出局'
      };
      this.completedVoteRounds += 1;
      const eggOutcome = this.checkEasterEggAfterVote();
      if (eggOutcome) {
        this.finishGame(eggOutcome.winner, eggOutcome.reason);
        return;
      }
      this.advanceToNextRound();
      return;
    }

    const maxVotes = Math.max(...entries.map(([, count]) => count));
    const topIds = entries.filter(([, count]) => count === maxVotes).map(([id]) => id);

    // Handle Tie
    if (topIds.length > 1) {
      this.consecutiveTies++;
      // 3-player final vote tie -> Undercover wins on second consecutive tie
      if (this.consecutiveTies >= 2) {
        if (this.players.length === 3 && !this.easterEggType) {
          this.lastVoteSummary = {
            round: this.roundNumber,
            tally,
            eliminatedId: null,
            isTie: true,
            note: '3 人局连续平票，卧底成功逃脱'
          };
          this.completedVoteRounds += 1;
          this.finishGame('UNDERCOVER', '3 人局连续平票，卧底存活获胜');
          return;
        }
        this.lastVoteSummary = {
          round: this.roundNumber,
          tally,
          eliminatedId: null,
          isTie: true,
          note: '连续两次平票，本轮平安夜无人出局，进入下一轮'
        };
        this.consecutiveTies = 0;
        this.completedVoteRounds += 1;
        const eggOutcome = this.checkEasterEggAfterVote();
        if (eggOutcome) {
          this.finishGame(eggOutcome.winner, eggOutcome.reason);
          return;
        }
        this.advanceToNextRound();
        return;
      }

      // First tie -> Trigger TIE_PK
      this.lastVoteSummary = {
        round: this.roundNumber,
        tally,
        eliminatedId: null,
        isTie: true,
        pkCandidates: topIds,
        note: '出现最高票平票，进入平票 PK 补充发言环节'
      };
      this.beginSpeakingRound(topIds);
      return;
    }

    // Unique highest vote -> Eliminate player
    const eliminatedId = topIds[0];
    const eliminated = this.players.find(p => p.id === eliminatedId);
    eliminated.alive = false;
    this.consecutiveTies = 0;
    this.pkCandidates = [];
    this.completedVoteRounds += 1;

    this.lastVoteSummary = {
      round: this.roundNumber,
      tally,
      eliminatedId,
      eliminatedSeat: eliminated.seat,
      eliminatedNickname: eliminated.nickname,
      eliminatedRole: this.config.revealRoleOnOut ? eliminated.role : null,
      isTie: false,
      note: `${eliminated.seat}号 ${eliminated.nickname} 得票最高（${maxVotes} 票）出局`
    };

    this.scoreGhostNextOutBets(eliminatedId);

    // Check Win Condition
    const outcome = this.checkWinCondition();
    if (outcome) {
      this.finishGame(outcome.winner, outcome.reason);
      return;
    }

    this.advanceToNextRound();
  }

  checkEasterEggAfterVote() {
    if (!this.easterEggType) return null;
    const total = this.players.length;
    const aliveCount = this.players.filter(p => p.alive).length;
    const needRounds = total <= 3 ? 1 : 2;
    const aliveThreshold = Math.max(2, Math.floor(total / 2));
    if (this.completedVoteRounds >= needRounds || aliveCount <= aliveThreshold) {
      return { winner: 'EASTER_EGG', reason: this.buildEasterEggReason() };
    }
    return null;
  }

  checkWinCondition() {
    // M2: easter egg uses dedicated end rules (no classic spy wipe)
    if (this.easterEggType) {
      return this.checkEasterEggAfterVote();
    }

    const alive = this.players.filter(p => p.alive);
    const aliveSpies = alive.filter(p => p.role === ROLES.UNDERCOVER || p.role === ROLES.BLANK);
    const aliveCivilians = alive.filter(p => p.role === ROLES.CIVILIAN);

    // 1. All undercovers (and blanks) eliminated -> Civilians win
    if (aliveSpies.length === 0) {
      return { winner: 'CIVILIAN', reason: '所有卧底均已被找出，平民阵营获胜！' };
    }

    // 2. 3-player game special rule: if the single vote failed to eliminate the undercover -> Undercover wins
    if (this.players.length === 3 && alive.length <= 2) {
      return { winner: 'UNDERCOVER', reason: '3 人局平民投错人，卧底成功潜伏获胜！' };
    }

    // 3. 4-10 players: undercover side wins only when spies(+blank) >= civilians
    // e.g. 1 卧底需存活到还剩 2 人；2 卧底存活到还剩 4 人（2v2）才获胜。
    // 这样 4 人局投错一人后会进入下一轮发言，而不是立刻结束。
    if (this.players.length >= 4 && aliveSpies.length >= aliveCivilians.length) {
      return {
        winner: 'UNDERCOVER',
        reason: `场上卧底阵营 ${aliveSpies.length} 人 ≥ 平民 ${aliveCivilians.length} 人，卧底潜伏成功！`
      };
    }

    return null;
  }

  /**
   * M3: Any alive player may start self-reveal (UI must show for all — anti-leak).
   */
  startSelfReveal(playerId) {
    this.touch();
    if (this.spectators.find(s => s.id === playerId)) {
      return { ok: false, error: '观战模式不可参与当前操作' };
    }
    if (!this.config.allowSpySelfReveal) {
      return { ok: false, error: '本局未开启自爆猜词' };
    }
    if (this.phase !== PHASES.SPEAKING && this.phase !== PHASES.VOTING && this.phase !== PHASES.TIE_PK) {
      return { ok: false, error: '当前阶段无法发起自爆猜词' };
    }
    if (this.guessingPlayerId) {
      return { ok: false, error: '已有玩家正在自爆猜词' };
    }
    const player = this.players.find(p => p.id === playerId);
    if (!player || !player.alive) {
      return { ok: false, error: '仅存活玩家可发起自爆猜词' };
    }

    this.pausedPhase = this.phase;
    this.guessingPlayerId = playerId;
    this.clearTimer();
    this.phase = PHASES.SPY_GUESS;
    this.selfRevealNotice = {
      playerId: player.id,
      seat: player.seat,
      nickname: player.nickname,
      status: 'guessing',
      note: `${player.seat}号 ${player.nickname} 发起了自爆猜词，正在输入平民词...`
    };
    this.scheduleTimer(15, () => {
      this.submitSelfRevealGuess(playerId, '', { isTimeout: true });
    });
    this.emitUpdate();
    return { ok: true };
  }

  submitSelfRevealGuess(playerId, guessWord, { isTimeout = false } = {}) {
    this.touch();
    if (this.phase !== PHASES.SPY_GUESS) {
      return { ok: false, error: '当前不是自爆猜词阶段' };
    }
    if (playerId !== this.guessingPlayerId) {
      return { ok: false, error: '仅发起者可提交猜词' };
    }
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { ok: false, error: '玩家不存在' };

    this.clearTimer();
    const guess = normalizeGuessWord(guessWord);
    const civilianWord = this.currentWordPair ? this.currentWordPair.civilianWord : '';

    // Case A: easter egg — reveal and roast the initiator
    if (this.easterEggType) {
      this.selfRevealNotice = {
        playerId: player.id,
        seat: player.seat,
        nickname: player.nickname,
        status: 'egg',
        note: `${player.seat}号 ${player.nickname} 自爆猜词，惨遭整蛊！`
      };
      this.guessingPlayerId = null;
      this.pausedPhase = null;
      this.finishGame('EASTER_EGG', this.buildEasterEggReason(`${player.seat}号 ${player.nickname} 自爆猜词惨遭整蛊。`));
      return { ok: true, result: 'EASTER_EGG' };
    }

    const isSpy = player.role === ROLES.UNDERCOVER;
    const correct = guess && guess === normalizeGuessWord(civilianWord);

    // Case B: undercover guesses civilian word correctly -> instant spy win
    if (isSpy && correct && !isTimeout) {
      this.selfRevealNotice = {
        playerId: player.id,
        seat: player.seat,
        nickname: player.nickname,
        status: 'success',
        note: `${player.seat}号 ${player.nickname} 自爆猜词正确，卧底阵营反杀获胜！`
      };
      this.guessingPlayerId = null;
      this.pausedPhase = null;
      this.finishGame('UNDERCOVER', `${player.seat}号 ${player.nickname} 主动亮牌猜中平民词「${civilianWord}」，卧底阵营反杀获胜！`);
      return { ok: true, result: 'SPY_WIN' };
    }

    // Case C: wrong guess / timeout / civilian mis-reveal -> eliminate initiator
    player.alive = false;
    this.scoreGhostNextOutBets(player.id);
    const failNote = isTimeout
      ? `${player.seat}号 ${player.nickname} 自爆猜词超时，已出局`
      : `${player.seat}号 ${player.nickname} 自爆猜词失败已出局`;
    this.selfRevealNotice = {
      playerId: player.id,
      seat: player.seat,
      nickname: player.nickname,
      status: 'fail',
      note: `${failNote}，游戏继续`
    };
    this.guessingPlayerId = null;
    this.pausedPhase = null;

    const outcome = this.checkWinCondition();
    if (outcome) {
      this.finishGame(outcome.winner, outcome.reason);
      return { ok: true, result: 'ELIMINATED_END' };
    }

    this.advanceToNextRound();
    return { ok: true, result: 'ELIMINATED_CONTINUE' };
  }

  /**
   * M4: Ghost bets — eliminated seat players + external spectators.
   */
  placeGhostBet(playerId, betType, target) {
    this.touch();
    if (!this.config.enableGhostBet) {
      return { ok: false, error: '本局未开启观战押注' };
    }
    if (this.phase === PHASES.LOBBY || this.phase === PHASES.SETTLEMENT) {
      return { ok: false, error: '当前阶段不可押注' };
    }
    const player = this.players.find(p => p.id === playerId);
    const spectator = this.spectators.find(s => s.id === playerId);
    if (!player && !spectator) return { ok: false, error: '玩家不存在' };
    if (player && player.alive) {
      return { ok: false, error: '仅已出局玩家可押注' };
    }

    const isBlindExternal = Boolean(spectator) && !this.config.spectatorGodView;

    if (!this.ghostBets[playerId]) {
      this.ghostBets[playerId] = { finalWinner: null, byRound: {}, score: 0 };
    }
    const bet = this.ghostBets[playerId];

    if (betType === 'nextOut') {
      if (this.phase !== PHASES.SPEAKING && this.phase !== PHASES.VOTING) {
        return { ok: false, error: '仅发言/投票阶段可押本轮出局' };
      }
      const targetPlayer = this.players.find(p => p.id === target);
      if (!targetPlayer || !targetPlayer.alive) {
        return { ok: false, error: '押注目标必须是当前存活玩家' };
      }
      bet.byRound[this.roundNumber] = targetPlayer.id;
      this.emitUpdate();
      return {
        ok: true,
        betType: 'nextOut',
        target: targetPlayer.id,
        round: this.roundNumber,
        blindBet: isBlindExternal,
        note: isBlindExternal ? '推理观战为盲猜押注（不显示词语与身份）' : undefined
      };
    }

    if (betType === 'winner') {
      if (bet.finalWinner) {
        return { ok: false, error: '最终胜方押注已锁定，不可修改' };
      }
      if (target !== 'CIVILIAN' && target !== 'UNDERCOVER') {
        return { ok: false, error: '请选择平民或卧底作为最终胜方' };
      }
      bet.finalWinner = target;
      this.emitUpdate();
      return {
        ok: true,
        betType: 'winner',
        target,
        blindBet: isBlindExternal,
        note: isBlindExternal ? '推理观战为盲猜押注（不显示词语与身份）' : undefined
      };
    }

    return { ok: false, error: '未知押注类型' };
  }

  scoreGhostNextOutBets(eliminatedId) {
    if (!this.config.enableGhostBet || !eliminatedId) return;
    Object.values(this.ghostBets).forEach((bet) => {
      if (bet.byRound && bet.byRound[this.roundNumber] === eliminatedId) {
        bet.score = (bet.score || 0) + 10;
      }
    });
  }

  scoreGhostWinnerBets(winner) {
    if (!this.config.enableGhostBet) {
      this.bestSpectator = null;
      return;
    }
    // Easter egg: winner bets neither scored nor penalized; keep nextOut scores
    if (winner === 'EASTER_EGG') {
      const hadWinnerBet = Object.values(this.ghostBets).some(b => b.finalWinner);
      this.bestSpectator = null;
      this.ghostBetRefundNote = hadWinnerBet
        ? '彩蛋局揭晓，最终胜方押注不计分（本轮出局押注得分保留）'
        : null;
      return;
    }
    this.ghostBetRefundNote = null;
    Object.values(this.ghostBets).forEach((bet) => {
      if (bet.finalWinner && bet.finalWinner === winner) {
        bet.score = (bet.score || 0) + 20;
      }
    });

    let best = null;
    let bestScore = 0;
    let hitCount = 0;
    for (const [pid, bet] of Object.entries(this.ghostBets)) {
      if ((bet.score || 0) > bestScore) {
        bestScore = bet.score || 0;
        best = pid;
        hitCount = this.countGhostHits(bet, winner);
      }
    }
    if (best && bestScore > 0) {
      const p = this.players.find(x => x.id === best);
      const sp = this.spectators.find(x => x.id === best);
      const who = p || sp;
      if (who) {
        const seatLabel = p ? `${p.seat}号 ` : '观战·';
        this.bestSpectator = {
          playerId: who.id,
          seat: p ? p.seat : 0,
          nickname: who.nickname,
          score: bestScore,
          hitCount,
          label: `观战预言家：${seatLabel}${who.nickname}，命中 ${hitCount} 次`
        };
      }
    } else {
      this.bestSpectator = null;
    }
  }

  countGhostHits(bet, winner) {
    // Derive hits from score: +10 nextOut, +20 winner
    const score = bet.score || 0;
    const winnerHit = bet.finalWinner && bet.finalWinner === winner ? 1 : 0;
    const nextOutHits = Math.max(0, Math.floor((score - winnerHit * 20) / 10));
    return nextOutHits + winnerHit;
  }

  advanceToNextRound() {
    // Fresh round resets tie chain so a prior abstain/tie cannot skip PK next round
    this.consecutiveTies = 0;
    this.pkCandidates = [];
    this.roundNumber++;
    this.speakingSubRound = 1;
    this.beginSpeakingRound(null);
  }

  finishGame(winner, reason) {
    this.clearTimer();
    this.phase = PHASES.SETTLEMENT;
    this.winner = winner;
    this.winReason = reason;
    this.currentSpeakerId = null;
    this.guessingPlayerId = null;
    this.pausedPhase = null;
    this.gameEndedAt = Date.now();
    this.scoreGhostWinnerBets(winner);
    this.emitUpdate();
  }

  /**
   * Payload for optional DB settlement write. Null if not settled / missing ids.
   */
  getSettlementRecord() {
    if (this.phase !== PHASES.SETTLEMENT || !this.gameId || !this.currentWordPair) {
      return null;
    }
    if (this.winner !== 'CIVILIAN' && this.winner !== 'UNDERCOVER') {
      return null;
    }
    return {
      gameId: this.gameId,
      roomCode: this.roomCode,
      winner: this.winner,
      winReason: this.winReason || '',
      wordPairId: this.currentWordPair.id,
      categoryName: this.currentWordPair.category,
      civilianWord: this.currentWordPair.civilianWord,
      undercoverWord: this.currentWordPair.undercoverWord,
      spyCount: this.config.spyCount,
      blankCount: this.config.blankCount,
      playerCount: this.players.length,
      startedAt: new Date(this.gameStartedAt || this.createdAt),
      endedAt: new Date(this.gameEndedAt || Date.now()),
      players: this.players.map((p) => ({
        id: p.id,
        seat: p.seat,
        nickname: p.nickname,
        role: p.role,
        word: p.word == null ? '' : String(p.word),
        alive: Boolean(p.alive)
      }))
    };
  }

  sendGhostMessage(playerId, content) {
    this.touch();
    const player = this.players.find(p => p.id === playerId);
    const spectator = this.spectators.find(s => s.id === playerId);
    if (!player && !spectator) return { ok: false, error: '玩家不存在' };
    if (this.phase === PHASES.LOBBY) return { ok: false, error: '大厅无需观战频道' };

    const isSettled = this.phase === PHASES.SETTLEMENT;
    if (spectator) {
      // External spectators may chat only with god view (or after settlement)
      if (!isSettled && !this.config.spectatorGodView) {
        return { ok: false, error: '推理观战不可使用上帝频道（防剧透）' };
      }
    } else if (player.alive && !isSettled) {
      return { ok: false, error: '仅已出局玩家可使用观战频道' };
    }

    const clean = String(content || '').trim().slice(0, 100);
    if (!clean) return { ok: false, error: '消息不能为空' };

    const author = player || spectator;
    this.ghostMessages.push({
      id: generateId('gh'),
      playerId: author.id,
      seat: player ? player.seat : 0,
      nickname: author.nickname,
      content: clean,
      ts: Date.now()
    });
    this.emitUpdate();
    return { ok: true };
  }

  /**
   * Settlement-only: rate the current word pair (thumbs up / down).
   * Players may switch their vote; same rating again is a no-op.
   */
  submitWordFeedback(playerId, rating) {
    this.touch();
    if (this.phase !== PHASES.SETTLEMENT) {
      return { ok: false, error: '仅结算阶段可评价词组' };
    }
    if (!this.players.find(p => p.id === playerId)) {
      return { ok: false, error: '玩家不存在' };
    }
    if (rating !== 'up' && rating !== 'down') {
      return { ok: false, error: '请选择点赞或点踩' };
    }
    if (!this.currentWordPair) {
      return { ok: false, error: '本局词组不可用' };
    }
    const prev = this.wordFeedbacks[playerId] || null;
    if (prev === rating) {
      return {
        ok: true,
        unchanged: true,
        rating,
        stats: this.getWordFeedbackStats(),
        wordPair: this.currentWordPair
      };
    }
    this.wordFeedbacks[playerId] = rating;
    this.emitUpdate();
    return {
      ok: true,
      unchanged: false,
      rating,
      prevRating: prev,
      stats: this.getWordFeedbackStats(),
      wordPair: this.currentWordPair
    };
  }

  resetToLobby(actorId) {
    this.touch();
    if (actorId !== this.hostId) {
      return { ok: false, error: '仅房主可开启下一局' };
    }
    this.clearTimer();
    this.phase = PHASES.LOBBY;
    this.winner = null;
    this.winReason = '';
    this.speeches = [];
    this.ghostMessages = [];
    this.votes = {};
    this.pkCandidates = [];
    this.lastVoteSummary = null;
    this.wordFeedbacks = {};
    this.easterEggType = null;
    this.completedVoteRounds = 0;
    this.guessingPlayerId = null;
    this.pausedPhase = null;
    this.selfRevealNotice = null;
    this.ghostBets = {};
    this.bestSpectator = null;
    this.ghostBetRefundNote = null;
    this._forceEasterEggType = null;
    this.gameId = null;
    this.gameStartedAt = null;
    this.gameEndedAt = null;
    this._dbSettlementAttempted = false;
    this._dbSettlementOk = false;
    this._dbSettlementPromise = null;
    this.players.forEach(p => {
      p.alive = true;
      p.role = null;
      p.word = null;
      p.ready = p.id === this.hostId;
    });
    // Auto-seat online spectators who queued for the next game (by joinedAt)
    this.promoteQueuedSpectators();
    this.players.forEach(p => {
      p.ready = p.id === this.hostId;
    });
    this.emitUpdate();
    return { ok: true };
  }

  /**
   * VIEW PROJECTION (Anti-Cheat):
   * Returns a sanitized snapshot strictly scoped to `viewerId`.
   * viewerType: ALIVE_PLAYER | ELIMINATED_PLAYER | EXTERNAL_SPECTATOR
   */
  getPlayerSnapshot(viewerId) {
    const viewer = this.players.find(p => p.id === viewerId);
    const externalSpectator = this.spectators.find(s => s.id === viewerId);
    const isSettled = this.phase === PHASES.SETTLEMENT;

    let viewerType = 'ALIVE_PLAYER';
    if (externalSpectator) {
      viewerType = 'EXTERNAL_SPECTATOR';
    } else if (viewer && !viewer.alive && this.phase !== PHASES.LOBBY) {
      viewerType = 'ELIMINATED_PLAYER';
    }

    const canSeeAllSecrets =
      isSettled ||
      viewerType === 'ELIMINATED_PLAYER' ||
      (viewerType === 'EXTERNAL_SPECTATOR' && this.config.spectatorGodView);

    // Reasoning external spectators never see secrets; god-view / eliminated / settled do
    const hideAllSecretsForReasoning =
      viewerType === 'EXTERNAL_SPECTATOR' && !this.config.spectatorGodView && !isSettled;

    const eligibleVoters = this.phase === PHASES.VOTING ? this.getEligibleVoters().map(p => p.id) : [];

    // M1: delayed spy teammate reveal — only after surviving at least one completed vote round
    const canKnowTeammate = this.config.delayedSpyReveal
      && this.config.spyCount === 2
      && this.completedVoteRounds >= 1
      && viewer
      && viewer.role === ROLES.UNDERCOVER
      && viewer.alive
      && !this.easterEggType
      && this.phase !== PHASES.LOBBY;
    const spyTeammates = canKnowTeammate
      ? this.players
        .filter(p => p.role === ROLES.UNDERCOVER && p.id !== viewer.id)
        .map(p => ({ id: p.id, seat: p.seat, nickname: p.nickname, alive: p.alive }))
      : null;

    const publicConfig = { ...this.config };
    delete publicConfig._forceEasterEggType;

    const betOwnerId = viewer ? viewer.id : (externalSpectator ? externalSpectator.id : null);
    const canSeeOwnBet = Boolean(betOwnerId) && (
      canSeeAllSecrets ||
      viewerType === 'EXTERNAL_SPECTATOR' // blind bet still shows own stakes
    );
    const myGhostBet = canSeeOwnBet && this.ghostBets[betOwnerId]
      ? {
          finalWinner: this.ghostBets[betOwnerId].finalWinner,
          byRound: { ...this.ghostBets[betOwnerId].byRound },
          score: this.ghostBets[betOwnerId].score || 0,
          currentRoundBet: this.ghostBets[betOwnerId].byRound[this.roundNumber] || null
        }
      : null;

    const queueOrdered = this.spectators
      .filter(s => s.online && s.wantToPlay)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    const myQueueIndex = externalSpectator && externalSpectator.wantToPlay
      ? queueOrdered.findIndex(s => s.id === externalSpectator.id) + 1
      : null;

    const spectatorsBrief = this.spectators.map(s => ({
      id: s.id,
      nickname: s.nickname,
      avatar: s.avatar,
      online: s.online,
      wantToPlay: s.wantToPlay,
      joinedAt: s.joinedAt
    }));

    let myWord = null;
    if (viewer && this.phase !== PHASES.LOBBY) {
      myWord = viewer.word;
    }
    if (hideAllSecretsForReasoning || (viewerType === 'EXTERNAL_SPECTATOR' && !isSettled && !this.config.spectatorGodView)) {
      myWord = null;
    }

    return {
      roomCode: this.roomCode,
      phase: this.phase,
      serverNow: Date.now(),
      phaseEndsAt: this.phaseEndsAt,
      hostId: this.hostId,
      config: publicConfig,
      roundNumber: this.roundNumber,
      speakingSubRound: this.speakingSubRound,
      currentSpeakerId: this.currentSpeakerId,
      pkCandidates: this.pkCandidates,
      eligibleVoters,
      votedPlayerIds: Object.keys(this.votes),
      myVote: viewer ? (this.votes[viewer.id] || null) : null,
      myId: viewer ? viewer.id : (externalSpectator ? externalSpectator.id : null),
      viewerType,
      myWord,
      myRole: canSeeAllSecrets && viewer ? viewer.role : null,
      spyTeammates,
      guessingPlayerId: this.guessingPlayerId,
      selfRevealNotice: this.selfRevealNotice,
      wordReveal: canSeeAllSecrets ? this.currentWordPair : null,
      easterEggType: isSettled ? this.easterEggType : null,
      myWordFeedback: (viewer || externalSpectator) && this.phase === PHASES.SETTLEMENT
        ? (this.wordFeedbacks[betOwnerId] || null)
        : null,
      wordFeedbackStats: this.phase === PHASES.SETTLEMENT
        ? this.getWordFeedbackStats()
        : { up: 0, down: 0 },
      players: this.players.map(p => ({
        id: p.id,
        seat: p.seat,
        nickname: p.nickname,
        avatar: p.avatar,
        online: p.online,
        ready: p.ready,
        alive: p.alive,
        isHost: p.id === this.hostId,
        role: hideAllSecretsForReasoning
          ? null
          : (canSeeAllSecrets ? p.role : (this.config.revealRoleOnOut && !p.alive ? p.role : null)),
        word: canSeeAllSecrets && !hideAllSecretsForReasoning ? p.word : null
      })),
      spectators: spectatorsBrief,
      spectatorCount: this.spectators.length,
      myWantToPlay: externalSpectator ? externalSpectator.wantToPlay : false,
      myQueueIndex,
      speeches: this.speeches,
      lastVoteSummary: this.lastVoteSummary,
      ghostMessages: canSeeAllSecrets && !hideAllSecretsForReasoning ? this.ghostMessages : [],
      ghostBets: canSeeAllSecrets && !hideAllSecretsForReasoning ? this.ghostBets : null,
      myGhostBet,
      bestSpectator: isSettled ? this.bestSpectator : null,
      ghostBetRefundNote: isSettled ? (this.ghostBetRefundNote || null) : null,
      winner: this.winner,
      winReason: this.winReason
    };
  }

  emitUpdate() {
    if (typeof this.onStateChange === 'function') {
      this.onStateChange(this);
    }
  }
}

module.exports = {
  PHASES,
  ROLES,
  DEFAULT_CONFIG,
  sanitizeConfig,
  checkTabooWord,
  UndercoverRoom
};
