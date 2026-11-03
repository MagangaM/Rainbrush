'use strict';

const fs   = require('node:fs');
const engine = require('./engine');

let db   = null;
let sms  = null;
let voice = null;
let ussd = null;
let cfg  = null;
let timer = null;
let running = false;
let lastRun = null;
let nextRun = null;

function init(options){
  db    = options.db;
  sms   = options.sms;
  voice = options.voice;
  ussd  = options.ussd;

  cfg = {
    enabled:       options.enabled,
    intervalHours: options.intervalHours,
    autoSend:      options.autoSend,
    allowSeedSend: options.allowSeedSend,
    logPath:       options.logPath,
    onCycle:       options.onCycle || (() => {}),
    notify:        options.notify || (() => {})
  };

  const row = db.prepare("SELECT v FROM settings WHERE k='scheduler_last_run'").get();
  if (row) lastRun = row.v;

  if (cfg.enabled){
    start();
  } else {
    log('scheduler disabled by config');
  }
}

function start(){
  if (timer) return;
  log('scheduler starting — interval ' + cfg.intervalHours + 'h, autoSend=' + cfg.autoSend);
  scheduleNext();
  setTimeout(() => runCycle('startup').catch(err => log('startup cycle error: ' + err.message)), 4000);
}

function stop(){
  if (timer){
    clearTimeout(timer);
    timer = null;
    nextRun = null;
    log('scheduler stopped');
  }
}

function restart(){
  stop();
  if (cfg.enabled) start();
}

function setIntervalHours(h){
  cfg.intervalHours = Math.max(1, Math.min(72, parseInt(h, 10) || 6));
  db.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES ('scheduler_interval_hours', ?)")
    .run(String(cfg.intervalHours));
  restart();
}

function setEnabled(on){
  cfg.enabled = !!on;
  db.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES ('scheduler_enabled', ?)")
    .run(cfg.enabled ? '1' : '0');
  if (cfg.enabled) start(); else stop();
}

function setAutoSend(on){
  cfg.autoSend = !!on;
  db.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES ('scheduler_auto_send', ?)")
    .run(cfg.autoSend ? '1' : '0');
  log('auto-send set to ' + cfg.autoSend);
}

function scheduleNext(){
  if (timer) clearTimeout(timer);
  const ms = cfg.intervalHours * 60 * 60 * 1000;
  nextRun = new Date(Date.now() + ms).toISOString();
  timer = setTimeout(() => {
    runCycle('scheduled')
      .catch(err => log('scheduled cycle error: ' + err.message))
      .finally(() => { if (cfg.enabled) scheduleNext(); });
  }, ms);
  if (timer.unref) timer.unref();
}

