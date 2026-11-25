// Shared client/server helpers, served to the browser at /shared.js and required by Node.
// Keeps nickname rules and audio cue decisions identical on both sides, with no dependencies.
(function (root) {
  'use strict';

  var MAX_NICKNAME_LENGTH = 12;
  var DEFAULT_NAME_RE = /^\d+号玩家$/;

  function validateNickname(value) {
    if (typeof value !== 'string') {
      return { ok: false, error: '请输入自定义昵称' };
    }
    var name = value.trim();
    if (!name) {
      return { ok: false, error: '昵称不能为空，请输入自定义昵称' };
    }
    if (DEFAULT_NAME_RE.test(name)) {
      return { ok: false, error: '不能使用系统默认昵称（如 1号玩家），请自定义昵称' };
    }
    if (name.length > MAX_NICKNAME_LENGTH) {
      return { ok: false, error: '昵称最多 ' + MAX_NICKNAME_LENGTH + ' 个字符' };
    }
    return { ok: true, value: name };
  }

  // Returns a stable key for the one cue that matters right now, or null.
  // Never include serverNow / speeches / phaseEndsAt: repeated snapshots of the
  // same logical state must produce the same key.
  function cueKey(snapshot, viewerId) {
    if (!snapshot || !viewerId) return null;
    var phase = snapshot.phase;
    var round = snapshot.roundNumber || 0;
    var subRound = snapshot.speakingSubRound || 0;
    if ((phase === 'SPEAKING' || phase === 'TIE_PK') && snapshot.currentSpeakerId === viewerId) {
      return 'turn:' + phase + ':' + round + ':' + subRound + ':' + viewerId;
    }
    if (phase === 'VOTING') {
      var isPkVote = (snapshot.pkCandidates || []).length > 0;
      return 'vote:' + round + ':' + (isPkVote ? 'pk' : 'main') + ':' + viewerId;
    }
    if (phase === 'SETTLEMENT') return 'settle:' + round + ':' + viewerId;
    return null;
  }

  function shouldPlayCue(prevKey, nextKey) {
    return Boolean(nextKey) && nextKey !== prevKey;
  }

  // Pure cue state machine: always remember the current key (even while muted),
  // so re-enabling sound never replays a cue accumulated during silence.
  function nextCueState(prevState, nextKey, muted) {
    var prevKey = prevState && typeof prevState === 'object' && 'lastKey' in prevState
      ? prevState.lastKey
      : null;
    return {
      lastKey: nextKey || null,
      play: !muted && shouldPlayCue(prevKey, nextKey)
    };
  }

  var api = {
    MAX_NICKNAME_LENGTH: MAX_NICKNAME_LENGTH,
    validateNickname: validateNickname,
    cueKey: cueKey,
    shouldPlayCue: shouldPlayCue,
    nextCueState: nextCueState
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UndercoverShared = api;
})(typeof window !== 'undefined' ? window : null);
