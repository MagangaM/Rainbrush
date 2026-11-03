'use strict';

const { app, BrowserWindow, ipcMain, Notification, Tray, Menu,
        shell, dialog, nativeTheme } = require('electron');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
const Database = require('better-sqlite3');

const engine    = require('./engine');
const sms       = require('./sms');
const voice     = require('./voice');
const receipts  = require('./receipts');
const ussd      = require('./ussd');
const scheduler = require('./scheduler');

let win  = null;
let tray = null;
let db   = null;
let isQuitting = false;

const isWin11 = process.platform === 'win32'
  && Number(os.release().split('.')[2] || 0) >= 22000;

/* ==================================================================
   DATABASE
================================================================== */
function initDB(){
  const dir = app.getPath('userData');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(path.join(dir, 'rainbrush.db'));
  db.pragma('journal_mode = WAL');

  sms.logPathFor(dir);

  db.exec(`
    CREATE TABLE IF NOT EXISTS farmers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      phone       TEXT NOT NULL,
      loc         TEXT NOT NULL,
      crop        TEXT NOT NULL,
      planted     TEXT,
      lang        TEXT DEFAULT 'en',
      channels    TEXT DEFAULT '["sms"]',
      active      INTEGER DEFAULT 1,
      is_seed     INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id          TEXT PRIMARY KEY,
      farmer_id   TEXT NOT NULL,
      severity    TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      lang        TEXT,
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
      delivered   INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      k TEXT PRIMARY KEY,
      v TEXT
    );

    CREATE TABLE IF NOT EXISTS stats (
      k TEXT PRIMARY KEY,
      v INTEGER DEFAULT 0
    );

    INSERT OR IGNORE INTO stats (k, v) VALUES ('sent', 0), ('attempted', 0);

    CREATE TABLE IF NOT EXISTS sent_alerts (
      signature   TEXT PRIMARY KEY,
      alert_id    TEXT NOT NULL,
      farmer_id   TEXT NOT NULL,
      rule_id     TEXT NOT NULL,
      day_date    TEXT NOT NULL,
      severity    TEXT NOT NULL,
      channel     TEXT NOT NULL,
      sent_at     TEXT DEFAULT CURRENT_TIMESTAMP,
      provider_sid TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sent_farmer ON sent_alerts(farmer_id);
    CREATE INDEX IF NOT EXISTS idx_sent_date   ON sent_alerts(day_date);

    CREATE TABLE IF NOT EXISTS delivery_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      signature    TEXT NOT NULL,
      status       TEXT NOT NULL,
      raw_status   TEXT,
      error        TEXT,
      provider     TEXT,
      recorded_at  TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_events_sig ON delivery_events(signature);

    CREATE TABLE IF NOT EXISTS voice_calls (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      signature    TEXT NOT NULL,
      farmer_id    TEXT NOT NULL,
      alert_id     TEXT,
      phone        TEXT NOT NULL,
      text_spoken  TEXT,
      session_id   TEXT,
      status       TEXT DEFAULT 'queued',
      raw_status   TEXT,
      error        TEXT,
      duration_sec INTEGER,
      cost         REAL,
      currency     TEXT,
      dispatched_at TEXT DEFAULT CURRENT_TIMESTAMP,
      checked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_voice_farmer ON voice_calls(farmer_id);
    CREATE INDEX IF NOT EXISTS idx_voice_status ON voice_calls(status);
  `);

  /* ---- Migration: is_seed on farmers ---- */
  const cols = db.prepare('PRAGMA table_info(farmers)').all();
  if (!cols.find(c => c.name === 'is_seed')){
    db.exec('ALTER TABLE farmers ADD COLUMN is_seed INTEGER DEFAULT 0');
    const seedIds = ['F001','F002','F003','F004','F005','F006','F007','F008','F009','F010'];
    const placeholders = seedIds.map(() => '?').join(',');
    db.prepare(`UPDATE farmers SET is_seed = 1 WHERE id IN (${placeholders})`).run(...seedIds);
    console.log('[db] migrated: added is_seed column, marked 10 seed farmers');
  }

  /* ---- Migration: language restriction ---- */
  const langFix = db.prepare(
    "UPDATE farmers SET lang = CASE WHEN loc = 'Musanze' THEN 'sw' ELSE 'en' END " +
    "WHERE lang NOT IN ('en','sw')"
  ).run();

  if (langFix.changes){
    console.log(`[db] migrated ${langFix.changes} farmers to supported languages (en/sw)`);
  }

  /* ---- Migration: delivery columns on sent_alerts ---- */
  const sentCols = db.prepare('PRAGMA table_info(sent_alerts)').all();
  const addSentCol = (name, def) => {
    if (!sentCols.find(c => c.name === name)){
      db.exec(`ALTER TABLE sent_alerts ADD COLUMN ${name} ${def}`);
    }
  };
  addSentCol('provider',            "TEXT");
  addSentCol('delivery_status',     "TEXT DEFAULT 'pending'");
  addSentCol('delivery_error',      "TEXT");
  addSentCol('delivery_checked_at', "TEXT");
  addSentCol('next_check_at',       "TEXT");
  addSentCol('check_count',         "INTEGER DEFAULT 0");
  addSentCol('voice_session_id',    "TEXT");
  addSentCol('voice_status',        "TEXT");

  const unbackfilled = db.prepare(
    "SELECT COUNT(*) AS n FROM sent_alerts WHERE provider IS NULL AND provider_sid IS NOT NULL"
  ).get().n;
  if (unbackfilled){
    const currentProvider = sms.info().provider;
    db.prepare("UPDATE sent_alerts SET provider = ? WHERE provider IS NULL AND provider_sid IS NOT NULL")
      .run(currentProvider);
    console.log('[db] backfilled provider for ' + unbackfilled + ' historic sends');
  }
}

