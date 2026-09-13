'use strict';
// One opted-in online browser per hour. All upstream access stays in that browser.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const HOUR = 3600000;
const BOARDS = ['all', '30d', '7d', '24h'];
const text = (value, max) => String(value ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
function normalizeBoards(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid boards');
  const out = {};
  for (const board of BOARDS) {
    const rows = raw[board];
    if (!Array.isArray(rows) || rows.length < 30 || rows.length > 100) throw new Error('incomplete board');
    const seen = new Set();
    out[board] = rows.map((row, i) => {
      const uid = text(row?.uid, 100), handle = text(row?.handle, 40).replace(/^@/, '').toLowerCase();
      const pnl = Number(row?.pnl);
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(uid) || !/^[a-z0-9_.-]{1,40}$/.test(handle)
        || seen.has(uid) || row.rank !== i + 1 || typeof row.pnl !== 'number' || !Number.isFinite(pnl) || Math.abs(pnl) > 1e15) throw new Error('invalid rank row');
      seen.add(uid);
      let avatar = '';
      try { const u = new URL(String(row.avatar || '')); if (u.protocol === 'https:' && !u.username && !u.password) avatar = u.href.slice(0, 1000); } catch {}
      const count = (v) => Number.isFinite(Number(v)) ? Math.max(0, Math.min(1e15, Math.round(Number(v)))) : 0;
      return { rank: i + 1, uid, handle, name: text(row.name, 120), twitter: text(row.twitter, 120), avatar,
        followers: count(row.followers), numTrades: count(row.numTrades), volume: count(row.volume), pnl: Math.round(pnl) };
    });
    if (out[board].some((row, i, list) => i && row.pnl > list[i - 1].pnl)) throw new Error('unordered board');
  }
  return out;
}
function atomicJson(file, value, mode = 0o600) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value), { mode }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
function createCollector({ dataDir, snapshotPath, clients, now = Date.now, random = crypto.randomInt, log = () => {} }) {
  const statePath = path.join(dataDir, 'fomo-browser-collector-state.json');
  const resultPath = path.join(dataDir, 'fomo-browser-leaderboards.json');
  let state = readJson(statePath, {});
  const identity = (ctx) => ctx?.userId && ctx?.extensionSession?.id
    ? crypto.createHash('sha256').update(`${ctx.userId}|${ctx.extensionSession.id}`).digest('hex') : '';
  const save = () => atomicJson(statePath, state);
  function tick() {
    const at = now();
    if (state.pending) {
      if (at < state.pending.expiresAt) return;
      state = { ...state, pending: null, lastResult: 'timeout' }; save();
    }
    if (at < Number(state.nextAttemptAt || 0)) return;
    const users = new Map();
    for (const client of clients()) {
      if (!client.extensionFeedOnly || !client.fomoRankCollectorReady || !identity(client.userCtx)
        || client.res?.writableEnded || client.res?.destroyed) continue;
      // Multiple browser sessions must not increase one account's chance of selection.
      const group = users.get(client.userCtx.userId) || []; group.push(client); users.set(client.userCtx.userId, group);
    }
    const groups = [...users.values()];
    if (!groups.length) return;
    const group = groups[random(groups.length)], client = group[random(group.length)];
    const pending = { id: crypto.randomUUID(), identity: identity(client.userCtx), issuedAt: at, expiresAt: at + 180000 };
    state = { ...state, pending, lastAttemptAt: at, nextAttemptAt: at + HOUR, lastResult: 'running' };
    save(); // Reserve durably before dispatch; restart/failed writes cannot double-assign.
    try {
      client.res.write(`event: fomo-rank-collect\ndata: ${JSON.stringify({ id: pending.id, expiresAt: pending.expiresAt, version: 1 })}\n\n`);
      log('assigned', { onlineAccounts: groups.length });
    } catch { state.pending = null; state.lastResult = 'disconnected'; save(); }
  }
  function accept(ctx, body) {
    const at = now(), pending = state.pending;
    if (!pending || at >= pending.expiresAt || body?.id !== pending.id || identity(ctx) !== pending.identity) {
      return { status: 409, body: { ok: false, error: 'lease expired or not assigned to this session' } };
    }
    if (body.ok !== true) {
      const status = Math.trunc(Number(body.status) || 0);
      const retryAfterMs = Math.max(0, Math.min(7 * 24 * HOUR, Number(body.retryAfterMs) || 0));
      const failures = Math.min(3, Number(state.failures || 0) + 1);
      const wait = status >= 400 ? 12 * HOUR * (2 ** (failures - 1)) : HOUR;
      state = { ...state, pending: null, failures, nextAttemptAt: Math.max(state.nextAttemptAt, at + wait, at + retryAfterMs), lastResult: `failed-${status}` };
      save(); log('failed', { status, nextAttemptAt: state.nextAttemptAt });
      return { status: 200, body: { ok: true, accepted: false } };
    }
    let boards;
    try { boards = normalizeBoards(body.boards); }
    catch { return { status: 400, body: { ok: false, error: 'invalid or incomplete leaderboard snapshot' } }; }
    const prior = readJson(snapshotPath, {});
    // A concurrent official collector may have already published a newer snapshot.
    const superseded = Number(prior.updatedAt) > pending.issuedAt;
    atomicJson(resultPath, { updatedAt: at, source: 'opt-in-browser', boards });
    if (!superseded) {
      // Preserve alliances/common-following and the existing public top-30 layout.
      atomicJson(snapshotPath, { ...prior, updatedAt: at, boards: Object.fromEntries(BOARDS.map(key => [key, boards[key].slice(0, 30)])),
        leaderboardSource: 'opt-in-browser' }, 0o644);
    }
    state = { ...state, pending: null, failures: 0, lastSuccessAt: at, lastResult: superseded ? 'saved-newer-public-kept' : 'published' };
    save(); log('completed', { published: !superseded });
    return { status: 200, body: { ok: true, accepted: true, published: !superseded } };
  }
  return { tick, accept, status: () => ({ nextAttemptAt: Number(state.nextAttemptAt || 0), lastSuccessAt: Number(state.lastSuccessAt || 0), lastResult: state.lastResult || 'waiting', pending: !!state.pending }) };
}
module.exports = { createCollector, normalizeBoards };
