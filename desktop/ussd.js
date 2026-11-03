'use strict';

const fs = require('node:fs');

let cfg = null;
const stats = {
  lastPush: null,
  lastPull: null,
  lastError: null,
  pushCount: 0,
  pullCount: 0,
  pushErrors: 0,
  pullErrors: 0
};

function init(options){
  cfg = {
    relayUrl: (options.relayUrl || '').replace(/\/+$/, ''),
    secret:   options.secret || '',
    logPath:  options.logPath,
    enabled:  !!(options.relayUrl && options.secret)
  };
  if (cfg.enabled){
    log('USSD relay configured: ' + cfg.relayUrl);
  } else {
    log('USSD relay not configured — sync disabled');
  }
}

function enabled(){
  return cfg && cfg.enabled;
}

/* ------------------------------------------------------------------
   PUSH
------------------------------------------------------------------ */
async function pushLocations(locations){
  if (!enabled()) return { ok: false, error: 'not configured' };

  const list = locations.map(l => ({
    name:   l.name,
    region: l.region || '',
    lat:    l.lat,
    lon:    l.lon
  })).filter(l => l.name && Number.isFinite(l.lat) && Number.isFinite(l.lon));

  if (!list.length) return { ok: true, stored: 0 };

  try {
    const res = await fetch(cfg.relayUrl + '/sync/locations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Secret': cfg.secret
      },
      body: JSON.stringify(list)
    });
    if (!res.ok) throw new Error('relay responded ' + res.status);
    const j = await res.json();
    log(`pushed ${list.length} location(s), relay stored ${j.stored}`);
    return { ok: true, ...j };
  } catch (err){
    stats.lastError = err.message || String(err);
    stats.pushErrors++;
    log('location push failed: ' + stats.lastError);
    return { ok: false, error: stats.lastError };
  }
}

async function pushForecasts(forecasts){
  if (!enabled()) return { ok: false, error: 'not configured' };

  const list = Object.values(forecasts).filter(Boolean);
  if (!list.length) return { ok: true, stored: 0 };

  try {
    const res = await fetch(cfg.relayUrl + '/sync/forecasts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Secret': cfg.secret
      },
      body: JSON.stringify(list)
    });
    if (!res.ok) throw new Error('relay responded ' + res.status);
    const j = await res.json();
    stats.lastPush = new Date().toISOString();
    stats.pushCount++;
    log(`pushed ${list.length} forecast(s), relay stored ${j.stored}`);
    return { ok: true, ...j };
  } catch (err){
    stats.lastError = err.message || String(err);
    stats.pushErrors++;
    log('forecast push failed: ' + stats.lastError);
    return { ok: false, error: stats.lastError };
  }
}

async function pushFarmers(farmers){
  if (!enabled()) return { ok: false, error: 'not configured' };

  const list = farmers.map(f => ({
    phone: f.phone,
    name:  f.name,
    loc:   f.loc,
    crop:  f.crop,
    lang:  f.lang || 'en'
  }));

  try {
    const res = await fetch(cfg.relayUrl + '/sync/farmers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Secret': cfg.secret
      },
      body: JSON.stringify(list)
    });
    if (!res.ok) throw new Error('relay responded ' + res.status);
    const j = await res.json();
    log(`pushed ${list.length} farmer(s), relay stored ${j.stored}`);
    return { ok: true, ...j };
  } catch (err){
    stats.lastError = err.message || String(err);
    stats.pushErrors++;
    log('farmer push failed: ' + stats.lastError);
    return { ok: false, error: stats.lastError };
  }
}

async function syncAll(forecasts, farmers, locations){
  if (!enabled()) return { ok: false, error: 'not configured' };
  const [l, f1, f2] = await Promise.all([
    pushLocations(locations || []),
    pushForecasts(forecasts),
    pushFarmers(farmers)
  ]);
  return { ok: l.ok && f1.ok && f2.ok, locations: l, forecasts: f1, farmers: f2 };
}

/* ------------------------------------------------------------------
   PULL
------------------------------------------------------------------ */
async function pullSessions(limit){
  if (!enabled()) return { ok: false, error: 'not configured', sessions: [] };

  try {
    const url = cfg.relayUrl + '/sync/sessions?limit=' + (limit || 100);
    const res = await fetch(url, { headers: { 'X-Relay-Secret': cfg.secret } });
    if (!res.ok) throw new Error('relay responded ' + res.status);
    const j = await res.json();
    stats.lastPull = new Date().toISOString();
    stats.pullCount++;
    return { ok: true, sessions: j.sessions || [] };
  } catch (err){
    stats.lastError = err.message || String(err);
    stats.pullErrors++;
    log('session pull failed: ' + stats.lastError);
    return { ok: false, error: stats.lastError, sessions: [] };
  }
}

async function pullAnalytics(sinceIso){
  if (!enabled()) return { ok: false, error: 'not configured' };

  try {
    const url = cfg.relayUrl + '/sync/analytics'
      + (sinceIso ? '?since=' + encodeURIComponent(sinceIso) : '');
    const res = await fetch(url, { headers: { 'X-Relay-Secret': cfg.secret } });
    if (!res.ok) throw new Error('relay responded ' + res.status);
    return { ok: true, ...(await res.json()) };
  } catch (err){
    return { ok: false, error: err.message || String(err) };
  }
}

async function health(){
  if (!enabled()) return { ok: false, error: 'not configured' };
  try {
    const res = await fetch(cfg.relayUrl + '/health', { headers: { 'X-Relay-Secret': cfg.secret } });
    if (!res.ok) throw new Error('relay responded ' + res.status);
    return { ok: true, ...(await res.json()) };
  } catch (err){
    return { ok: false, error: err.message || String(err) };
  }
}

function info(){
  return {
    configured: enabled(),
    relayUrl: cfg ? cfg.relayUrl : null,
    ...stats,
    logPath: cfg ? cfg.logPath : null
  };
}

function log(msg){
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  if (cfg && cfg.logPath){ try { fs.appendFileSync(cfg.logPath, line); } catch {} }
  console.log('[ussd]', msg);
}

module.exports = { init, enabled, syncAll, pushLocations, pushForecasts, pushFarmers,
                   pullSessions, pullAnalytics, health, info };