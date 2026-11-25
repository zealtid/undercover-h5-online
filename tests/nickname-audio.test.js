const assert = require('assert');
const { validateNickname } = require('../engine/nickname');
const { cueKey, shouldPlayCue, nextCueState } = require('../public/shared');
const { UndercoverRoom } = require('../engine/fsm');

function runTests() {
  // 1. Empty / whitespace-only nicknames are rejected.
  assert.strictEqual(validateNickname('').ok, false);
  assert.strictEqual(validateNickname('   ').ok, false);
  assert.strictEqual(validateNickname(null).ok, false);
  assert.match(validateNickname('   ').error, /不能为空/);

  // 2. Program-generated default names are rejected.
  assert.strictEqual(validateNickname('1号玩家').ok, false);
  assert.strictEqual(validateNickname('12号玩家').ok, false);
  assert.match(validateNickname('1号玩家').error, /默认昵称/);

  // 3. Valid custom nickname is accepted (and trimmed, never truncated).
  assert.deepStrictEqual(validateNickname('老王'), { ok: true, value: '老王' });
  assert.strictEqual(validateNickname('  老王  ').value, '老王');

  // 4. Length boundary: 12 accepted, 13 rejected.
  const twelve = '王'.repeat(12);
  assert.strictEqual(validateNickname(twelve).ok, true);
  assert.strictEqual(validateNickname(twelve).value, twelve);
  assert.strictEqual(validateNickname('王'.repeat(13)).ok, false);
  assert.match(validateNickname('王'.repeat(13)).error, /最多 12/);

  // 5. Room: invalid names cannot add players; valid names are kept verbatim.
  const room = new UndercoverRoom('N001');
  for (const bad of ['', '   ', '1号玩家', '12号玩家', '王'.repeat(13)]) {
    const res = room.addPlayer({ nickname: bad });
    assert.strictEqual(res.ok, false, `空昵称/默认名不应加入成功：${bad}`);
    assert.match(res.error, /昵称|默认/);
  }
  assert.strictEqual(room.players.length, 0, '失败加入不能留下玩家或占座');

  const first = room.addPlayer({ nickname: '老王' });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.player.nickname, '老王');
  assert.strictEqual(first.reconnected, false);
  const second = room.addPlayer({ nickname: '  小李  ' });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.player.nickname, '小李', '合法昵称不得被改成默认名');

  // 6. Reconnect by token: no valid nickname required, original name/session preserved.
  room.markDisconnected(second.player.id);
  for (const bad of ['', '   ', '1号玩家']) {
    const rc = room.addPlayer({ reconnectToken: second.player.token, nickname: bad });
    assert.strictEqual(rc.ok, true);
    assert.strictEqual(rc.reconnected, true);
    assert.strictEqual(rc.player.id, second.player.id);
    assert.strictEqual(rc.player.online, true);
    assert.strictEqual(rc.player.nickname, '小李', '非法/空昵称不得覆盖重连玩家昵称');
  }
  const renamed = room.addPlayer({ reconnectToken: second.player.token, nickname: '小李新' });
  assert.strictEqual(renamed.reconnected, true);
  assert.strictEqual(renamed.player.nickname, '小李新', '大厅内合法新昵称仍可更新');
  room.clearTimer();

  // 7. Cue idempotence: same logical state never repeats; state changes do.
  const me = 'pl_me';
  const speaking = {
    phase: 'SPEAKING', roundNumber: 1, speakingSubRound: 1,
    currentSpeakerId: me, serverNow: 1000, speeches: [{ id: 'sp_1' }]
  };
  const key = cueKey(speaking, me);
  assert.ok(key, '轮到自己发言应生成 cue key');
  assert.strictEqual(cueKey({ ...speaking, serverNow: 9999, speeches: [] }, me), key,
    '服务器时间与发言列表变化不得改变 cue key');
  assert.strictEqual(shouldPlayCue(null, key), true);
  assert.strictEqual(shouldPlayCue(key, key), false);

  const otherTurn = { ...speaking, currentSpeakerId: 'pl_other' };
  assert.strictEqual(cueKey(otherTurn, me), null);
  assert.strictEqual(shouldPlayCue(key, cueKey(otherTurn, me)), false);
  const nextSubRound = cueKey({ ...speaking, speakingSubRound: 2 }, me);
  assert.notStrictEqual(nextSubRound, key);
  assert.strictEqual(shouldPlayCue(key, nextSubRound), true);
  const voteKey = cueKey({ phase: 'VOTING', roundNumber: 1, pkCandidates: [] }, me);
  assert.ok(voteKey);
  assert.strictEqual(cueKey({ phase: 'VOTING', roundNumber: 1, pkCandidates: [] }, me), voteKey);
  assert.notStrictEqual(voteKey, cueKey({ phase: 'VOTING', roundNumber: 1, pkCandidates: ['pl_x'] }, me));

  // 8. Mute handling via pure state machine: muted cues are remembered but never played;
  //    unmuting must not replay the old cue, only a genuine new state.
  let state = { lastKey: null };
  let step = nextCueState(state, key, true);
  assert.strictEqual(step.play, false);
  state = step;
  step = nextCueState(state, key, false);
  assert.strictEqual(step.play, false, '取消静音后同一旧状态不得补响');
  state = step;
  step = nextCueState(state, nextSubRound, false);
  assert.strictEqual(step.play, true, '新状态应响');
  state = step;
  step = nextCueState(state, nextSubRound, false);
  assert.strictEqual(step.play, false, '同一新状态重复同步不得重复响');
  assert.strictEqual(step.lastKey, nextSubRound);

  console.log('ALL NICKNAME/AUDIO TESTS PASSED (validation, room, reconnect, cue idempotence, mute)');
}

runTests();