function seedIfEmpty(){
  const count = db.prepare('SELECT COUNT(*) AS n FROM farmers').get().n;
  if (count > 0) return;

  const seed = [
    ['F001','Amina Wanjiku',   '+254712445019','Nakuru',  'Maize',    '2026-03-18','sw',['sms','voice']],
    ['F002','Joseph Otieno',   '+254733908771','Kisumu',  'Rice',     '2026-04-02','sw',['sms']],
    ['F003','Grace Mwikali',   '+254701223664','Meru',    'Beans',    '2026-03-25','sw',['sms','ussd']],
    ['F004','Fatuma Salehe',   '+255754110882','Dodoma',  'Sorghum',  '2026-02-28','sw',['sms','voice']],
    ['F005','Ibrahim Danladi', '+2348037712264','Kano',   'Groundnut','2026-05-05','en',['sms','voice']],
    ['F006','Bola Adeyemi',    '+2348063349911','Ibadan', 'Cassava',  '2026-04-14','en',['sms']],
    ['F007','Tesfaye Bekele',  '+251911552340','Adama',   'Wheat',    '2026-06-01','en',['sms','ussd']],
    ['F008','Sunita Patil',    '+919822044118','Nashik',  'Tomato',   '2026-06-12','en',['sms','voice']],
    ['F009','Ramesh Kumar',    '+919431077226','Patna',   'Rice',     '2026-06-20','en',['sms']],
    ['F010','Chikondi Banda',  '+265991334220','Lilongwe','Maize',    '2026-01-15','en',['sms','voice']]
  ];

  const stmt = db.prepare(`INSERT INTO farmers
    (id,name,phone,loc,crop,planted,lang,channels,is_seed)
    VALUES (?,?,?,?,?,?,?,?,1)`);
  const tx = db.transaction(rows => {
    rows.forEach(r => stmt.run(r[0],r[1],r[2],r[3],r[4],r[5],r[6], JSON.stringify(r[7])));
  });
  tx(seed);
  console.log('[db] seeded 10 demo farmers (is_seed = 1, will not auto-send)');
}

/* ==================================================================
   WINDOW
================================================================== */
function createWindow(){
  win = new BrowserWindow({
    width: 1480, height: 920,
    minWidth: 1080, minHeight: 700,
    show: false,
    backgroundColor: '#f3ece0',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f3ece0',
      symbolColor: '#2a241d',
      height: 46
    },
    backgroundMaterial: isWin11 ? 'mica' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', e => {
    if (!isQuitting){
      e.preventDefault();
      win.hide();
      const shown = db.prepare("SELECT v FROM settings WHERE k='trayHintShown'").get();
      if (!shown){
        db.prepare("INSERT OR REPLACE INTO settings (k,v) VALUES ('trayHintShown','1')").run();
        if (Notification.isSupported()){
          new Notification({
            title: 'Rainbrush is still watching',
            body: 'Minimised to the tray. Right-click the tray icon for quick actions.'
          }).show();
        }
      }
    }
  });
}

