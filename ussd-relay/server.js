'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const forecast = require('./forecast');

const PORT = parseInt(process.env.PORT || '8080', 10);
const RELAY_SECRET = process.env.RELAY_SECRET || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'relay.db');

if (!RELAY_SECRET){
  console.error('[relay] FATAL: RELAY_SECRET must be set. Shared secret authenticates the desktop app.');
  process.exit(1);
}

/* ==================================================================
   DATABASE
================================================================== */
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  -- Reference list + forecast cache. One row per location.
  -- Desktop pushes name/region/lat/lon on every sync.
  -- The refresher fills forecast_json on its cycle.
  CREATE TABLE IF NOT EXISTS locations (
    name          TEXT PRIMARY KEY,
    region        TEXT,
    lat           REAL,
    lon           REAL,
    forecast_json TEXT,
    last_sync_at  TEXT,
    updated_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_locations_sync ON locations(last_sync_at);

  -- Every USSD request AT sends us. One row per keystroke.
  CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    phone        TEXT NOT NULL,
    service_code TEXT,
    text_input   TEXT,
    last_menu    TEXT,
    response     TEXT,
    created_at   TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone);
  CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);

  -- Bridge queue for requests the desktop app needs to handle interactively.
  CREATE TABLE IF NOT EXISTS pending (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    phone        TEXT NOT NULL,
    text_input   TEXT,
    created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
    responded_at TEXT,
    response     TEXT
  );

  -- Farmers known to the relay. Pushed from the desktop app so we can
  -- greet them by name and tailor advice to their crop.
  CREATE TABLE IF NOT EXISTS farmers (
    phone      TEXT PRIMARY KEY,
    name       TEXT,
    loc        TEXT,
    crop       TEXT,
    lang       TEXT DEFAULT 'en',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
`);

/* ---- Migration: add reference columns to locations ---- */
const locCols = db.prepare('PRAGMA table_info(locations)').all();
const addLocCol = (name, def) => {
  if (!locCols.find(c => c.name === name)){
    db.exec(`ALTER TABLE locations ADD COLUMN ${name} ${def}`);
  }
};
addLocCol('lat',          'REAL');
addLocCol('lon',          'REAL');
addLocCol('last_sync_at', 'TEXT');
console.log('[relay] locations schema ready');

/* ---- Convenience seed ----
   If the relay boots with no locations and a farmer dials in before
   the desktop has ever synced, we still want coordinates to work with.
   The desktop will overwrite these on its first push. */
const SEED_LOCATIONS = [
  { name:'Nakuru',   region:'Kenya',    lat:-0.3031, lon:36.0800 },
  { name:'Kisumu',   region:'Kenya',    lat:-0.0917, lon:34.7680 },
  { name:'Meru',     region:'Kenya',    lat: 0.0500, lon:37.6500 },
  { name:'Dodoma',   region:'Tanzania', lat:-6.1630, lon:35.7516 },
  { name:'Mbeya',    region:'Tanzania', lat:-8.9000, lon:33.4600 },
  { name:'Kano',     region:'Nigeria',  lat:12.0022, lon: 8.5920 },
  { name:'Ibadan',   region:'Nigeria',  lat: 7.3775, lon: 3.9470 },
  { name:'Adama',    region:'Ethiopia', lat: 8.5400, lon:39.2700 },
  { name:'Hawassa',  region:'Ethiopia', lat: 7.0621, lon:38.4763 },
  { name:'Musanze',  region:'Rwanda',   lat:-1.4998, lon:29.6347 },
  { name:'Nashik',   region:'India',    lat:19.9975, lon:73.7898 },
  { name:'Patna',    region:'India',    lat:25.5941, lon:85.1376 },
  { name:'Lilongwe', region:'Malawi',   lat:-13.9626,lon:33.7741 },
  { name:'Tamale',   region:'Ghana',    lat: 9.4008, lon:-0.8393 }
];

const locationCount = db.prepare('SELECT COUNT(*) AS n FROM locations').get().n;
if (locationCount === 0){
  const seed = db.prepare(`INSERT INTO locations
    (name, region, lat, lon, last_sync_at) VALUES (?,?,?,?,?)`);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    SEED_LOCATIONS.forEach(l => seed.run(l.name, l.region, l.lat, l.lon, now));
  });
  tx();
  console.log('[relay] seeded ' + SEED_LOCATIONS.length + ' locations');
}

/* ==================================================================
   FORECAST REFRESHER
================================================================== */
const REFRESH_INTERVAL_MS = parseInt(
  process.env.REFRESH_INTERVAL_MS || String(3 * 60 * 60 * 1000),
  10
);
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

let refreshTimer = null;
let refreshInFlight = false;

async function refreshOne(locationName, days){
  const meta = getKnownLocation(locationName);
  if (!meta){
    console.warn('[refresher] unknown location: ' + locationName);
    return null;
  }
  if (!Number.isFinite(meta.lat) || !Number.isFinite(meta.lon)){
    console.warn('[refresher] no coordinates for: ' + locationName);
    return null;
  }

  const fc = await forecast.getForecast({
    name: meta.name,
    region: meta.region || '',
    lat: meta.lat,
    lon: meta.lon,
    days: days || 7
  });

  db.prepare(`UPDATE locations SET
      region = ?, forecast_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE name = ?`)
    .run(fc.region || '', JSON.stringify(fc), fc.location);

  return fc;
}

async function refreshAll(){
  if (refreshInFlight){
    console.log('[refresher] cycle already running, skipping');
    return { skipped: true };
  }
  refreshInFlight = true;
  const started = Date.now();

  try {
    const locs = db.prepare(`
      SELECT DISTINCT l.name
      FROM locations l
      INNER JOIN farmers f ON f.loc = l.name
      WHERE l.lat IS NOT NULL AND l.lon IS NOT NULL
    `).all().map(r => r.name);

    if (!locs.length){
      console.log('[refresher] no farmer locations to refresh');
      return { refreshed: 0, skipped: 0 };
    }

    console.log('[refresher] fetching ' + locs.length + ' location(s)');

    let refreshed = 0, failed = 0;
    for (const name of locs){
      try {
        await refreshOne(name);
        refreshed++;
      } catch (err){
        failed++;
        console.error('[refresher] ' + name + ' failed: ' + err.message);
      }
      await new Promise(r => setTimeout(r, 150));
    }

    pruneStale();

    const ms = Date.now() - started;
    console.log('[refresher] done in ' + ms + 'ms (' + refreshed + ' ok, ' + failed + ' failed)');
    return { refreshed, failed, ms };

  } finally {
    refreshInFlight = false;
  }
}

function pruneStale(){
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const stale = db.prepare(
    "DELETE FROM locations WHERE updated_at < ? AND name NOT IN (SELECT DISTINCT loc FROM farmers)"
  ).run(cutoff);
  if (stale.changes){
    console.log('[refresher] pruned ' + stale.changes + ' stale forecast row(s)');
  }

  const refCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const refs = db.prepare(
    `DELETE FROM locations
     WHERE last_sync_at IS NOT NULL
       AND last_sync_at < ?
       AND name NOT IN (SELECT DISTINCT loc FROM farmers)
       AND name NOT IN (SELECT DISTINCT loc FROM pending WHERE loc IS NOT NULL)`
  ).run(refCutoff);
  if (refs.changes){
    console.log('[refresher] pruned ' + refs.changes + ' stale location reference(s)');
  }
}

function startRefresher(){
  setTimeout(() => {
    refreshAll().catch(err => console.error('[refresher] boot cycle error:', err));
  }, 3000);

  refreshTimer = setInterval(() => {
    refreshAll().catch(err => console.error('[refresher] cycle error:', err));
  }, REFRESH_INTERVAL_MS);

  console.log('[refresher] scheduled every ' + Math.round(REFRESH_INTERVAL_MS / 60000) + ' min');
}

function stopRefresher(){
  if (refreshTimer){ clearInterval(refreshTimer); refreshTimer = null; }
}

/* ==================================================================
   HELPERS
================================================================== */
function checkSecret(req, res, next){
  const provided = req.headers['x-relay-secret'] || req.query.secret;
  if (provided !== RELAY_SECRET){
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function getFarmer(phone){
  return db.prepare('SELECT * FROM farmers WHERE phone = ?').get(phone) || null;
}

function getKnownLocation(name){
  return db.prepare(
    'SELECT name, region, lat, lon FROM locations WHERE name = ?'
  ).get(name) || null;
}

function getCachedForecast(name){
  const row = db.prepare(
    'SELECT forecast_json FROM locations WHERE name = ?'
  ).get(name);
  if (!row || !row.forecast_json) return null;
  try { return JSON.parse(row.forecast_json); }
  catch { return null; }
}

async function ensureForecast(locationName){
  const row = db.prepare(
    'SELECT forecast_json, updated_at, lat, lon FROM locations WHERE name = ?'
  ).get(locationName);

  if (!row){
    console.warn('[on-demand] unknown location: ' + locationName);
    return null;
  }

  const ageMs = row.updated_at
    ? Date.now() - new Date(row.updated_at).getTime()
    : Infinity;

  if (row.forecast_json && ageMs < STALE_AFTER_MS){
    try { return JSON.parse(row.forecast_json); }
    catch { /* fall through */ }
  }

  try {
    const fc = await refreshOne(locationName);
    if (fc) return fc;
  } catch (err){
    console.error('[on-demand] fetch failed for ' + locationName + ': ' + err.message);
  }

  if (row.forecast_json){
    try { return JSON.parse(row.forecast_json); }
    catch { /* fall through */ }
  }

  if (Number.isFinite(row.lat) && Number.isFinite(row.lon)){
    return forecast.simulateForecast({
      name: locationName,
      region: '',
      lat: row.lat,
      days: 7
    });
  }

  return null;
}

function summariseDay(day){
  const lines = [];
  lines.push(`${day.dow}: ${day.tmax}C day, ${day.tmin}C night`);
  if (day.rain >= 45)      lines.push(`Heavy rain ${day.rain}mm`);
  else if (day.rain >= 10) lines.push(`Rain ${day.rain}mm`);
  else if (day.rain >= 1)  lines.push(`Light rain ${day.rain}mm`);
  else                     lines.push(`No rain`);
  if (day.wind >= 40) lines.push(`Strong wind ${day.wind}km/h`);
  return lines.join('. ');
}

function cropAdvice(farmer, fc){
  if (!fc || !farmer) return 'No forecast available for your area yet.';
  const crop = (farmer.crop || 'your crop').toLowerCase();
  const today = fc.days[0];
  const lines = [];
  if (today.rain >= 45) lines.push(`Heavy rain today. Do not spray or apply fertiliser to ${crop}.`);
  else if (today.rain >= 10) lines.push(`Good rain today. A fine day to top-dress ${crop} after it passes.`);
  else if (today.rain < 1) lines.push(`Dry today. Check soil before working ${crop}.`);
  if (today.tmax >= 37) lines.push(`Heat stress. Irrigate early morning or evening only.`);
  if (today.tmin <= 3)  lines.push(`Frost risk tonight. Cover young ${crop}.`);
  if (!lines.length) lines.push(`Conditions steady. Good day for routine work on ${crop}.`);
  return lines.join(' ');
}

/* ==================================================================
   THE MENU TREE
================================================================== */
const MENU = {

  main(session, farmer, fc){
    const name = farmer && farmer.name ? farmer.name.split(' ')[0] : 'farmer';
    const loc  = farmer && farmer.loc ? farmer.loc : 'your area';
    return [
      `CON Rainbrush - ${loc}`,
      `Hello ${name}. Choose:`,
      `1. Weather today`,
      `2. 7-day outlook`,
      `3. My crop advice`,
      `4. Register or update`,
      `5. Talk to an agent`
    ].join('\n');
  },

  today(session, farmer, fc){
    if (!fc) return 'END No forecast data yet for your location. Please try again later.';
    return 'END ' + summariseDay(fc.days[0]);
  },

  outlook(session, farmer, fc){
    if (!fc) return 'END No forecast data yet for your location.';
    const lines = ['END 7-day outlook:'];
    fc.days.forEach(d => {
      const rain = d.rain >= 10 ? `${d.rain}mm` : (d.rain >= 1 ? 'light' : '-');
      lines.push(`${d.dow} ${d.tmax}/${d.tmin}C ${rain}`);
    });
    lines.push('Rain in mm. Dial again to start.');
    return lines.join('\n');
  },

  advice(session, farmer, fc){
    if (!farmer) return 'END Register first. Dial again and choose option 4.';
    return 'END ' + cropAdvice(farmer, fc);
  },

  register(session, farmer, fc){
    if (farmer){
      return `CON You are registered as ${farmer.name} (${farmer.crop || 'no crop'}) in ${farmer.loc || 'no location'}.\n1. Change crop\n2. Change location\n3. Cancel`;
    }
    return 'CON To register, please use the Rainbrush app or ask your extension officer.';
  },

  registerCrop(session, farmer, fc){
    return [
      'CON Which is your main crop?',
      '1. Maize',
      '2. Beans',
      '3. Rice',
      '4. Tomato',
      '5. Other'
    ].join('\n');
  },

  registerCropSave(session, farmer, fc, input){
    const map = { '1':'Maize', '2':'Beans', '3':'Rice', '4':'Tomato', '5':'Other' };
    const crop = map[input] || 'Other';
    if (farmer){
      db.prepare('UPDATE farmers SET crop = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?')
        .run(crop, session.phone);
    } else {
      db.prepare(`INSERT INTO farmers (phone, crop, lang, updated_at)
        VALUES (?, ?, 'en', CURRENT_TIMESTAMP)
        ON CONFLICT(phone) DO UPDATE SET crop = excluded.crop, updated_at = CURRENT_TIMESTAMP`)
        .run(session.phone, crop);
    }
    return `END Crop set to ${crop}. You will receive alerts for this crop.`;
  },

  agent(session, farmer, fc){
    const ticket = 'RB' + Date.now().toString(36).toUpperCase().slice(-6);
    db.prepare(`INSERT INTO pending (session_id, phone, text_input, response)
                VALUES (?, ?, 'agent-request', ?)`)
      .run(session.sessionId, session.phone, ticket);
    return `END Request received. Your reference is ${ticket}. An extension officer will call you back within 24 hours.`;
  }
};

/* ==================================================================
   EXPRESS
================================================================== */
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '2mb' }));

/* ---- AT webhook ---- */
app.post('/ussd', async (req, res) => {
  const started = Date.now();

  const sessionId = String(req.body.sessionId || '');
  const phone     = String(req.body.phoneNumber || '').replace(/\s+/g, '');
  const service   = String(req.body.serviceCode || '');
  const text      = String(req.body.text || '');

  if (!sessionId || !phone){
    return res.type('text/plain').send('END Bad request.');
  }

  const farmer = getFarmer(phone);
  let fc = null;
  if (farmer && farmer.loc){
    try {
      fc = await ensureForecast(farmer.loc);
    } catch (err){
      console.error('[ussd] forecast fetch failed:', err.message);
      fc = null;
    }
  }

  const parts = text.split('*').filter(Boolean);
  const last  = parts.length ? parts[parts.length - 1] : '';
  const depth = parts.length;

  let response;
  let lastMenu = 'main';

  try {
    if (depth === 0){
      lastMenu = 'main';
      response = MENU.main({ sessionId, phone }, farmer, fc);
    }
    else if (depth === 1){
      switch (last){
        case '1': lastMenu = 'today';    response = MENU.today({ sessionId, phone }, farmer, fc); break;
        case '2': lastMenu = 'outlook';  response = MENU.outlook({ sessionId, phone }, farmer, fc); break;
        case '3': lastMenu = 'advice';   response = MENU.advice({ sessionId, phone }, farmer, fc); break;
        case '4': lastMenu = 'register'; response = MENU.register({ sessionId, phone }, farmer, fc); break;
        case '5': lastMenu = 'agent';    response = MENU.agent({ sessionId, phone }, farmer, fc); break;
        default:  lastMenu = 'main';     response = 'END Invalid choice. Please dial again.';
      }
    }
    else if (depth === 2){
      if (parts[0] === '4'){
        if (last === '1'){ lastMenu = 'registerCrop'; response = MENU.registerCrop({ sessionId, phone }, farmer, fc); }
        else if (last === '2'){ lastMenu = 'registerLocation'; response = 'END Location change is handled by your extension officer.'; }
        else { lastMenu = 'register'; response = 'END Cancelled.'; }
      } else {
        response = 'END Session ended.';
      }
    }
    else if (depth === 3){
      if (parts[0] === '4' && parts[1] === '1'){
        lastMenu = 'registerCropSave';
        response = MENU.registerCropSave({ sessionId, phone }, farmer, fc, last);
      } else {
        response = 'END Session ended.';
      }
    }
    else {
      response = 'END Session ended. Please dial again to start.';
    }
  } catch (err){
    console.error('[relay] menu error:', err);
    response = 'END Sorry, something went wrong. Please try again.';
  }

  try {
    db.prepare(`INSERT INTO sessions (session_id, phone, service_code, text_input, last_menu, response)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, phone, service, text, lastMenu, response);
  } catch (e){ console.error('[relay] log error:', e); }

  const elapsed = Date.now() - started;
  const src = fc ? (fc.source === 'live' ? 'live' : (fc.source === 'sim' ? 'sim' : 'cache')) : 'none';
  console.log(`[relay] ${phone} depth=${depth} menu=${lastMenu} src=${src} in ${elapsed}ms`);

  res.type('text/plain').send(response);
});

