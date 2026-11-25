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
  preferCivilianFirst: true
};

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

    // Settlement
    this.winner = null;       // 'CIVILIAN' | 'UNDERCOVER' | null
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

  addPlayer({ nickname, avatar = '🦊', reconnectToken = null }) {
    this.touch();
    // 1. Check reconnect by token
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
        return { ok: true, player: existing, reconnected: true };
      }
    }

    // 2. Reject new joins once game started or room full
    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, error: '对局已开始，无法加入新玩家' };
    }
    if (this.players.length >= 10) {
      return { ok: false, error: '房间已满（最多 10 人）' };
    }

    const usedSeats = new Set(this.players.map(p => p.seat));
    let seat = 1;
    while (usedSeats.has(seat)) seat++;

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

    // Auto-adjust config if player count crossed threshold
    this.config = sanitizeConfig(this.config, this.players.length);
    this.emitUpdate();
    return { ok: true, player, reconnected: false };
  }

  markDisconnected(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return;
    player.online = false;
    player.disconnectedAt = Date.now();

    // Auto-transfer host if host goes offline
    if (this.hostId === playerId) {
      const nextOnline = this.players.find(p => p.online && p.id !== playerId);
      if (nextOnline) {
        this.hostId = nextOnline.id;
        nextOnline.ready = true;
      }
    }
    this.emitUpdate();
  }

  removePlayer(playerId) {
    if (this.phase !== PHASES.LOBBY) {
      this.markDisconnected(playerId);
      return;
    }
    this.players = this.players.filter(p => p.id !== playerId);
    if (this.hostId === playerId) {
      this.hostId = this.players[0] ? this.players[0].id : null;
      if (this.players[0]) this.players[0].ready = true;
    }
    this.config = sanitizeConfig(this.config, this.players.length);
    this.emitUpdate();
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

    // Assign roles
    const n = this.players.length;
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

    this.roundNumber = 1;
    this.speakingSubRound = 1;
    this.speeches = [];
    this.ghostMessages = [];
    this.votes = {};
    this.pkCandidates = [];
    this.consecutiveTies = 0;
    this.lastVoteSummary = null;
    this.winner = null;
    this.winReason = '';
    this.wordFeedbacks = {};

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
        if (this.players.length === 3) {
          this.lastVoteSummary = {
            round: this.roundNumber,
            tally,
            eliminatedId: null,
            isTie: true,
            note: '3 人局连续平票，卧底成功逃脱'
          };
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

    // Check Win Condition
    const outcome = this.checkWinCondition();
    if (outcome) {
      this.finishGame(outcome.winner, outcome.reason);
      return;
    }

    this.advanceToNextRound();
  }

  checkWinCondition() {
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
    this.gameEndedAt = Date.now();
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
    if (!player) return { ok: false, error: '玩家不存在' };
    if (this.phase === PHASES.LOBBY) return { ok: false, error: '大厅无需观战频道' };
    if (player.alive && this.phase !== PHASES.SETTLEMENT) {
      return { ok: false, error: '仅已出局玩家可使用观战频道' };
    }
    const clean = String(content || '').trim().slice(0, 100);
    if (!clean) return { ok: false, error: '消息不能为空' };

    this.ghostMessages.push({
      id: generateId('gh'),
      playerId: player.id,
      seat: player.seat,
      nickname: player.nickname,
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
    this.emitUpdate();
    return { ok: true };
  }

  /**
   * VIEW PROJECTION (Anti-Cheat):
   * Returns a sanitized snapshot strictly scoped to `viewerId`.
   */
  getPlayerSnapshot(viewerId) {
    const viewer = this.players.find(p => p.id === viewerId);
    const isSettled = this.phase === PHASES.SETTLEMENT;
    const isEliminatedSpectator = viewer && !viewer.alive && this.phase !== PHASES.LOBBY;
    const canSeeAllSecrets = isSettled || isEliminatedSpectator;

    const eligibleVoters = this.phase === PHASES.VOTING ? this.getEligibleVoters().map(p => p.id) : [];

    return {
      roomCode: this.roomCode,
      phase: this.phase,
      serverNow: Date.now(),
      phaseEndsAt: this.phaseEndsAt,
      hostId: this.hostId,
      config: this.config,
      roundNumber: this.roundNumber,
      speakingSubRound: this.speakingSubRound,
      currentSpeakerId: this.currentSpeakerId,
      pkCandidates: this.pkCandidates,
      eligibleVoters,
      votedPlayerIds: Object.keys(this.votes),
      myVote: viewer ? (this.votes[viewer.id] || null) : null,
      myId: viewer ? viewer.id : null,
      myWord: viewer && this.phase !== PHASES.LOBBY ? viewer.word : null,
      myRole: canSeeAllSecrets && viewer ? viewer.role : null,
      wordReveal: canSeeAllSecrets ? this.currentWordPair : null,
      myWordFeedback: viewer && this.phase === PHASES.SETTLEMENT
        ? (this.wordFeedbacks[viewer.id] || null)
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
        // Never leak other players' roles or words unless settled or viewer is eliminated spectator
        role: canSeeAllSecrets ? p.role : (this.config.revealRoleOnOut && !p.alive ? p.role : null),
        word: canSeeAllSecrets ? p.word : null
      })),
      speeches: this.speeches,
      lastVoteSummary: this.lastVoteSummary,
      ghostMessages: canSeeAllSecrets ? this.ghostMessages : [],
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