/* ==================================================================
   TRAY
================================================================== */
function createTray(){
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  if (!fs.existsSync(iconPath)) return;

  tray = new Tray(iconPath);
  tray.setToolTip('Rainbrush — watching the sky');

  const menu = Menu.buildFromTemplate([
    { label: 'Open studio', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Refresh forecast', click: () => win.webContents.send('trigger-refresh') },
    { label: 'Broadcast alerts',  click: () => win.webContents.send('trigger-broadcast') },
    { type: 'separator' },
    { label: 'About Rainbrush', click: () => {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Rainbrush',
        message: `Rainbrush ${app.getVersion()}`,
        detail: `Weather alerts for smallholder farmers.\n\nData folder:\n${app.getPath('userData')}`,
        buttons: ['Close']
      });
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (win.isVisible()) win.hide();
    else { win.show(); win.focus(); }
  });
}

/* ==================================================================
   IPC — FARMERS
================================================================== */
ipcMain.handle('farmers:list', () => {
  const rows = db.prepare('SELECT * FROM farmers WHERE active = 1 ORDER BY name').all();
  return rows.map(r => ({ ...r, channels: JSON.parse(r.channels || '["sms"]') }));
});

ipcMain.handle('farmers:get', (_e, id) => {
  const row = db.prepare('SELECT * FROM farmers WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, channels: JSON.parse(row.channels || '["sms"]') };
});

ipcMain.handle('farmers:insert', (_e, f) => {
  const id = f.id || 'F' + Date.now().toString(36).toUpperCase();
  db.prepare(`INSERT OR REPLACE INTO farmers
    (id,name,phone,loc,crop,planted,lang,channels,active,is_seed)
    VALUES (@id,@name,@phone,@loc,@crop,@planted,@lang,@channels,1,0)`).run({
      id,
      name:    f.name,
      phone:   f.phone,
      loc:     f.loc,
      crop:    f.crop,
      planted: f.planted || null,
      lang:    f.lang || 'en',
      channels: JSON.stringify(f.channels || ['sms'])
    });
  return id;
});

ipcMain.handle('farmers:update', (_e, f) => {
  if (!f || !f.id) return { ok: false, error: 'missing id' };
  const existing = db.prepare('SELECT id FROM farmers WHERE id = ?').get(f.id);
  if (!existing) return { ok: false, error: 'farmer not found' };

  db.prepare(`UPDATE farmers SET
    name = @name, phone = @phone, loc = @loc,
    crop = @crop, planted = @planted, lang = @lang, channels = @channels
    WHERE id = @id`).run({
    id:       f.id,
    name:     f.name,
    phone:    f.phone,
    loc:      f.loc,
    crop:     f.crop,
    planted:  f.planted || null,
    lang:     f.lang || 'en',
    channels: JSON.stringify(f.channels || ['sms'])
  });
  return { ok: true };
});

ipcMain.handle('farmers:remove', (_e, id) => {
  db.prepare('UPDATE farmers SET active = 0 WHERE id = ?').run(id);
  return true;
});

ipcMain.handle('farmers:insertBatch', (_e, farmers) => {
  if (!Array.isArray(farmers)) return { inserted: 0, failed: 0 };

  const stmt = db.prepare(`INSERT OR REPLACE INTO farmers
    (id,name,phone,loc,crop,planted,lang,channels,active,is_seed)
    VALUES (@id,@name,@phone,@loc,@crop,@planted,@lang,@channels,1,0)`);

  let inserted = 0, failed = 0;
  const tx = db.transaction(list => {
    list.forEach(f => {
      try {
        stmt.run({
          id: f.id || 'F' + Date.now().toString(36).toUpperCase()
              + Math.random().toString(36).slice(2, 6).toUpperCase(),
          name:    f.name,
          phone:   f.phone,
          loc:     f.loc,
          crop:    f.crop,
          planted: f.planted || null,
          lang:    f.lang || 'en',
          channels: JSON.stringify(f.channels || ['sms'])
        });
        inserted++;
      } catch {
        failed++;
      }
    });
  });
  tx(farmers);

  return { inserted, failed };
});

ipcMain.handle('farmers:alertHistory', (_e, id) => {
  return db.prepare(`SELECT id, severity, title, body, lang, created_at, delivered
                     FROM alerts WHERE farmer_id = ?
                     ORDER BY created_at DESC LIMIT 25`).all(id);
});

/* ==================================================================
   IPC — ALERTS
================================================================== */
ipcMain.handle('alerts:saveBatch', (_e, alerts) => {
  const stmt = db.prepare(`INSERT OR REPLACE INTO alerts
    (id,farmer_id,severity,title,body,lang)
    VALUES (@id,@farmer_id,@severity,@title,@body,@lang)`);
  const tx = db.transaction(list => {
    list.forEach(a => stmt.run({
      id:        a.id,
      farmer_id: a.farmerId,
      severity:  a.severity,
      title:     a.title,
      body:      a.body,
      lang:      a.lang || 'en'
    }));
  });
  tx(alerts);
  return true;
});

ipcMain.handle('alerts:recent', (_e, limit = 50) => {
  return db.prepare(`SELECT a.*, f.name AS farmer_name, f.loc AS farmer_loc
                     FROM alerts a JOIN farmers f ON f.id = a.farmer_id
                     ORDER BY a.created_at DESC LIMIT ?`).all(limit);
});

ipcMain.handle('alerts:sentSignatures', (_e, limit = 500) => {
  return db.prepare(`SELECT signature, alert_id, farmer_id, rule_id, day_date,
                            severity, channel, sent_at, provider_sid
                     FROM sent_alerts ORDER BY sent_at DESC LIMIT ?`).all(limit);
});

ipcMain.handle('alerts:isSent', (_e, signature) => {
  return !!db.prepare('SELECT 1 FROM sent_alerts WHERE signature = ? LIMIT 1').get(signature);
});

/* ==================================================================
   IPC — STATS
================================================================== */
ipcMain.handle('stats:get', () => {
  const rows = db.prepare('SELECT k, v FROM stats').all();
  return Object.fromEntries(rows.map(r => [r.k, r.v]));
});

ipcMain.handle('stats:bump', (_e, { key, by = 1 }) => {
  db.prepare('INSERT INTO stats (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = v + ?')
    .run(key, by, by);
  return db.prepare('SELECT v FROM stats WHERE k = ?').get(key).v;
});

/* ==================================================================
   IPC — SMS
================================================================== */
ipcMain.handle('sms:info', () => sms.info());

ipcMain.handle('sms:test', async (_e, { to }) => {
  const result = await sms.sendOne({
    to,
    body: 'Rainbrush test message. If you can read this, SMS delivery is working.'
  });
  return { ...result, dryRun: sms.info().dryRun };
});

ipcMain.handle('sms:sendBatch', async (e, jobs) => {
  const info = sms.info();

  const result = await sms.sendBatch(jobs, progress => {
    if (!e.sender.isDestroyed()){
      e.sender.send('sms:progress', progress);
    }
  });

  const recordStmt = db.prepare(`INSERT OR IGNORE INTO sent_alerts
    (signature, alert_id, farmer_id, rule_id, day_date, severity, channel,
     provider, provider_sid, delivery_status, next_check_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  const eventStmt = db.prepare(`INSERT INTO delivery_events
    (signature, status, raw_status, error, provider) VALUES (?,?,?,?,?)`);

  const initialStatus = info.dryRun ? 'dry-run' : 'sent';
  const initialNext   = info.dryRun ? null : new Date(Date.now() + 30 * 1000).toISOString();

  let recorded = 0;
  const tx = db.transaction(() => {
    result.results.forEach(r => {
      if (!r.ok) return;
      if (!r.signature) return;
      recordStmt.run(
        r.signature,
        r.alertId  || null,
        r.farmerId,
        r.ruleId   || null,
        r.dayDate  || null,
        r.severity || 'info',
        'sms',
        info.provider,
        r.sid      || null,
        initialStatus,
        initialNext
      );
      eventStmt.run(r.signature, initialStatus, r.status || null, null, info.provider);
      recorded++;
    });
  });
  tx();

  return result;
});

ipcMain.handle('sms:openLog', () => {
  const p = sms.info().logPath;
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  return p;
});

/* ==================================================================
   IPC — VOICE
================================================================== */
ipcMain.handle('voice:info', () => voice.info());

ipcMain.handle('voice:test', async (_e, { to, text }) => {
  const result = await voice.callOne({
    to,
    text: text || 'Rainbrush test call. If you can hear this, voice dispatch is working.',
    clientRequestId: 'rainbrush-test'
  });
  return { ...result, dryRun: voice.info().dryRun };
});

ipcMain.handle('voice:estimate', (_e, { text, country }) => {
  return voice.estimateCost(text, country || '+254');
});

ipcMain.handle('voice:dispatch', async (e, jobs) => {
  const info = voice.info();

  const result = await voice.callBatch(jobs, progress => {
    if (!e.sender.isDestroyed()) e.sender.send('voice:progress', progress);
  });

  const insert = db.prepare(`INSERT INTO voice_calls
    (signature, farmer_id, alert_id, phone, text_spoken, session_id, status, raw_status, error)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  const updateSent = db.prepare(`UPDATE sent_alerts
    SET voice_session_id = ?, voice_status = ?
    WHERE signature = ?`);

  const tx = db.transaction(() => {
    result.results.forEach(r => {
      if (!r.signature) return;
      const initialStatus = info.dryRun ? 'dry-run' : (r.ok ? 'queued' : 'failed');
      insert.run(
        r.signature, r.farmerId, r.alertId || null, r.to,
        r.text, r.sid || null, initialStatus, r.status || null, r.error || null
      );
      if (r.ok){
        updateSent.run(r.sid || null, initialStatus, r.signature);
      }
    });
  });
  tx();

  return result;
});

ipcMain.handle('voice:recent', (_e, limit = 50) => {
  return db.prepare(`SELECT vc.*, f.name AS farmer_name, f.loc AS farmer_loc
    FROM voice_calls vc
    LEFT JOIN farmers f ON f.id = vc.farmer_id
    ORDER BY vc.dispatched_at DESC LIMIT ?`).all(limit);
});

ipcMain.handle('voice:statusMap', () => {
  const rows = db.prepare('SELECT signature, status FROM voice_calls').all();
  const map = {};
  rows.forEach(r => { map[r.signature] = r.status; });
  return map;
});

ipcMain.handle('voice:summary', () => {
  const rows = db.prepare(`SELECT COALESCE(status,'queued') AS s, COUNT(*) AS n
    FROM voice_calls GROUP BY s`).all();
  const out = { queued:0, ringing:0, answered:0, failed:0, unknown:0, 'dry-run':0 };
  rows.forEach(r => { out[r.s] = r.n; });
  out.total = rows.reduce((s, r) => s + r.n, 0);
  return out;
});

ipcMain.handle('voice:pollStatus', async () => {
  const pending = db.prepare(`SELECT * FROM voice_calls
    WHERE status NOT IN ('answered','failed','unknown','dry-run')
      AND session_id IS NOT NULL
    ORDER BY dispatched_at DESC LIMIT 50`).all();

  let updated = 0;
  for (const row of pending){
    const r = await voice.checkStatus(row.session_id);
    if (r.status !== row.status){
      db.prepare(`UPDATE voice_calls SET status = ?, raw_status = ?, error = ?, checked_at = ?
        WHERE id = ?`).run(r.status, r.raw, r.error, new Date().toISOString(), row.id);
      db.prepare(`UPDATE sent_alerts SET voice_status = ? WHERE signature = ?`)
        .run(r.status, row.signature);
      updated++;
    }
  }
  return { checked: pending.length, updated };
});

ipcMain.handle('voice:openLog', () => {
  const p = voice.info().logPath;
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  return p;
});

/* ==================================================================
   IPC — DELIVERY RECEIPTS
================================================================== */
ipcMain.handle('receipts:summary', () => receipts.summary());
ipcMain.handle('receipts:recent',  (_e, limit) => receipts.recent(limit || 50));
ipcMain.handle('receipts:statusMap', () => receipts.statusMap());
ipcMain.handle('receipts:events',  (_e, sig) => receipts.events(sig));
ipcMain.handle('receipts:stats',   () => receipts.statsInfo());
ipcMain.handle('receipts:retry',   (_e, sig) => receipts.retry(sig));

ipcMain.handle('receipts:poll', async () => {
  try {
    const r = await receipts.poll();
    return { ok: true, ...r };
  } catch (err){
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('receipts:openLog', () => {
  const p = receipts.statsInfo().logPath;
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  return p;
});

/* ==================================================================
   IPC — SCHEDULER
================================================================== */
ipcMain.handle('scheduler:status', () => scheduler.status());

ipcMain.handle('scheduler:runNow', async () => {
  try {
    const result = await scheduler.runCycle('manual');
    return { ok: true, result };
  } catch (err){
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('scheduler:setEnabled', (_e, on) => {
  scheduler.setEnabled(!!on);
  return scheduler.status();
});

ipcMain.handle('scheduler:setInterval', (_e, hours) => {
  scheduler.setIntervalHours(hours);
  return scheduler.status();
});

ipcMain.handle('scheduler:setAutoSend', (_e, on) => {
  scheduler.setAutoSend(!!on);
  return scheduler.status();
});

ipcMain.handle('scheduler:openLog', () => {
  const p = scheduler.status().logPath;
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  return p;
});

/* ==================================================================
   IPC — USSD RELAY
================================================================== */
ipcMain.handle('ussd:info', () => ussd.info());

ipcMain.handle('ussd:sync', async () => {
  const forecasts = {};
  const locs = db.prepare('SELECT DISTINCT loc FROM farmers WHERE active = 1').all();
  for (const { loc } of locs){
    const meta = engine.LOCATIONS.find(l => l.name === loc);
    if (!meta) continue;
    try {
      forecasts[loc] = await engine.fetchForecast(meta);
    } catch {
      forecasts[loc] = engine.simulateForecast(meta);
    }
  }

  const farmers = db.prepare('SELECT * FROM farmers WHERE active = 1').all()
    .map(r => ({ ...r, channels: JSON.parse(r.channels || '["sms"]') }));

  const push = await ussd.syncAll(forecasts, farmers, engine.LOCATIONS);
  return { ok: push.ok, push };
});

ipcMain.handle('ussd:health', () => ussd.health());

ipcMain.handle('ussd:sessions', async (_e, limit) => {
  return ussd.pullSessions(limit || 100);
});

ipcMain.handle('ussd:analytics', async (_e, sinceIso) => {
  return ussd.pullAnalytics(sinceIso);
});

ipcMain.handle('ussd:openLog', () => {
  const p = ussd.info().logPath;
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  return p;
});

/* ==================================================================
   IPC — CSV IMPORT
================================================================== */
ipcMain.handle('csv:pickFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose a CSV file',
    properties: ['openFile'],
    filters: [
      { name: 'CSV', extensions: ['csv', 'txt'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (canceled || !filePaths.length) return null;

  const filePath = filePaths[0];
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 10 * 1024 * 1024){
      return { error: 'File is larger than 10 MB. Split it and try again.' };
    }
    const text = fs.readFileSync(filePath, 'utf8');
    return { filePath, fileName: path.basename(filePath), size: stat.size, text };
  } catch (err){
    return { error: err.message || String(err) };
  }
});

ipcMain.handle('csv:exportTemplate', async () => {
  const template = [
    'name,phone,location,crop,planted,language,channels',
    'Amina Wanjiku,+254712445019,Nakuru,Maize,2026-03-18,sw,sms|voice',
    'Joseph Otieno,+254733908771,Kisumu,Rice,2026-04-02,sw,sms',
    'Grace Mwikali,+254701223664,Meru,Beans,2026-03-25,sw,sms|ussd'
  ].join('\r\n');

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save CSV template',
    defaultPath: 'rainbrush-import-template.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, template, 'utf8');
  return filePath;
});

/* ==================================================================
   IPC — NOTIFICATIONS
================================================================== */
ipcMain.handle('notify', (_e, { title, body, urgent }) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({
    title: title || 'Rainbrush',
    body:  body  || '',
    urgency: urgent ? 'critical' : 'normal',
    silent: !urgent
  });
  n.on('click', () => { win.show(); win.focus(); });
  n.show();
  return true;
});

/* ==================================================================
   IPC — EXPORT
================================================================== */
ipcMain.handle('export:csv', async (_e, { filename, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export farmers',
    defaultPath: filename || 'rainbrush-farmers.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
});

ipcMain.handle('export:showInFolder', (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

/* ==================================================================
   IPC — APP INFO
================================================================== */
ipcMain.handle('app:info', () => ({
  version:  app.getVersion(),
  platform: process.platform,
  arch:     process.arch,
  electron: process.versions.electron,
  chrome:   process.versions.chrome,
  node:     process.versions.node,
  dataPath: app.getPath('userData'),
  isWin11
}));

ipcMain.handle('app:revealData', () => shell.openPath(app.getPath('userData')));

/* ==================================================================
   LIFECYCLE
================================================================== */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock){
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win){
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'light';
    Menu.setApplicationMenu(null);

    initDB();
    seedIfEmpty();
    createWindow();
    createTray();

    const dataDir = app.getPath('userData');

    /* ---- Scheduler ---- */
    const envOn   = process.env.SCHEDULER_ENABLED !== '0';
    const envHrs  = parseInt(process.env.SCHEDULER_INTERVAL_HOURS || '6', 10);
    const envAuto = process.env.SCHEDULER_AUTO_SEND === '1';
    const envSeed = process.env.ALLOW_SEED_SEND === '1';

    const getSetting = (key, fallback) => {
      const row = db.prepare('SELECT v FROM settings WHERE k = ?').get(key);
      return row ? row.v : fallback;
    };

    const enabled  = getSetting('scheduler_enabled', envOn ? '1' : '0') === '1';
    const hours    = parseInt(getSetting('scheduler_interval_hours', String(envHrs)), 10);
    const autoSend = getSetting('scheduler_auto_send', envAuto ? '1' : '0') === '1';

    scheduler.init({
      db,
      sms,
      voice,
      ussd,
      enabled,
      intervalHours: Number.isFinite(hours) && hours > 0 ? hours : 6,
      autoSend,
      allowSeedSend: envSeed,
      logPath: path.join(dataDir, 'scheduler.log'),
      notify: (n) => {
        if (Notification.isSupported()){
          const toast = new Notification({
            title: n.title || 'Rainbrush',
            body: n.body || '',
            urgency: n.urgent ? 'critical' : 'normal'
          });
          toast.on('click', () => { win.show(); win.focus(); });
          toast.show();
        }
      },
      onCycle: (info) => {
        if (win && !win.isDestroyed()){
          win.webContents.send('scheduler:cycle-complete', info);
        }
      }
    });

    /* ---- Receipts ---- */
    const receiptInterval = parseInt(process.env.RECEIPTS_POLL_INTERVAL_MS || '60000', 10);

    receipts.init({
      db,
      sms,
      pollIntervalMs: Number.isFinite(receiptInterval) && receiptInterval >= 10000
        ? receiptInterval
        : 60000,
      logPath: path.join(dataDir, 'receipts.log'),
      onUpdate: (info) => {
        if (win && !win.isDestroyed()){
          win.webContents.send('receipts:updated', info);
        }
      }
    });

    /* ---- Voice ---- */
    try {
      voice.init({
        apiKey:       process.env.AT_API_KEY || '',
        username:     process.env.AT_USERNAME || 'sandbox',
        callerId:     process.env.AT_CALLER_ID || '',
        sandbox:      (process.env.AT_USERNAME || '') === 'sandbox',
        dryRun:       sms.info().dryRun || !process.env.AT_API_KEY,
        maxPerSecond: parseInt(process.env.VOICE_MAX_PER_SECOND || '2', 10),
        logPath:      path.join(dataDir, 'voice.log')
      });
    } catch (err){
      console.error('[voice] init failed:', err.message);
    }

    /* ---- USSD relay ---- */
    ussd.init({
      relayUrl: process.env.USSD_RELAY_URL || '',
      secret:   process.env.USSD_RELAY_SECRET || '',
      logPath:  path.join(dataDir, 'ussd.log')
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else { win.show(); win.focus(); }
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    scheduler.stop();
    receipts.stop();
  });
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => { if (db) db.close(); });
}