/* ---- AT event URL ---- */
app.post('/ussd/events', (req, res) => {
  try {
    const body = req.body || {};
    console.log('[relay] event:', JSON.stringify(body).slice(0, 240));
    db.prepare(`INSERT INTO settings (k, v) VALUES ('last_event', ?)
                ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
      .run(JSON.stringify({ ...body, receivedAt: new Date().toISOString() }));
  } catch (e){ console.error('[relay] event log error:', e); }
  res.status(200).json({ ok: true });
});

/* ---- Sync routes (authenticated) ---- */
app.post('/sync/locations', checkSecret, (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  if (!list.length) return res.json({ ok: true, stored: 0 });

  const stmt = db.prepare(`INSERT INTO locations
    (name, region, lat, lon, last_sync_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      region       = excluded.region,
      lat          = excluded.lat,
      lon          = excluded.lon,
      last_sync_at = excluded.last_sync_at`);

  const now = new Date().toISOString();
  let stored = 0;

  const tx = db.transaction(() => {
    list.forEach(l => {
      if (!l.name) return;
      const lat = Number(l.lat);
      const lon = Number(l.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      stmt.run(l.name, l.region || '', lat, lon, now);
      stored++;
    });
  });
  tx();

  console.log('[relay] sync: ' + stored + ' location(s) stored');
  res.json({ ok: true, stored });
});

app.post('/sync/forecasts', checkSecret, (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  if (!list.length) return res.json({ ok: true, stored: 0 });

  const stmt = db.prepare(`UPDATE locations
    SET region = ?, forecast_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE name = ?`);

  let stored = 0;
  const tx = db.transaction(() => {
    list.forEach(f => {
      if (!f || !f.location) return;
      const r = stmt.run(f.region || '', JSON.stringify(f), f.location);
      if (r.changes) stored++;
    });
  });
  tx();

  console.log('[relay] sync: ' + stored + ' forecast(s) stored');
  res.json({ ok: true, stored });
});

app.post('/sync/farmers', checkSecret, (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  if (!list.length) return res.json({ ok: true, stored: 0 });

  const stmt = db.prepare(`INSERT INTO farmers (phone, name, loc, crop, lang, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(phone) DO UPDATE SET
      name = excluded.name,
      loc = excluded.loc,
      crop = excluded.crop,
      lang = excluded.lang,
      updated_at = CURRENT_TIMESTAMP`);

  const tx = db.transaction(() => {
    list.forEach(f => stmt.run(f.phone, f.name || '', f.loc || '', f.crop || '', f.lang || 'en'));
  });
  tx();

  console.log('[relay] sync: ' + list.length + ' farmer(s) stored');
  res.json({ ok: true, stored: list.length });
});

app.get('/sync/sessions', checkSecret, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const rows = db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?`).all(limit);
  res.json({ sessions: rows });
});

app.get('/sync/analytics', checkSecret, (req, res) => {
  const since = req.query.since || new Date(Date.now() - 7 * 86400000).toISOString();
  const totals = db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT phone) AS farmers
    FROM sessions WHERE created_at >= ?`).get(since);
  const byMenu = db.prepare(`SELECT last_menu, COUNT(*) AS n FROM sessions
    WHERE created_at >= ? GROUP BY last_menu ORDER BY n DESC`).all(since);
  const byDay = db.prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
    FROM sessions WHERE created_at >= ? GROUP BY day ORDER BY day`).all(since);
  res.json({ since, totals, byMenu, byDay });
});

app.get('/sync/sources', checkSecret, (req, res) => {
  const rows = db.prepare(`
    SELECT name, region, lat, lon, forecast_json, updated_at, last_sync_at
    FROM locations ORDER BY name
  `).all();

  const out = rows.map(r => {
    let source = 'unknown';
    let fetchedAt = null;
    if (r.forecast_json){
      try {
        const fc = JSON.parse(r.forecast_json);
        source = fc.source || 'unknown';
        fetchedAt = fc.fetchedAt || null;
      } catch {}
    }
    const now = Date.now();
    return {
      name: r.name,
      region: r.region,
      lat: r.lat,
      lon: r.lon,
      source,
      fetchedAt,
      storedAt: r.updated_at,
      lastSyncedAt: r.last_sync_at,
      ageMinutes: r.updated_at
        ? Math.round((now - new Date(r.updated_at).getTime()) / 60000)
        : null,
      syncedMinutesAgo: r.last_sync_at
        ? Math.round((now - new Date(r.last_sync_at).getTime()) / 60000)
        : null
    };
  });

  res.json({ locations: out, count: out.length });
});

app.post('/sync/refresh', checkSecret, async (req, res) => {
  try {
    const r = await refreshAll();
    res.json({ ok: true, ...r });
  } catch (err){
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get('/health', (req, res) => {
  const counts = {
    locations: db.prepare('SELECT COUNT(*) AS n FROM locations').get().n,
    farmers:   db.prepare('SELECT COUNT(*) AS n FROM farmers').get().n,
    sessions:  db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
  };
  res.json({ ok: true, uptime: process.uptime(), counts });
});

/* ==================================================================
   GO
================================================================== */
const server = app.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`);
  console.log(`[relay] webhook: POST /ussd`);
  console.log(`[relay] events:  POST /ussd/events`);
  console.log(`[relay] sync:    /sync/{locations,forecasts,farmers,sessions,analytics,sources,refresh}`);

  startRefresher();
});

function shutdown(signal){
  console.log('[relay] received ' + signal + ', shutting down');
  stopRefresher();
  server.close(() => {
    console.log('[relay] closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));