'use strict';

const fs = require('node:fs');

let db  = null;
let cfg = null;
let timer = null;
let running = false;
const stats = { lastPoll: null, lastError: null, pollCount: 0, updates: 0 };

const TERMINAL = new Set([
  'delivered', 'failed', 'undelivered', 'rejected', 'unknown', 'dry-run'
]);

const BACKOFF_MS = [
  30 * 1000,
  60 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  8 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000
];

function init(options){
  db  = options.db;
  cfg = {
    pollIntervalMs: options.pollIntervalMs || 60000,
    sms:    options.sms,
    logPath: options.logPath,
    onUpdate: options.onUpdate || (() => {})
  };

  db.prepare(`UPDATE sent_alerts
    SET next_check_at = ?
    WHERE next_check_at IS NULL
      AND (delivery_status IS NULL OR delivery_status = 'pending')
      AND provider_sid IS NOT NULL`)
    .run(new Date().toISOString());

  schedule();
  log('receipts poller started (interval ' + (cfg.pollIntervalMs / 1000) + 's)');
}

function stop(){
  if (timer){ clearTimeout(timer); timer = null; }
  log('receipts poller stopped');
}

function schedule(){
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    try { await poll(); }
    catch (err){ log('poll error: ' + (err.message || err)); stats.lastError = err.message; }
    finally { schedule(); }
  }, cfg.pollIntervalMs);
  if (timer.unref) timer.unref();
}

async function poll(){
  if (running) return { skipped: true, reason: 'already-running' };
  running = true;

  try {
    const now = new Date().toISOString();
    const pending = db.prepare(`SELECT * FROM sent_alerts
      WHERE (delivery_status IS NULL OR delivery_status NOT IN
             ('delivered','failed','undelivered','rejected','unknown','dry-run'))
        AND provider_sid IS NOT NULL
        AND next_check_at IS NOT NULL
        AND next_check_at <= ?
      ORDER BY next_check_at ASC
      LIMIT 100`).all(now);

    stats.lastPoll = now;
    stats.pollCount++;

    if (!pending.length){
      return { checked: 0, updated: 0 };
    }

    log('polling ' + pending.length + ' message' + (pending.length === 1 ? '' : 's'));

    let updated = 0;
    for (const row of pending){
      try {
        const result = await cfg.sms.checkStatus(row.provider_sid);
        if (applyResult(row, result)) updated++;
      } catch (err){
        log('error on ' + row.signature + ': ' + (err.message || err));
        bumpWithoutStatusChange(row);
      }
    }

    stats.updates += updated;
    if (updated) cfg.onUpdate({ updated });

    return { checked: pending.length, updated };
  } finally {
    running = false;
  }
}

function applyResult(row, result){
  const now = new Date().toISOString();
  const checkCount = (row.check_count || 0) + 1;
  let newStatus = result.status || 'pending';
  const isTerminal = TERMINAL.has(newStatus);
  const nextDelay = isTerminal ? null : nextDelayFor(checkCount);

  if (!isTerminal && nextDelay === null){
    newStatus = 'unknown';
  }

  const changed = row.delivery_status !== newStatus;

  const updateStmt = db.prepare(`UPDATE sent_alerts
    SET delivery_status = ?, delivery_error = ?, delivery_checked_at = ?,
        next_check_at = ?, check_count = ?
    WHERE signature = ?`);

  const eventStmt = db.prepare(`INSERT INTO delivery_events
    (signature, status, raw_status, error, provider) VALUES (?,?,?,?,?)`);

  db.transaction(() => {
    updateStmt.run(
      newStatus,
      result.error || null,
      now,
      nextDelay ? new Date(Date.now() + nextDelay).toISOString() : null,
      checkCount,
      row.signature
    );
    if (changed){
      eventStmt.run(row.signature, newStatus, result.raw || null, result.error || null, row.provider || null);
    }
  })();

  if (changed){
    log(row.signature + ' -> ' + newStatus + (result.error ? ' (' + result.error + ')' : ''));
  }

  return changed;
}

function bumpWithoutStatusChange(row){
  const checkCount = (row.check_count || 0) + 1;
  const delay = nextDelayFor(checkCount) || (60 * 60 * 1000);
  db.prepare(`UPDATE sent_alerts
    SET check_count = ?, next_check_at = ?, delivery_checked_at = ?
    WHERE signature = ?`)
    .run(checkCount, new Date(Date.now() + delay).toISOString(),
         new Date().toISOString(), row.signature);
}

function nextDelayFor(checkCount){
  if (checkCount >= BACKOFF_MS.length) return null;
  return BACKOFF_MS[checkCount];
}

function summary(){
  const rows = db.prepare(`SELECT
      COALESCE(delivery_status, 'pending') AS s, COUNT(*) AS n
    FROM sent_alerts GROUP BY s`).all();
  const out = {
    delivered:0, sent:0, queued:0, pending:0,
    failed:0, undelivered:0, rejected:0, unknown:0, 'dry-run':0
  };
  rows.forEach(r => { out[r.s] = r.n; });
  out.total = rows.reduce((s, r) => s + r.n, 0);
  return out;
}

function recent(limit){
  return db.prepare(`SELECT sa.*, f.name AS farmer_name, f.loc AS farmer_loc
    FROM sent_alerts sa
    LEFT JOIN farmers f ON f.id = sa.farmer_id
    ORDER BY sa.sent_at DESC LIMIT ?`).all(limit || 50);
}

function statusMap(){
  const rows = db.prepare("SELECT signature, COALESCE(delivery_status, 'pending') AS s FROM sent_alerts").all();
  const map = {};
  rows.forEach(r => { map[r.signature] = r.s; });
  return map;
}

function events(signature){
  return db.prepare(`SELECT * FROM delivery_events
    WHERE signature = ? ORDER BY recorded_at ASC`).all(signature);
}

function retry(signature){
  db.prepare(`UPDATE sent_alerts
    SET delivery_status = 'pending', next_check_at = ?, check_count = 0,
        delivery_checked_at = NULL, delivery_error = NULL
    WHERE signature = ?`)
    .run(new Date().toISOString(), signature);
  return true;
}

function statsInfo(){
  return {
    ...stats,
    pollIntervalMs: cfg.pollIntervalMs,
    logPath: cfg.logPath,
    pendingCount: db.prepare(`SELECT COUNT(*) AS n FROM sent_alerts
      WHERE delivery_status NOT IN ('delivered','failed','undelivered','rejected','unknown','dry-run')
        AND next_check_at IS NOT NULL`).get().n
  };
}

function log(msg){
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  if (cfg && cfg.logPath){ try { fs.appendFileSync(cfg.logPath, line); } catch {} }
  console.log('[receipts]', msg);
}

module.exports = {
  init, stop, poll,
  summary, recent, statusMap, events, retry, statsInfo
};