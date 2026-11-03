'use strict';

const fs   = require('node:fs');
const path = require('node:path');

/* ------------------------------------------------------------------
   ENV LOADER — parses .env without any external dependency
------------------------------------------------------------------ */
function loadEnv(){
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]){
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  });
}
loadEnv();

const CONFIG = {
  provider:     (process.env.SMS_PROVIDER || 'africastalking').toLowerCase(),
  dryRun:       process.env.SMS_DRY_RUN === '1',
  maxPerSecond: Math.max(1, parseInt(process.env.SMS_MAX_PER_SECOND || '5', 10)),

  twilio: {
    accountSid:          process.env.TWILIO_ACCOUNT_SID || '',
    authToken:           process.env.TWILIO_AUTH_TOKEN || '',
    from:                process.env.TWILIO_FROM || '',
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || ''
  },

  at: {
    apiKey:   process.env.AT_API_KEY || '',
    username: process.env.AT_USERNAME || 'sandbox',
    senderId: process.env.AT_SENDER_ID || undefined,
    enqueue:  process.env.AT_ENQUEUE === '1'
  }
};

/* ------------------------------------------------------------------
   LAZY CLIENTS
------------------------------------------------------------------ */
let twilioClient = null;
let atSmsClient  = null;

function getTwilio(){
  if (twilioClient) return twilioClient;
  if (!CONFIG.twilio.accountSid || !CONFIG.twilio.authToken){
    throw new Error('Twilio credentials missing (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).');
  }
  twilioClient = require('twilio')(CONFIG.twilio.accountSid, CONFIG.twilio.authToken);
  return twilioClient;
}

function getAT(){
  if (atSmsClient) return atSmsClient;
  if (!CONFIG.at.apiKey){
    throw new Error("Africa's Talking API key missing (AT_API_KEY).");
  }
  const at = require('africastalking')({
    apiKey:   CONFIG.at.apiKey,
    username: CONFIG.at.username
  });
  atSmsClient = at.SMS;
  return atSmsClient;
}

/* ------------------------------------------------------------------
   PHONE NORMALIZATION → E.164
------------------------------------------------------------------ */
function normalizePhone(raw, defaultCountry = '+254'){
  if (!raw) return null;
  let p = String(raw).replace(/[\s\-().]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (p.startsWith('+'))  return p;
  if (p.startsWith('0'))  return defaultCountry + p.slice(1);
  if (/^\d{9,}$/.test(p)) return defaultCountry + p;
  return p;
}

/* ------------------------------------------------------------------
   DRY-RUN LOG
------------------------------------------------------------------ */
let logPath = null;
function logPathFor(userData){
  logPath = path.join(userData, 'sms.log');
  return logPath;
}
function logDryRun(entry){
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, JSON.stringify({
      ts: new Date().toISOString(), ...entry
    }) + '\n', 'utf8');
  } catch {}
}

/* ------------------------------------------------------------------
   PROVIDERS
------------------------------------------------------------------ */
async function sendTwilio({ to, body }){
  const client  = getTwilio();
  const payload = { to, body };

  if (CONFIG.twilio.messagingServiceSid){
    payload.messagingServiceSid = CONFIG.twilio.messagingServiceSid;
  } else {
    payload.from = CONFIG.twilio.from;
  }
  const msg = await client.messages.create(payload);
  return { ok: true, sid: msg.sid, status: msg.status };
}

async function sendAT({ to, body, senderId }){
  const sms  = getAT();
  const opts = {
    to: [to],
    message: body,
    enqueue: CONFIG.at.enqueue
  };
  const sid = senderId || CONFIG.at.senderId;
  if (sid) opts.senderId = sid;

  const res = await sms.send(opts);
  const rec = res && res.SMSMessageData && res.SMSMessageData.Recipients
    ? res.SMSMessageData.Recipients[0]
    : null;
  if (rec && /success/i.test(rec.status || '')){
    return { ok: true, sid: rec.messageId, status: rec.status };
  }
  return { ok: false, error: (rec && rec.status) || 'unknown failure' };
}

/* ------------------------------------------------------------------
   PUBLIC — send one
------------------------------------------------------------------ */
async function sendOne({ to, body, senderId, countryHint }){
  const phone = normalizePhone(to, countryHint || '+254');
  if (!phone) return { ok: false, error: 'invalid phone number' };

  if (CONFIG.dryRun){
    logDryRun({ provider: 'dry-run', to: phone, body });
    await new Promise(r => setTimeout(r, 40));
    return { ok: true, sid: 'DRY-' + Date.now().toString(36), status: 'dry-run' };
  }

  try {
    if (CONFIG.provider === 'twilio'){
      return await sendTwilio({ to: phone, body });
    }
    return await sendAT({ to: phone, body, senderId });
  } catch (err){
    return { ok: false, error: err.message || String(err) };
  }
}