async function runCycle(trigger){
  if (running){
    log('cycle skipped — a run is already in progress');
    return { skipped: true, reason: 'already-running' };
  }
  if (trigger !== 'manual' && !cfg.enabled){
    return { skipped: true, reason: 'disabled' };
  }

  running = true;
  const startedAt = Date.now();
  log(`── cycle[${trigger}] starting ──`);

  try {
    /* ---- 1. Load farmers (respect the seed guard) ---- */
    const rows = db.prepare('SELECT * FROM farmers WHERE active = 1').all();

    const seedCount = rows.filter(r => r.is_seed === 1).length;
    const farmers = rows
      .filter(r => {
        if (r.is_seed === 1 && !cfg.allowSeedSend) return false;
        return true;
      })
      .map(r => ({
        id: r.id, name: r.name, phone: r.phone, loc: r.loc,
        crop: r.crop, planted: r.planted || '',
        lang: r.lang || 'en',
        channels: JSON.parse(r.channels || '["sms"]')
      }));

    if (seedCount && !cfg.allowSeedSend){
      log(`skipped ${seedCount} seed farmer${seedCount === 1 ? '' : 's'} (ALLOW_SEED_SEND is off)`);
    }

    if (!farmers.length){
      log('no sendable farmers — cycle finished with no work');
      await recordRun(trigger, startedAt, { farmers: 0, generated: 0, pending: 0, sent: 0 });
      return { generated: 0, pending: 0, sent: 0 };
    }

    /* ---- 2. Fetch forecasts ---- */
    const locs = [...new Set(farmers.map(f => f.loc))];
    const forecasts = {};

    await Promise.all(locs.map(async locName => {
      const meta = engine.LOCATIONS.find(l => l.name === locName);
      if (!meta){
        log(`unknown location "${locName}" — skipped`);
        return;
      }
      try {
        forecasts[locName] = await engine.fetchForecast(meta);
      } catch {
        forecasts[locName] = engine.simulateForecast(meta);
      }
    }));

    const live = Object.values(forecasts).filter(f => f.source === 'live').length;
    log(`fetched ${Object.keys(forecasts).length} forecasts (${live} live, ${Object.keys(forecasts).length - live} modelled)`);

    /* ---- 3. Generate alerts ---- */
    const alerts = engine.generateAlerts(farmers, forecasts);
    log(`generated ${alerts.length} alerts across ${farmers.length} farmers`);

    /* ---- 4. Deduplicate ---- */
    const sigStmt = db.prepare('SELECT 1 FROM sent_alerts WHERE signature = ? LIMIT 1');
    const pending = alerts.filter(a => !sigStmt.get(signatureFor(a)));
    log(`${pending.length} new since last run (${alerts.length - pending.length} already sent)`);

    /* ---- 5. Persist all alerts ---- */
    if (alerts.length){
      const insertAlert = db.prepare(`INSERT OR REPLACE INTO alerts
        (id,farmer_id,severity,title,body,lang,created_at) VALUES (?,?,?,?,?,?,?)`);
      const now = new Date().toISOString();
      const tx = db.transaction(list => {
        list.forEach(a => insertAlert.run(
          a.id, a.farmer.id, a.severity, a.title, a.text, a.farmer.lang || 'en', now
        ));
      });
      tx(alerts);
    }

    /* ---- 6. Dispatch ---- */
    let sent = 0;
    if (cfg.autoSend && pending.length){
      const smsJobs = [];
      const voiceJobs = [];
      pending.forEach(a => {
        const sig = signatureFor(a);
        if (a.farmer.channels.includes('sms')){
          smsJobs.push({ alert: a, to: a.farmer.phone, body: a.text, signature: sig });
        }
        if (a.farmer.channels.includes('voice')){
          voiceJobs.push({
            to: a.farmer.phone,
            text: a.voiceText || a.text,
            signature: sig,
            farmerId: a.farmer.id,
            alertId: a.id,
            clientRequestId: 'sched-' + a.farmer.id + '-' + a.day.date
          });
        }
      });

      /* -- SMS -- */
      if (smsJobs.length){
        log(`dispatching ${smsJobs.length} SMS jobs`);
        const result = await sms.sendBatch(smsJobs.map(j => ({ to: j.to, body: j.body })));

        const recordSent = db.prepare(`INSERT OR IGNORE INTO sent_alerts
          (signature, alert_id, farmer_id, rule_id, day_date, severity, channel, provider_sid)
          VALUES (?,?,?,?,?,?,?,?)`);

        const tx = db.transaction(() => {
          smsJobs.forEach((j, i) => {
            const r = result.results[i];
            if (r && r.ok){
              recordSent.run(
                j.signature,
                j.alert.id,
                j.alert.farmer.id,
                j.alert.rule.id,
                j.alert.day.date,
                j.alert.severity,
                'sms',
                r.sid || null
              );
              sent++;
            } else {
              log(`failed: ${j.alert.farmer.name} — ${r ? r.error : 'unknown'}`);
            }
          });
        });
        tx();

        log(`dispatched ${sent} of ${smsJobs.length} SMS successfully`);
      }

      /* -- Voice -- */
      if (voice && voiceJobs.length){
        const vInfo = voice.info();
        if (vInfo.configured){
          log(`dispatching ${voiceJobs.length} voice call${voiceJobs.length === 1 ? '' : 's'}`);
          const vResult = await voice.callBatch(voiceJobs);

          const insertCall = db.prepare(`INSERT INTO voice_calls
            (signature, farmer_id, alert_id, phone, text_spoken, session_id, status, raw_status, error)
            VALUES (?,?,?,?,?,?,?,?,?)`);
          const markSent = db.prepare(`INSERT OR IGNORE INTO sent_alerts
            (signature, alert_id, farmer_id, rule_id, day_date, severity, channel,
             provider, provider_sid, delivery_status, next_check_at, voice_session_id, voice_status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

          const vTx = db.transaction(() => {
            vResult.results.forEach((r, i) => {
              const job = voiceJobs[i];
              const initialStatus = vInfo.dryRun ? 'dry-run' : (r.ok ? 'queued' : 'failed');

              insertCall.run(
                job.signature, job.farmerId, job.alertId, job.to,
                job.text, r.sid || null, initialStatus, r.status || null, r.error || null
              );

              if (r.ok){
                const alert = pending.find(a => signatureFor(a) === job.signature);
                markSent.run(
                  job.signature,
                  job.alertId,
                  job.farmerId,
                  alert ? alert.rule.id : null,
                  alert ? alert.day.date : null,
                  alert ? alert.severity : 'info',
                  'voice',
                  'africastalking-voice',
                  r.sid || null,
                  vInfo.dryRun ? 'dry-run' : 'sent',
                  null,
                  r.sid || null,
                  initialStatus
                );
              }
            });
          });
          vTx();

          log(`dispatched ${vResult.dispatched} of ${voiceJobs.length} calls`);
        } else {
          log(`voice not configured — ${voiceJobs.length} call${voiceJobs.length === 1 ? '' : 's'} skipped`);
        }
      }

    } else if (pending.length && !cfg.autoSend){
      log(`${pending.length} alerts ready — auto-send is off, so nothing was dispatched`);
    }

    /* ---- 7. Prune ---- */
    pruneOldSignatures();

    /* ---- 8. Record run ---- */
    await recordRun(trigger, startedAt, {
      farmers: farmers.length,
      generated: alerts.length,
      pending: pending.length,
      sent
    });

    /* ---- 9. Notify UI + OS ---- */
    cfg.onCycle({
      trigger,
      farmers: farmers.length,
      generated: alerts.length,
      pending: pending.length,
      sent,
      finishedAt: new Date().toISOString(),
      liveForecasts: live,
      modelledForecasts: Object.keys(forecasts).length - live
    });

    if (sent > 0){
      cfg.notify({
        title: `Rainbrush — ${sent} alert${sent === 1 ? '' : 's'} sent`,
        body: `${pending.length} new this cycle. ${farmers.length} farmers watched.`,
        urgent: pending.some(a => a.severity === 'critical')
      });
    }

    /* ---- 10. Push to USSD relay ---- */
    if (ussd && ussd.enabled()){
      const farmersList = farmers.map(f => ({
        phone: f.phone, name: f.name, loc: f.loc, crop: f.crop, lang: f.lang
      }));
      const locationsList = engine.LOCATIONS;
      ussd.syncAll(forecasts, farmersList, locationsList)
        .then(r => log('USSD relay sync: ' + (r.ok ? 'ok' : 'partial') +
                       ' (' + locationsList.length + ' locations)'))
        .catch(err => log('USSD relay sync error: ' + err.message));
    }

    log(`── cycle[${trigger}] finished in ${Date.now() - startedAt}ms ──`);
    return { generated: alerts.length, pending: pending.length, sent };

  } catch (err){
    log('cycle error: ' + (err.stack || err.message || err));
    throw err;
  } finally {
    running = false;
  }
}

function signatureFor(alert){
  return alert.farmer.id + '|' + alert.rule.id + '|' + alert.day.date;
}

function pruneOldSignatures(){
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = db.prepare('DELETE FROM sent_alerts WHERE day_date < ?').run(cutoff);
  if (result.changes){
    log(`pruned ${result.changes} old signature${result.changes === 1 ? '' : 's'}`);
  }
}

async function recordRun(trigger, startedAt, stats){
  const finishedAt = new Date().toISOString();
  lastRun = finishedAt;

  db.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES ('scheduler_last_run', ?)")
    .run(finishedAt);
  db.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES ('scheduler_last_result', ?)")
    .run(JSON.stringify({
      trigger,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt,
      durationMs: Date.now() - startedAt,
      ...stats
    }));
}

function log(msg){
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  if (cfg && cfg.logPath){
    try { fs.appendFileSync(cfg.logPath, line, 'utf8'); } catch {}
  }
  console.log('[scheduler]', msg);
}

function status(){
  const lastResult = db.prepare("SELECT v FROM settings WHERE k='scheduler_last_result'").get();
  let parsed = null;
  if (lastResult){
    try { parsed = JSON.parse(lastResult.v); } catch {}
  }

  return {
    enabled:       cfg ? cfg.enabled : false,
    running,
    intervalHours: cfg ? cfg.intervalHours : 6,
    autoSend:      cfg ? cfg.autoSend : false,
    allowSeedSend: cfg ? cfg.allowSeedSend : false,
    lastRun:       lastRun,
    nextRun:       nextRun,
    lastResult:    parsed,
    logPath:       cfg ? cfg.logPath : null
  };
}

module.exports = {
  init, start, stop, restart,
  runCycle, status,
  setIntervalHours, setEnabled, setAutoSend,
  signatureFor
};