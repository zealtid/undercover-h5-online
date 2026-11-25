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

  // Test 6: 4-player wrong vote must continue to next speaking round (not end at 3 alive)
  const roomContinue = new UndercoverRoom('C401');
  for (let i = 1; i <= 4; i++) roomContinue.addPlayer({ nickname: `C${i}` });
  roomContinue.players.slice(1).forEach(p => roomContinue.toggleReady(p.id));
  assert.strictEqual(roomContinue.startGame(roomContinue.hostId).ok, true);
  while (roomContinue.phase === PHASES.SPEAKING) {
    roomContinue.submitSpeech(roomContinue.currentSpeakerId, { content: `描${roomContinue.turnIndex}` });
  }
  const civs4 = roomContinue.players.filter(p => p.role === ROLES.CIVILIAN);
  const targetCiv = civs4[0];
  roomContinue.players.filter(p => p.id !== targetCiv.id).forEach(p => roomContinue.castVote(p.id, targetCiv.id));
  roomContinue.castVote(targetCiv.id, civs4[1].id);
  assert.strictEqual(roomContinue.phase, PHASES.SPEAKING, '4p after wrong elim should continue speaking');
  assert.strictEqual(roomContinue.roundNumber, 2);
  assert.strictEqual(roomContinue.winner, null);
  assert.strictEqual(roomContinue.players.filter(p => p.alive).length, 3);
  // Second wrong elim -> 2 alive with 1 spy -> undercover wins
  while (roomContinue.phase === PHASES.SPEAKING) {
    roomContinue.submitSpeech(roomContinue.currentSpeakerId, { content: `二${roomContinue.turnIndex}` });
  }
  const aliveNow = roomContinue.players.filter(p => p.alive);
  const spyLeft = aliveNow.find(p => p.role === ROLES.UNDERCOVER);
  const civLeft = aliveNow.filter(p => p.role === ROLES.CIVILIAN);
  const elimCiv = civLeft[0];
  aliveNow.filter(p => p.id !== elimCiv.id).forEach(p => roomContinue.castVote(p.id, elimCiv.id));
  roomContinue.castVote(elimCiv.id, spyLeft.id);
  assert.strictEqual(roomContinue.phase, PHASES.SETTLEMENT);
  assert.strictEqual(roomContinue.winner, 'UNDERCOVER');
  const fb = roomContinue.submitWordFeedback(spyLeft.id, 'up');
  assert.strictEqual(fb.ok, true);
  assert.strictEqual(roomContinue.getWordFeedbackStats().up, 1);
  assert.strictEqual(roomContinue.getPlayerSnapshot(spyLeft.id).myWordFeedback, 'up');
  assert.strictEqual(roomContinue.submitWordFeedback(spyLeft.id, 'down').ok, true);
  assert.strictEqual(roomContinue.getWordFeedbackStats().down, 1);
  assert.strictEqual(roomContinue.getWordFeedbackStats().up, 0);
  roomContinue.clearTimer();

  // ---------- V1.5 M1: delayed spy teammate reveal ----------
  const roomM1 = new UndercoverRoom('M101');
  const m1Players = [];
  for (let i = 1; i <= 6; i++) m1Players.push(roomM1.addPlayer({ nickname: `M1_${i}` }).player);
  roomM1.updateConfig(m1Players[0].id, { spyCount: 2, delayedSpyReveal: true });
  m1Players.slice(1).forEach(p => roomM1.toggleReady(p.id));
  assert.strictEqual(roomM1.startGame(m1Players[0].id).ok, true);
  const spiesM1 = roomM1.players.filter(p => p.role === ROLES.UNDERCOVER);
  assert.strictEqual(spiesM1.length, 2);
  const snapR1 = roomM1.getPlayerSnapshot(spiesM1[0].id);
  assert.strictEqual(snapR1.spyTeammates, null, 'round1 spyTeammates must be null');
  const civSnapR1 = roomM1.getPlayerSnapshot(roomM1.players.find(p => p.role === ROLES.CIVILIAN).id);
  assert.strictEqual(civSnapR1.spyTeammates, null);
  // Finish speaking + eliminate a civilian -> round 2
  while (roomM1.phase === PHASES.SPEAKING) {
    roomM1.submitSpeech(roomM1.currentSpeakerId, { content: `m1-${roomM1.turnIndex}` });
  }
  const civVictim = roomM1.players.find(p => p.role === ROLES.CIVILIAN && p.alive);
  roomM1.players.filter(p => p.id !== civVictim.id).forEach(p => roomM1.castVote(p.id, civVictim.id));
  roomM1.castVote(civVictim.id, spiesM1[0].id);
  assert.strictEqual(roomM1.roundNumber, 2);
  assert.strictEqual(roomM1.phase, PHASES.SPEAKING);
  const snapR2 = roomM1.getPlayerSnapshot(spiesM1[0].id);
  assert.ok(Array.isArray(snapR2.spyTeammates) && snapR2.spyTeammates.length === 1);
  assert.strictEqual(snapR2.spyTeammates[0].id, spiesM1[1].id);
  const civSnapR2 = roomM1.getPlayerSnapshot(roomM1.players.find(p => p.role === ROLES.CIVILIAN && p.alive).id);
  assert.strictEqual(civSnapR2.spyTeammates, null);
  // Teammate field must not appear in public players[]
  snapR2.players.forEach(p => assert.strictEqual(p.spyTeammates, undefined));
  roomM1.clearTimer();

  // ---------- V1.5 M2: ALL_SAME easter egg ----------
  const roomEggSame = new UndercoverRoom('E201');
  for (let i = 1; i <= 4; i++) roomEggSame.addPlayer({ nickname: `ES${i}` });
  roomEggSame.updateConfig(roomEggSame.hostId, {
    easterEggMode: true,
    easterEggRate: 0.08
  });
  roomEggSame._forceEasterEggType = 'ALL_SAME';
  roomEggSame.players.slice(1).forEach(p => roomEggSame.toggleReady(p.id));
  assert.strictEqual(roomEggSame.startGame(roomEggSame.hostId).ok, true);
  assert.strictEqual(roomEggSame.easterEggType, 'ALL_SAME');
  const wordsSame = roomEggSame.players.map(p => p.word);
  assert.ok(wordsSame.every(w => w === wordsSame[0]));
  assert.ok(roomEggSame.players.every(p => p.role === ROLES.CIVILIAN));
  // Alive snapshots must not leak easterEggType
  assert.strictEqual(roomEggSame.getPlayerSnapshot(roomEggSame.players[0].id).easterEggType, null);
  // Complete 2 vote rounds -> EASTER_EGG settlement
  for (let round = 0; round < 2; round++) {
    while (roomEggSame.phase === PHASES.SPEAKING) {
      roomEggSame.submitSpeech(roomEggSame.currentSpeakerId, { content: `eggS${round}-${roomEggSame.turnIndex}` });
    }
    assert.strictEqual(roomEggSame.phase, PHASES.VOTING);
    const alive = roomEggSame.players.filter(p => p.alive);
    const target = alive[0];
    alive.filter(p => p.id !== target.id).forEach(p => roomEggSame.castVote(p.id, target.id));
    roomEggSame.castVote(target.id, alive[1].id);
  }
  assert.strictEqual(roomEggSame.phase, PHASES.SETTLEMENT);
  assert.strictEqual(roomEggSame.winner, 'EASTER_EGG');
  assert.strictEqual(roomEggSame.getPlayerSnapshot(roomEggSame.players[0].id).easterEggType, 'ALL_SAME');
  roomEggSame.clearTimer();

  // ---------- V1.5 M2: ALL_DIFFERENT easter egg ----------
  const roomEggDiff = new UndercoverRoom('E202');
  for (let i = 1; i <= 5; i++) roomEggDiff.addPlayer({ nickname: `ED${i}` });
  roomEggDiff.updateConfig(roomEggDiff.hostId, { easterEggMode: true });
  roomEggDiff._forceEasterEggType = 'ALL_DIFFERENT';
  roomEggDiff.players.slice(1).forEach(p => roomEggDiff.toggleReady(p.id));
  assert.strictEqual(roomEggDiff.startGame(roomEggDiff.hostId).ok, true);
  assert.strictEqual(roomEggDiff.easterEggType, 'ALL_DIFFERENT');
  assert.strictEqual(new Set(roomEggDiff.players.map(p => p.word)).size, roomEggDiff.players.length);
  assert.ok(roomEggDiff.players.every(p => p.role === ROLES.UNDERCOVER));
  // Spy teammate reveal must stay muted in easter egg
  roomEggDiff.roundNumber = 2;
  assert.strictEqual(roomEggDiff.getPlayerSnapshot(roomEggDiff.players[0].id).spyTeammates, null);
  roomEggDiff.clearTimer();

  // ---------- V1.5 M3: spy self-reveal win ----------
  const roomReveal = new UndercoverRoom('R301');
  for (let i = 1; i <= 4; i++) roomReveal.addPlayer({ nickname: `R${i}` });
  roomReveal.players.slice(1).forEach(p => roomReveal.toggleReady(p.id));
  assert.strictEqual(roomReveal.startGame(roomReveal.hostId).ok, true);
  const spyR = roomReveal.players.find(p => p.role === ROLES.UNDERCOVER);
  const civilianWord = roomReveal.currentWordPair.civilianWord;
  assert.strictEqual(roomReveal.startSelfReveal(spyR.id).ok, true);
  assert.strictEqual(roomReveal.phase, PHASES.SPY_GUESS);
  const winRes = roomReveal.submitSelfRevealGuess(spyR.id, `  ${civilianWord}  `);
  assert.strictEqual(winRes.ok, true);
  assert.strictEqual(roomReveal.phase, PHASES.SETTLEMENT);
  assert.strictEqual(roomReveal.winner, 'UNDERCOVER');
  roomReveal.clearTimer();

  // ---------- V1.5 M3: dual-spy wrong guess continues ----------
  const roomDualFail = new UndercoverRoom('R302');
  const dualPs = [];
  for (let i = 1; i <= 6; i++) dualPs.push(roomDualFail.addPlayer({ nickname: `DF${i}` }).player);
  roomDualFail.updateConfig(dualPs[0].id, { spyCount: 2 });
  dualPs.slice(1).forEach(p => roomDualFail.toggleReady(p.id));
  assert.strictEqual(roomDualFail.startGame(dualPs[0].id).ok, true);
  const dualSpies = roomDualFail.players.filter(p => p.role === ROLES.UNDERCOVER);
  assert.strictEqual(roomDualFail.startSelfReveal(dualSpies[0].id).ok, true);
  assert.strictEqual(roomDualFail.submitSelfRevealGuess(dualSpies[0].id, '绝对不是这个词xyz').ok, true);
  assert.strictEqual(dualSpies[0].alive, false);
  assert.strictEqual(dualSpies[1].alive, true);
  assert.notStrictEqual(roomDualFail.phase, PHASES.SETTLEMENT);
  assert.strictEqual(roomDualFail.phase, PHASES.SPEAKING);
  assert.strictEqual(roomDualFail.winner, null);
  roomDualFail.clearTimer();

  // ---------- V1.5 M3: civilian mis-reveal punished ----------
  const roomCivBoom = new UndercoverRoom('R303');
  for (let i = 1; i <= 4; i++) roomCivBoom.addPlayer({ nickname: `CB${i}` });
  roomCivBoom.players.slice(1).forEach(p => roomCivBoom.toggleReady(p.id));
  assert.strictEqual(roomCivBoom.startGame(roomCivBoom.hostId).ok, true);
  const civBoom = roomCivBoom.players.find(p => p.role === ROLES.CIVILIAN);
  const ownWord = civBoom.word;
  assert.strictEqual(roomCivBoom.startSelfReveal(civBoom.id).ok, true);
  assert.strictEqual(roomCivBoom.submitSelfRevealGuess(civBoom.id, ownWord).ok, true);
  assert.strictEqual(civBoom.alive, false);
  // Guessing own civilian word as civilian still fails (must be undercover)
  if (roomCivBoom.phase === PHASES.SETTLEMENT) {
    // Possible if only 1 spy left and conditions met — or continue
    assert.ok(roomCivBoom.winner === 'UNDERCOVER' || roomCivBoom.winner === 'CIVILIAN');
  } else {
    assert.strictEqual(roomCivBoom.phase, PHASES.SPEAKING);
  }
  roomCivBoom.clearTimer();

  // ---------- V1.5 M4: ghost bet isolation + scoring ----------
  const roomBet = new UndercoverRoom('B401');
  for (let i = 1; i <= 4; i++) roomBet.addPlayer({ nickname: `B${i}` });
  roomBet.players.slice(1).forEach(p => roomBet.toggleReady(p.id));
  assert.strictEqual(roomBet.startGame(roomBet.hostId).ok, true);
  const aliveBetter = roomBet.players.find(p => p.alive);
  assert.strictEqual(roomBet.placeGhostBet(aliveBetter.id, 'nextOut', roomBet.players[0].id).ok, false);
  assert.strictEqual(roomBet.getPlayerSnapshot(aliveBetter.id).ghostBets, null);
  assert.strictEqual(roomBet.getPlayerSnapshot(aliveBetter.id).myGhostBet, null);

  while (roomBet.phase === PHASES.SPEAKING) {
    roomBet.submitSpeech(roomBet.currentSpeakerId, { content: `bet-${roomBet.turnIndex}` });
  }
  // Eliminate one civilian to create a spectator
  const spyBet = roomBet.players.find(p => p.role === ROLES.UNDERCOVER);
  const civsBet = roomBet.players.filter(p => p.role === ROLES.CIVILIAN);
  const outCiv = civsBet[0];
  roomBet.players.filter(p => p.id !== outCiv.id).forEach(p => roomBet.castVote(p.id, outCiv.id));
  roomBet.castVote(outCiv.id, civsBet[1].id);
  assert.strictEqual(outCiv.alive, false);
  assert.notStrictEqual(roomBet.phase, PHASES.SETTLEMENT);

  // Spectator places nextOut + winner bets
  const nextTarget = roomBet.players.find(p => p.alive && p.role === ROLES.CIVILIAN) || roomBet.players.find(p => p.alive);
  assert.strictEqual(roomBet.placeGhostBet(outCiv.id, 'nextOut', nextTarget.id).ok, true);
  assert.strictEqual(roomBet.placeGhostBet(outCiv.id, 'winner', 'UNDERCOVER').ok, true);
  // Locked winner cannot change
  assert.strictEqual(roomBet.placeGhostBet(outCiv.id, 'winner', 'CIVILIAN').ok, false);
  const ghostSnap = roomBet.getPlayerSnapshot(outCiv.id);
  assert.ok(ghostSnap.ghostBets);
  assert.ok(ghostSnap.myGhostBet);
  assert.strictEqual(ghostSnap.myGhostBet.finalWinner, 'UNDERCOVER');
  // Alive still isolated
  const aliveLeft = roomBet.players.find(p => p.alive);
  assert.strictEqual(roomBet.getPlayerSnapshot(aliveLeft.id).ghostBets, null);

  // Finish speaking and eliminate nextTarget so nextOut hits; leave spy win path
  while (roomBet.phase === PHASES.SPEAKING) {
    roomBet.submitSpeech(roomBet.currentSpeakerId, { content: `bet2-${roomBet.turnIndex}` });
  }
  const aliveNowBet = roomBet.players.filter(p => p.alive);
  aliveNowBet.filter(p => p.id !== nextTarget.id).forEach(p => roomBet.castVote(p.id, nextTarget.id));
  roomBet.castVote(nextTarget.id, spyBet.id);
  // After 2nd civilian out in 4p: 2 alive with 1 spy -> undercover wins
  assert.strictEqual(roomBet.phase, PHASES.SETTLEMENT);
  assert.strictEqual(roomBet.winner, 'UNDERCOVER');
  assert.strictEqual(roomBet.ghostBets[outCiv.id].score, 30);
  assert.ok(roomBet.bestSpectator);
  assert.strictEqual(roomBet.bestSpectator.playerId, outCiv.id);
  roomBet.clearTimer();

  // ---------- Bug regressions ----------
  // Self-reveal in round 1 must NOT unlock spy teammates (requires a completed vote round)
  const roomBugA = new UndercoverRoom('BUGA');
  const bugAPs = [];
  for (let i = 1; i <= 6; i++) bugAPs.push(roomBugA.addPlayer({ nickname: `BA${i}` }).player);
  roomBugA.updateConfig(bugAPs[0].id, { spyCount: 2 });
  bugAPs.slice(1).forEach(p => roomBugA.toggleReady(p.id));
  assert.strictEqual(roomBugA.startGame(bugAPs[0].id).ok, true);
  const bugASpies = roomBugA.players.filter(p => p.role === ROLES.UNDERCOVER);
  const bugACiv = roomBugA.players.find(p => p.role === ROLES.CIVILIAN);
  assert.strictEqual(roomBugA.startSelfReveal(bugACiv.id).ok, true);
  assert.strictEqual(roomBugA.submitSelfRevealGuess(bugACiv.id, 'wrong').ok, true);
  assert.ok(roomBugA.roundNumber >= 2);
  assert.strictEqual(roomBugA.completedVoteRounds, 0);
  assert.strictEqual(roomBugA.getPlayerSnapshot(bugASpies[0].id).spyTeammates, null);
  roomBugA.clearTimer();

  // Client config must not force easter egg type; only room._forceEasterEggType (tests) works
  const roomBugB = new UndercoverRoom('BUGB');
  for (let i = 1; i <= 3; i++) roomBugB.addPlayer({ nickname: `BB${i}` });
  roomBugB.updateConfig(roomBugB.hostId, {
    easterEggMode: true,
    _forceEasterEggType: 'ALL_SAME'
  });
  assert.strictEqual(roomBugB.config._forceEasterEggType, undefined);
  roomBugB.players.slice(1).forEach(p => roomBugB.toggleReady(p.id));
  roomBugB._forceEasterEggType = 'ALL_DIFFERENT';
  assert.strictEqual(roomBugB.startGame(roomBugB.hostId).ok, true);
  assert.strictEqual(roomBugB.easterEggType, 'ALL_DIFFERENT');
  roomBugB.clearTimer();

  // Self-reveal elimination must score ghost nextOut bets
  const roomBugC = new UndercoverRoom('BUGC');
  for (let i = 1; i <= 4; i++) roomBugC.addPlayer({ nickname: `BC${i}` });
  roomBugC.players.slice(1).forEach(p => roomBugC.toggleReady(p.id));
  assert.strictEqual(roomBugC.startGame(roomBugC.hostId).ok, true);
  while (roomBugC.phase === PHASES.SPEAKING) {
    roomBugC.submitSpeech(roomBugC.currentSpeakerId, { content: `bc${roomBugC.turnIndex}` });
  }
  const bugCSpy = roomBugC.players.find(p => p.role === ROLES.UNDERCOVER);
  const bugCCivs = roomBugC.players.filter(p => p.role === ROLES.CIVILIAN);
  const bugCOut = bugCCivs[0];
  roomBugC.players.filter(p => p.id !== bugCOut.id).forEach(p => roomBugC.castVote(p.id, bugCOut.id));
  roomBugC.castVote(bugCOut.id, bugCCivs[1].id);
  const bugCTarget = roomBugC.players.find(p => p.alive && p.role === ROLES.CIVILIAN);
  assert.strictEqual(roomBugC.placeGhostBet(bugCOut.id, 'nextOut', bugCTarget.id).ok, true);
  assert.strictEqual(roomBugC.startSelfReveal(bugCTarget.id).ok, true);
  assert.strictEqual(roomBugC.submitSelfRevealGuess(bugCTarget.id, 'nope').ok, true);
  assert.strictEqual(bugCTarget.alive, false);
  assert.strictEqual(roomBugC.ghostBets[bugCOut.id].score, 10);
  roomBugC.clearTimer();

  console.log('ALL FSM TESTS PASSED (3p, 6p, taboo, projection, PK, reconnect, abstain-PK, voice-ban, kick, 4p-continue, word-fb, M1-M4, bugfixes)');
}

runTests();