/* ------------------------------------------------------------------
   PUBLIC — send many at throttle
------------------------------------------------------------------ */
async function sendBatch(jobs, onProgress){
  const gapMs   = Math.round(1000 / CONFIG.maxPerSecond);
  const results = [];
  let delivered = 0, failed = 0;

  for (let i = 0; i < jobs.length; i++){
    const job = jobs[i];
    const r   = await sendOne(job);
    results.push({ ...job, ...r });

    if (r.ok) delivered++; else failed++;

    if (onProgress){
      try { onProgress({ index: i, total: jobs.length, result: r, job }); }
      catch {}
    }

    if (i < jobs.length - 1){
      await new Promise(res => setTimeout(res, gapMs));
    }
  }

  return { attempted: jobs.length, delivered, failed, results };
}

/* ------------------------------------------------------------------
   STATUS CHECK — for delivery receipts
------------------------------------------------------------------ */
function normalizeTwilioStatus(msg){
  const raw = msg.status || 'unknown';
  let status;
  switch (raw){
    case 'delivered':   status = 'delivered';   break;
    case 'undelivered': status = 'undelivered'; break;
    case 'failed':      status = 'failed';      break;
    case 'sent':        status = 'sent';        break;
    case 'sending':     status = 'sent';        break;
    case 'accepted':    status = 'sent';        break;
    case 'queued':      status = 'queued';      break;
    default:            status = 'pending';
  }
  return {
    status, raw,
    error: msg.errorMessage || (msg.errorCode ? 'code ' + msg.errorCode : null)
  };
}

function normalizeATStatus(msg){
  const raw = msg.status || 'unknown';
  let status;
  switch (raw){
    case 'Success':    status = 'delivered'; break;
    case 'Sent':       status = 'sent';      break;
    case 'Submitted':  status = 'sent';      break;
    case 'Buffered':   status = 'queued';    break;
    case 'Rejected':   status = 'rejected';  break;
    case 'Failed':     status = 'failed';    break;
    case 'InsufficientBalance': status = 'failed'; break;
    default:           status = 'pending';
  }
  return {
    status, raw,
    error: msg.failureReason && msg.failureReason !== 'None' ? msg.failureReason : null
  };
}

async function checkStatus(sid){
  if (!sid) return { status: 'unknown', raw: null, error: 'no sid' };
  if (CONFIG.dryRun) return { status: 'dry-run', raw: 'dry-run', error: null };

  if (CONFIG.provider === 'twilio'){
    const client = getTwilio();
    const msg = await client.messages(sid).fetch();
    return normalizeTwilioStatus(msg);
  }

  if (CONFIG.provider === 'africastalking'){
    const apiKey = CONFIG.at.apiKey;
    const username = CONFIG.at.username || 'sandbox';
    if (!apiKey) throw new Error("Africa's Talking API key missing");

    const url = 'https://api.africastalking.com/version1/messaging'
      + '?username=' + encodeURIComponent(username)
      + '&messageId=' + encodeURIComponent(sid);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      headers: { 'apiKey': apiKey, 'Accept': 'application/json' },
      signal: ctrl.signal
    });
    clearTimeout(t);

    if (!res.ok) throw new Error('AT responded ' + res.status);

    const j = await res.json();
    const msg = j && j.SMSMessageData && j.SMSMessageData.Messages
      ? j.SMSMessageData.Messages[0]
      : null;
    if (!msg) return { status: 'unknown', raw: 'not-found', error: 'Message not found' };
    return normalizeATStatus(msg);
  }

  return { status: 'unknown', raw: null, error: 'unknown provider' };
}

function info(){
  return {
    provider:     CONFIG.provider,
    dryRun:       CONFIG.dryRun,
    maxPerSecond: CONFIG.maxPerSecond,
    configured:   CONFIG.provider === 'twilio'
      ? Boolean(CONFIG.twilio.accountSid && (CONFIG.twilio.from || CONFIG.twilio.messagingServiceSid))
      : Boolean(CONFIG.at.apiKey),
    logPath
  };
}

module.exports = { sendOne, sendBatch, checkStatus, info, normalizePhone, logPathFor };