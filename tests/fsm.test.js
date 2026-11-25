const assert = require('assert');
const { UndercoverRoom, PHASES, ROLES, checkTabooWord } = require('../engine/fsm');

function runTests() {
  // Test 1: Taboo word check
  assert.strictEqual(checkTabooWord('我喜欢喝纯牛奶', '牛奶'), '牛奶');
  assert.strictEqual(checkTabooWord('早上有奶香味', '牛奶'), '奶');
  assert.strictEqual(checkTabooWord('白色液体很营养', '牛奶'), null);

  // Test 2: 3-player game config lock + 2 speaking sub-rounds + view projection anti-cheat
  const room3 = new UndercoverRoom('1001');
  const p1 = room3.addPlayer({ nickname: '甲' }).player;
  const p2 = room3.addPlayer({ nickname: '乙' }).player;
  const p3 = room3.addPlayer({ nickname: '丙' }).player;

  // Trying to set 2 spies in a 3-player room must clamp to 1
  room3.updateConfig(p1.id, { spyCount: 2, blankCount: 1 });
  assert.strictEqual(room3.config.spyCount, 1);
  assert.strictEqual(room3.config.blankCount, 0);

  room3.toggleReady(p2.id);
  room3.toggleReady(p3.id);
  assert.strictEqual(room3.startGame(p1.id).ok, true);
  assert.strictEqual(room3.phase, PHASES.SPEAKING);

  // View projection anti-cheat: alive player sees myWord, never roles or other words
  const snap1 = room3.getPlayerSnapshot(p1.id);
  assert.ok(snap1.myWord && snap1.myWord.length > 0);
  assert.strictEqual(snap1.myRole, null);
  assert.strictEqual(snap1.wordReveal, null);
  snap1.players.forEach(p => {
    assert.strictEqual(p.role, null);
    assert.strictEqual(p.word, null);
  });

  // 3-player requires 2 speaking sub-rounds before VOTING
  for (let i = 0; i < 3; i++) {
    const res = room3.submitSpeech(room3.currentSpeakerId, { speechType: 'text', content: `第一轮描述${i}` });
    assert.strictEqual(res.ok, true);
  }
  assert.strictEqual(room3.phase, PHASES.SPEAKING);
  assert.strictEqual(room3.speakingSubRound, 2);

  for (let i = 0; i < 3; i++) {
    const res = room3.submitSpeech(room3.currentSpeakerId, { speechType: 'text', content: `第二轮描述${i}` });
    assert.strictEqual(res.ok, true);
  }
  assert.strictEqual(room3.phase, PHASES.VOTING);

  // Vote out the undercover -> Civilians win
  const spy3 = room3.players.find(p => p.role === ROLES.UNDERCOVER);
  const civs3 = room3.players.filter(p => p.role === ROLES.CIVILIAN);
  room3.castVote(civs3[0].id, spy3.id);
  room3.castVote(civs3[1].id, spy3.id);
  room3.castVote(spy3.id, civs3[0].id);

  assert.strictEqual(room3.phase, PHASES.SETTLEMENT);
  assert.strictEqual(room3.winner, 'CIVILIAN');
  room3.clearTimer();

  // Test 3: 6-player 2-undercover game + Tie PK + Reconnect
  const room6 = new UndercoverRoom('2002');
  const players6 = [];
  for (let i = 1; i <= 6; i++) {
    players6.push(room6.addPlayer({ nickname: `玩家${i}` }).player);
  }
  room6.updateConfig(players6[0].id, { spyCount: 2 });
  assert.strictEqual(room6.config.spyCount, 2);
  players6.slice(1).forEach(p => room6.toggleReady(p.id));
  assert.strictEqual(room6.startGame(players6[0].id).ok, true);

  // Complete speaking round
  for (let i = 0; i < 6; i++) {
    assert.strictEqual(room6.submitSpeech(room6.currentSpeakerId, { content: `描述${i}` }).ok, true);
  }
  assert.strictEqual(room6.phase, PHASES.VOTING);

  // Force a 3-3 tie between players6[0] and players6[1]
  room6.castVote(players6[0].id, players6[1].id);
  room6.castVote(players6[2].id, players6[1].id);
  room6.castVote(players6[3].id, players6[1].id);
  room6.castVote(players6[1].id, players6[0].id);
  room6.castVote(players6[4].id, players6[0].id);
  room6.castVote(players6[5].id, players6[0].id);

  assert.strictEqual(room6.phase, PHASES.TIE_PK);
  assert.strictEqual(room6.pkCandidates.length, 2);

  // Reconnect test
  room6.markDisconnected(players6[0].id);
  const reconn = room6.addPlayer({ reconnectToken: players6[0].token });
  assert.strictEqual(reconn.ok, true);
  assert.strictEqual(reconn.reconnected, true);
  room6.clearTimer();

  // Test 4: abstain must not poison next-round PK; voice cannot bypass taboo
  const room4 = new UndercoverRoom('4004');
  for (let i = 1; i <= 4; i++) room4.addPlayer({ nickname: `P${i}` });
  room4.players.slice(1).forEach(p => room4.toggleReady(p.id));
  assert.strictEqual(room4.startGame(room4.hostId).ok, true);
  while (room4.phase === PHASES.SPEAKING) {
    assert.strictEqual(room4.submitSpeech(room4.currentSpeakerId, { content: `描述${room4.turnIndex}` }).ok, true);
  }
  assert.strictEqual(room4.phase, PHASES.VOTING);
  room4.resolveVotes(); // all abstain
  assert.strictEqual(room4.consecutiveTies, 0);
  while (room4.phase === PHASES.SPEAKING) {
    room4.submitSpeech(room4.currentSpeakerId, { content: `二轮${room4.turnIndex}` });
  }
  const alive4 = room4.players.filter(p => p.alive);
  room4.castVote(alive4[0].id, alive4[1].id);
  room4.castVote(alive4[1].id, alive4[0].id);
  room4.castVote(alive4[2].id, alive4[1].id);
  room4.castVote(alive4[3].id, alive4[0].id);
  assert.strictEqual(room4.phase, PHASES.TIE_PK, 'first tie after abstain must enter PK');
  room4.clearTimer();

  const roomVoice = new UndercoverRoom('V001');
  for (let i = 1; i <= 3; i++) roomVoice.addPlayer({ nickname: `V${i}` });
  roomVoice.players.slice(1).forEach(p => roomVoice.toggleReady(p.id));
  roomVoice.startGame(roomVoice.hostId);
  const speaker = roomVoice.players.find(p => p.id === roomVoice.currentSpeakerId);
  const bypass = roomVoice.submitSpeech(speaker.id, {
    speechType: 'voice',
    content: `词是${speaker.word}`,
    audioUrl: null
  });
  assert.strictEqual(bypass.ok, false);
  assert.match(bypass.error, /语音|文字/);
  const bypass2 = roomVoice.submitSpeech(speaker.id, {
    speechType: 'voice',
    content: `词是${speaker.word}`,
    audioUrl: 'https://cdn.example.com/a.webm',
    durationMs: 3000
  });
  assert.strictEqual(bypass2.ok, false);
  assert.match(bypass2.error, /禁字/);
  roomVoice.clearTimer();

  // Test 5: kick + cannot start with offline players
  const roomKick = new UndercoverRoom('K001');
  const ka = roomKick.addPlayer({ nickname: '房主' }).player;
  const kb = roomKick.addPlayer({ nickname: '路人' }).player;
  const kc = roomKick.addPlayer({ nickname: '挂机' }).player;
  assert.strictEqual(roomKick.kickPlayer(ka.id, kc.id).ok, true);
  assert.strictEqual(roomKick.players.length, 2);
  roomKick.addPlayer({ nickname: '新人' });
  const offline = roomKick.players.find(p => p.nickname === '路人');
  roomKick.markDisconnected(offline.id);
  offline.ready = true;
  roomKick.players.filter(p => p.id !== ka.id && p.online).forEach(p => roomKick.toggleReady(p.id));
  const startOffline = roomKick.startGame(ka.id);
  assert.strictEqual(startOffline.ok, false);
  assert.match(startOffline.error, /离线/);
  roomKick.clearTimer();

  console.log('ALL FSM TESTS PASSED (3p, 6p, taboo, projection, PK, reconnect, abstain-PK, voice-ban, kick)');
}

runTests();
