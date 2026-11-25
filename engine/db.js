// Optional PostgreSQL persistence for settlements + word-pair feedback.
// Missing env / connect failure / query errors must never block in-memory rooms.
// Secrets come only from UNDERCOVER_PG* env (Vault injection); never log passwords.

'use strict';

let pool = null;
let enabled = false;
let initAttempted = false;
let lastError = null;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function isConfigured() {
  return Boolean(
    process.env.UNDERCOVER_PGHOST &&
    process.env.UNDERCOVER_PGDATABASE &&
    process.env.UNDERCOVER_PGUSER
  );
}

function loadPg() {
  try {
    return require('pg');
  } catch (err) {
    return null;
  }
}

function getStatus() {
  return {
    enabled,
    configured: isConfigured(),
    lastError: lastError || null
  };
}

/**
 * Probe connectivity once. Safe to call multiple times.
 * Never throws; returns whether persistence is enabled.
 */
async function initDb() {
  if (initAttempted) return enabled;
  initAttempted = true;

  if (!isConfigured()) {
    enabled = false;
    return false;
  }

  const pg = loadPg();
  if (!pg || !pg.Pool) {
    lastError = 'pg module not installed';
    console.warn('[db] optional pg module missing; running memory-only');
    enabled = false;
    return false;
  }

  const connectTimeout = envInt('UNDERCOVER_PGCONNECT_TIMEOUT_MS', 2000);
  const idleTimeout = envInt('UNDERCOVER_PGIDLE_TIMEOUT_MS', 10000);
  const statementTimeout = envInt('UNDERCOVER_PGSTATEMENT_TIMEOUT_MS', 5000);
  const max = Math.min(5, Math.max(1, envInt('UNDERCOVER_PGPOOL_MAX', 3)));

  const nextPool = new pg.Pool({
    host: process.env.UNDERCOVER_PGHOST,
    port: Number(process.env.UNDERCOVER_PGPORT) || 5432,
    database: process.env.UNDERCOVER_PGDATABASE,
    user: process.env.UNDERCOVER_PGUSER,
    password: process.env.UNDERCOVER_PGPASSWORD || undefined,
    max,
    connectionTimeoutMillis: connectTimeout,
    idleTimeoutMillis: idleTimeout,
    allowExitOnIdle: true,
    options: `-c statement_timeout=${statementTimeout}`
  });

  nextPool.on('error', (err) => {
    console.warn('[db] pool error:', err && err.message ? err.message : 'unknown');
  });

  try {
    const client = await nextPool.connect();
    try {
      await client.query('SELECT 1 AS ok');
    } finally {
      client.release();
    }
    pool = nextPool;
    enabled = true;
    lastError = null;
    console.log('[db] connected (optional persistence enabled)');
  } catch (err) {
    lastError = err && err.message ? err.message : 'connect failed';
    console.warn('[db] connect failed; memory-only:', lastError);
    try {
      await nextPool.end();
    } catch (_) {}
    pool = null;
    enabled = false;
  }

  return enabled;
}

async function ensurePlayers(client, playerIds) {
  const ids = [...new Set((playerIds || []).filter(Boolean))];
  for (const id of ids) {
    await client.query(
      'INSERT INTO players (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [id]
    );
  }
}

/**
 * One transaction at game end:
 * ensure players → INSERT games ON CONFLICT DO NOTHING → if inserted, INSERT game_players.
 * Duplicate game id is treated as success (already persisted).
 */
async function persistGameSettlement(payload) {
  if (!enabled || !pool || !payload || !payload.gameId) {
    return { ok: false, skipped: true };
  }

  const {
    gameId,
    roomCode,
    winner,
    winReason,
    wordPairId,
    categoryName,
    civilianWord,
    undercoverWord,
    spyCount,
    blankCount,
    playerCount,
    startedAt,
    endedAt,
    players
  } = payload;

  if (winner !== 'CIVILIAN' && winner !== 'UNDERCOVER') {
    return { ok: false, error: 'invalid winner' };
  }

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    lastError = err.message;
    console.warn('[db] persistGameSettlement acquire failed:', err.message);
    return { ok: false, error: err.message };
  }

  try {
    await client.query('BEGIN');
    await ensurePlayers(client, (players || []).map((p) => p.id));

    const inserted = await client.query(
      `INSERT INTO games (
         id, room_code, winner, win_reason, word_pair_id, category_name,
         civilian_word, undercover_word, spy_count, blank_count, player_count,
         started_at, ended_at
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12::timestamptz, $13::timestamptz
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        gameId,
        roomCode,
        winner,
        winReason || '',
        wordPairId,
        categoryName,
        civilianWord,
        undercoverWord,
        spyCount,
        blankCount,
        playerCount,
        startedAt,
        endedAt
      ]
    );

    if (inserted.rowCount === 0) {
      await client.query('COMMIT');
      return { ok: true, duplicate: true };
    }

    for (const p of players || []) {
      await client.query(
        `INSERT INTO game_players (
           game_id, player_id, seat, nickname, role, word, alive
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
        [
          gameId,
          p.id,
          p.seat,
          p.nickname,
          p.role,
          p.word == null ? '' : String(p.word),
          Boolean(p.alive)
        ]
      );
    }

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    lastError = err.message;
    console.warn('[db] persistGameSettlement failed:', err.message);
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

/**
 * Upsert word_pair_feedback after in-memory rating succeeds.
 * Same rating is a no-op at SQL level via IS DISTINCT FROM.
 */
async function upsertWordFeedback(payload) {
  if (!enabled || !pool || !payload || !payload.playerId || !payload.wordPairId) {
    return { ok: false, skipped: true };
  }

  const rating = payload.rating;
  if (rating !== 'up' && rating !== 'down') {
    return { ok: false, error: 'invalid rating' };
  }

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    lastError = err.message;
    console.warn('[db] upsertWordFeedback acquire failed:', err.message);
    return { ok: false, error: err.message };
  }

  try {
    await client.query('BEGIN');
    await ensurePlayers(client, [payload.playerId]);

    const result = await client.query(
      `INSERT INTO word_pair_feedback (
         player_id, word_pair_id, rating, room_code, game_id,
         civilian_word, undercover_word, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5::uuid,
         $6, $7, NOW(), NOW()
       )
       ON CONFLICT (player_id, word_pair_id) DO UPDATE SET
         rating = EXCLUDED.rating,
         room_code = EXCLUDED.room_code,
         game_id = COALESCE(EXCLUDED.game_id, word_pair_feedback.game_id),
         civilian_word = EXCLUDED.civilian_word,
         undercover_word = EXCLUDED.undercover_word,
         updated_at = NOW()
       WHERE word_pair_feedback.rating IS DISTINCT FROM EXCLUDED.rating
       RETURNING player_id`,
      [
        payload.playerId,
        payload.wordPairId,
        rating,
        payload.roomCode || null,
        payload.gameId || null,
        payload.civilianWord || null,
        payload.undercoverWord || null
      ]
    );

    await client.query('COMMIT');
    return { ok: true, unchanged: result.rowCount === 0 };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    lastError = err.message;
    console.warn('[db] upsertWordFeedback failed:', err.message);
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

async function closeDb() {
  if (!pool) {
    enabled = false;
    return;
  }
  const closing = pool;
  pool = null;
  enabled = false;
  try {
    await closing.end();
  } catch (_) {}
}

module.exports = {
  initDb,
  closeDb,
  getStatus,
  isConfigured,
  persistGameSettlement,
  upsertWordFeedback
};
