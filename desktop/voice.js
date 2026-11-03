'use strict';

const fs = require('node:fs');

/* ==================================================================
   Rainbrush — Voice dispatch via Africa's Talking
   Uses the Make Call API with inline callActions (Say). No callback
   URL required, which is what makes this viable from a desktop app.
   ================================================================== */

let cfg = null;
let callCount = 0;

function init(options){
  cfg = {
    apiKey:        options.apiKey || '',
    username:      options.username || 'sandbox',
    callerId:      options.callerId || '',
    sandbox:       options.sandbox || false,
    dryRun:        options.dryRun !== false,
    maxPerSecond:  Math.max(1, options.maxPerSecond || 2),
    logPath:       options.logPath,
    onCallResult:  options.onCallResult || (() => {})
  };

  if (!cfg.dryRun && !cfg.apiKey){
    throw new Error("Voice requires AT_API_KEY. Set SMS_DRY_RUN=1 to test without credentials.");
  }
  if (!cfg.dryRun && !cfg.callerId){
    throw new Error("Voice requires a virtual number in AT_CALLER_ID. Buy one in the AT dashboard under Voice > Phone Numbers.");
  }

  log('voice module initialized (dryRun=' + cfg.dryRun + ', sandbox=' + cfg.sandbox + ')');
}

async function callOne({ to, text, clientRequestId, voice }){
  if (!cfg) throw new Error('voice.init() not called');
  if (!to)  return { ok: false, error: 'no phone number' };
  if (!text) return { ok: false, error: 'no message text' };

  if (cfg.dryRun){
    log(`DRY RUN -> ${to}: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);
    return { ok: true, sid: 'VOICE-DRY-' + Date.now().toString(36), status: 'dry-run' };
  }

  const base = cfg.sandbox
    ? 'https://voice.sandbox.africastalking.com'
    : 'https://voice.africastalking.com';

  const body = new URLSearchParams();
  body.append('username', cfg.username);
  body.append('from', cfg.callerId);
  body.append('to', to);
  if (clientRequestId) body.append('clientRequestId', clientRequestId);

  body.append('callActions', JSON.stringify([
    {
      actionType: 'Say',
      text: text,
      voice: voice || 'woman',
      playBeep: 'false'
    }
  ]));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);

  try {
    const res = await fetch(base + '/call', {
      method: 'POST',
      headers: {
        'apiKey': cfg.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body,
      signal: ctrl.signal
    });
    clearTimeout(timer);

    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch {}

    if (!res.ok){
      const detail = (json && (json.errorMessage || json.message)) || raw.slice(0, 200);
      return { ok: false, error: `AT ${res.status}: ${detail}` };
    }

    const entry = json && json.entries && json.entries[0];
    if (!entry){
      return { ok: false, error: 'AT returned no call entry', raw: json };
    }

    const accepted = /Queued|Sent|Success|Dialing/i.test(entry.status || '');

    return {
      ok: accepted,
      sid: entry.sessionId || null,
      status: entry.status || 'queued',
      error: accepted ? null : (entry.status || 'unknown'),
      raw: entry
    };
  } catch (err){
    clearTimeout(timer);
    return { ok: false, error: (err.message || String(err)) };
  }
}

async function callBatch(jobs, onProgress){
  const gapMs = Math.round(1000 / cfg.maxPerSecond);
  const results = [];
  let dispatched = 0, failed = 0;

  for (let i = 0; i < jobs.length; i++){
    const job = jobs[i];
    const r = await callOne(job);
    results.push({ ...job, ...r });

    if (r.ok) dispatched++; else failed++;
    callCount++;

    if (onProgress){
      try { onProgress({ index: i, total: jobs.length, result: r, job }); }
      catch {}
    }

    if (i < jobs.length - 1){
      await new Promise(res => setTimeout(res, gapMs));
    }
  }

  return { attempted: jobs.length, dispatched, failed, results };
}

async function checkStatus(sessionId){
  if (!sessionId) return { status: 'unknown', raw: null, error: 'no session id' };
  if (cfg.dryRun) return { status: 'dry-run', raw: 'dry-run', error: null };

  const base = cfg.sandbox
    ? 'https://voice.sandbox.africastalking.com'
    : 'https://voice.africastalking.com';

  try {
    const url = base + '/services/status?sessionId=' + encodeURIComponent(sessionId);
    const res = await fetch(url, {
      headers: { 'apiKey': cfg.apiKey, 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error('AT ' + res.status);
    const j = await res.json();

    const raw = j.status || 'unknown';
    let status;
    if (/Completed|Answered|Success/i.test(raw)) status = 'answered';
    else if (/Failed|NoAnswer|Busy|Rejected|Cancelled/i.test(raw)) status = 'failed';
    else if (/Dialing|Queued|Sent/i.test(raw)) status = 'ringing';
    else status = 'unknown';

    return { status, raw, error: null };
  } catch (err){
    return { status: 'unknown', raw: null, error: err.message || String(err) };
  }
}

function estimateCost(text, country){
  const words = text.split(/\s+/).length;
  const seconds = Math.max(6, Math.round(words / 2.5));
  const rate = { '+254': 0.3, '+255': 0.25, '+234': 0.4, '+251': 0.35, '+250': 0.4, '+91': 0.15, '+265': 0.3, '+233': 0.35 };
  const perSec = rate[country] || 0.3;
  return { seconds, perSec, estimated: (seconds * perSec).toFixed(2), currency: 'USD' };
}

function info(){
  return {
    configured: !!(cfg && cfg.apiKey && cfg.callerId) || (cfg && cfg.dryRun),
    dryRun: cfg ? cfg.dryRun : true,
    sandbox: cfg ? cfg.sandbox : false,
    callerId: cfg ? cfg.callerId : null,
    maxPerSecond: cfg ? cfg.maxPerSecond : 2,
    callCount,
    logPath: cfg ? cfg.logPath : null
  };
}

function log(msg){
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  if (cfg && cfg.logPath){ try { fs.appendFileSync(cfg.logPath, line); } catch {} }
  console.log('[voice]', msg);
}

module.exports = { init, callOne, callBatch, checkStatus, estimateCost, info };