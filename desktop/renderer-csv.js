'use strict';

/* ==================================================================
   Rainbrush — CSV import module
   Exposes window.RainbrushCSV with:
     .init(context)  — wire up to the host app
     .open()         — open the modal
     .close()        — close the modal
   ================================================================== */

(function(){

  let ctx = null;

  const session = {
    fileName: '',
    filePath: '',
    rawText:  '',
    headers:  [],
    rows:     [],
    mapping:  {},
    dial:     '+254',
    validated: []
  };

  const FIELDS = [
    { key:'name',     label:'Name',          required:true,  hints:['name','farmer','farmer_name','fullname','full_name','full names'] },
    { key:'phone',    label:'Phone',         required:true,  hints:['phone','phone_number','mobile','msisdn','tel','telephone','contact'] },
    { key:'loc',      label:'Location',      required:true,  hints:['location','loc','village','town','ward','district','region','area'] },
    { key:'crop',     label:'Main crop',     required:false, hints:['crop','main_crop','primary_crop','crop_type'] },
    { key:'planted',  label:'Planting date', required:false, hints:['planted','planting_date','plant_date','sowing_date','date_planted'] },
    { key:'lang',     label:'Language',      required:false, hints:['language','lang','locale','preferred_language'] },
    { key:'channels', label:'Channels',      required:false, hints:['channels','channel','delivery','delivery_channels','contact_method'] }
  ];

  const REGION_TO_DIAL = {
    'Kenya':'+254', 'Tanzania':'+255', 'Nigeria':'+234',
    'Ethiopia':'+251', 'Rwanda':'+250', 'India':'+91',
    'Malawi':'+265', 'Ghana':'+233'
  };

  const COUNTRY_LABELS = {
    '+254':'Kenya', '+255':'Tanzania', '+234':'Nigeria',
    '+251':'Ethiopia', '+250':'Rwanda', '+91':'India',
    '+265':'Malawi', '+233':'Ghana'
  };

  /* ------------------------------------------------------------------
     CSV parser — RFC 4180 compliant
  ------------------------------------------------------------------ */
  function parseCSV(text){
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    while (i < text.length){
      const c = text[i];

      if (inQuotes){
        if (c === '"'){
          if (text[i + 1] === '"'){ field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }

      if (c === '"'){ inQuotes = true; i++; continue; }
      if (c === ','){ row.push(field); field = ''; i++; continue; }
      if (c === '\r'){ i++; continue; }
      if (c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; i++; continue; }

      field += c; i++;
    }

    if (field.length || row.length){ row.push(field); rows.push(row); }

    while (rows.length && rows[rows.length - 1].every(f => !String(f || '').trim())){
      rows.pop();
    }
    return rows;
  }

  function autoMap(headers){
    const map = {};
    const norm = headers.map(h =>
      String(h || '').toLowerCase().trim().replace(/[\s\-]+/g, '_')
    );

    for (const f of FIELDS){
      let idx = norm.findIndex(h => f.hints.includes(h));
      if (idx === -1){
        idx = norm.findIndex(h =>
          f.hints.some(hint => h.includes(hint) || hint.includes(h))
        );
      }
      if (idx !== -1) map[f.key] = headers[idx];
    }
    return map;
  }

  function normalizePhone(raw, dialCode){
    if (!raw) return null;
    let p = String(raw).replace(/[\s\-().]/g, '');
    if (!p) return null;

    if (p.startsWith('00')) p = '+' + p.slice(2);
    if (p.startsWith('+')){
      return /^\+\d{8,15}$/.test(p) ? p : null;
    }

    const stripped = p.replace(/^0+/, '');
    if (!stripped || !/^\d+$/.test(stripped)) return null;

    const dialDigits = dialCode.replace('+', '');
    if (stripped.startsWith(dialDigits) && stripped.length >= dialDigits.length + 6){
      const c = '+' + stripped;
      return /^\+\d{8,15}$/.test(c) ? c : null;
    }

    const c = dialCode + stripped;
    return /^\+\d{8,15}$/.test(c) ? c : null;
  }

  function parseLang(s){
    if (!s) return null;
    const t = String(s).toLowerCase().trim();

    if (t === 'en' || t === 'english') return 'en';
    if (t === 'sw' || t === 'kiswahili' || t === 'swahili') return 'sw';

    if (t === 'fr' || t === 'french' || t === 'français' || t === 'francais') return '__unsupported_fr';
    if (t === 'hi' || t === 'hindi' || t === 'हिन्दी') return '__unsupported_hi';

    return null;
  }

  function parseChannels(s){
    if (!s) return [];
    const parts = String(s)
      .split(/[|,;+\s]+/)
      .map(x => x.toLowerCase().trim())
      .filter(Boolean);

    const out = [];
    for (const p of parts){
      if (p === 'sms' || p === 'text' || p === 'message') out.push('sms');
      else if (p === 'voice' || p === 'call' || p === 'ivr') out.push('voice');
      else if (p === 'ussd') out.push('ussd');
    }
    return [...new Set(out)];
  }

  function parseDate(s){
    if (!s) return '';
    const t = String(s).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const m1 = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m1){
      const dd = m1[1].padStart(2, '0');
      const mm = m1[2].padStart(2, '0');
      return `${m1[3]}-${mm}-${dd}`;
    }
    return '';
  }

  function getCell(row, headerName, headers){
    if (!headerName) return '';
    const idx = headers.indexOf(headerName);
    if (idx === -1) return '';
    return String(row[idx] || '').trim();
  }

  function validateRow(row, headers, mapping, dialCode, opts){
    opts = opts || {};
    const issues = [];
    const normalized = {};
    let status = 'ok';

    const escalate = (level) => {
      if (level === 'error'){ status = 'error'; return; }
      if (level === 'warn' && status !== 'error') status = 'warn';
    };

    const name = getCell(row, mapping.name, headers);
    if (!name){ issues.push('Missing name'); escalate('error'); }
    normalized.name = name;

    const phoneRaw = getCell(row, mapping.phone, headers);
    if (!phoneRaw){
      issues.push('Missing phone number');
      escalate('error');
    } else {
      const phone = normalizePhone(phoneRaw, dialCode);
      if (!phone){
        issues.push(`Unrecognised phone: ${phoneRaw}`);
        escalate('error');
      } else {
        normalized.phone = phone;
        const cleaned = phoneRaw.replace(/[\s\-().]/g, '');
        if (phone !== cleaned){
          issues.push(`Phone normalised to ${phone}`);
          escalate('warn');
        }
      }
    }

    const loc = getCell(row, mapping.loc, headers);
    if (!loc){
      issues.push('Missing location');
      escalate('error');
    } else if (opts.knownLocations && !opts.knownLocations.includes(loc)){
      issues.push(`Unknown location "${loc}" — imported as-is`);
      escalate('warn');
    }
    normalized.loc = loc;

    const crop = getCell(row, mapping.crop, headers);
    if (!crop){
      if (mapping.crop){
        issues.push('Empty crop — defaulted to Maize');
        escalate('warn');
      }
      normalized.crop = 'Maize';
    } else {
      normalized.crop = crop;
    }

    const plantedRaw = getCell(row, mapping.planted, headers);
    const planted = parseDate(plantedRaw);
    if (plantedRaw && !planted){
      issues.push(`Unrecognised date "${plantedRaw}"`);
      escalate('warn');
    }
    normalized.planted = planted;

    const langRaw = getCell(row, mapping.lang, headers);
    if (langRaw){
      const lang = parseLang(langRaw);
      if (!lang){
        issues.push(`Unknown language "${langRaw}" — defaulted to English`);
        escalate('warn');
        normalized.lang = 'en';
      } else if (typeof lang === 'string' && lang.startsWith('__unsupported_')){
        const name = lang.replace('__unsupported_', '');
        const label = name === 'fr' ? 'French' : 'Hindi';
        issues.push(`${label} is not supported for SMS — defaulted to English`);
        escalate('warn');
        normalized.lang = 'en';
      } else {
        normalized.lang = lang;
      }
    } else {
      normalized.lang = 'en';
    }

    const channelsRaw = getCell(row, mapping.channels, headers);
    if (channelsRaw){
      const channels = parseChannels(channelsRaw);
      if (!channels.length){
        issues.push(`Unknown channels "${channelsRaw}" — defaulted to SMS`);
        escalate('warn');
        normalized.channels = ['sms'];
      } else {
        normalized.channels = channels;
      }
    } else {
      normalized.channels = ['sms'];
    }

    return { normalized, issues, status };
  }

  function runValidation(){
    const { headers, rows, mapping, dial } = session;
    const knownLocations = ctx.LOCATIONS.map(l => l.name);

    const validated = [];

    for (let i = 1; i < rows.length; i++){
      const row = rows[i];
      const result = validateRow(row, headers, mapping, dial, { knownLocations });
      validated.push({
        index: i,
        raw: row,
        normalized: result.normalized,
        issues: result.issues,
        status: result.status,
        isDup: false
      });
    }

    const seen = new Map();
    for (const v of validated){
      const p = v.normalized.phone;
      if (!p) continue;
      if (seen.has(p)){
        v.isDup = true;
        v.issues.push('Duplicate phone number in this file');
        if (v.status === 'ok') v.status = 'warn';
      } else {
        seen.set(p, v);
      }
    }

    session.validated = validated;
    return validated;
  }

  function summarise(){
    let ok = 0, warn = 0, err = 0, dup = 0;
    for (const v of session.validated){
      if (v.status === 'ok') ok++;
      else if (v.status === 'warn') warn++;
      else err++;
      if (v.isDup) dup++;
    }
    return { ok, warn, err, dup, total: session.validated.length };
  }

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  let modalEl, stepFileEl, stepReviewEl;

  function renderMapping(){
    const grid = $('#csv-map-grid');
    if (!grid) return;

    grid.innerHTML = FIELDS.map(f => {
      const current = session.mapping[f.key] || '';
      const options = ['<option value="">— not mapped —</option>']
        .concat(session.headers.map(h =>
          `<option value="${escapeAttr(h)}"${h === current ? ' selected' : ''}>${escapeHtml(h)}</option>`
        ))
        .join('');

      const missing = f.required && !current ? ' missing' : '';

      return `<div class="mapping-row">
        <label>${escapeHtml(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>
        <select class="${missing}" data-map="${f.key}">${options}</select>
      </div>`;
    }).join('');

    $$('#csv-map-grid select').forEach(sel => {
      sel.addEventListener('change', () => {
        const key = sel.dataset.map;
        if (sel.value) session.mapping[key] = sel.value;
        else delete session.mapping[key];
        revalidate();
      });
    });
  }

  function renderCountryRow(){
    const row = $('#csv-country-row');
    if (!row) return;

    const opts = Object.keys(COUNTRY_LABELS).map(d =>
      `<option value="${d}"${d === session.dial ? ' selected' : ''}>${COUNTRY_LABELS[d]} (${d})</option>`
    ).join('');

    row.innerHTML = `
      <label for="csv-country-select">Default country for phone numbers</label>
      <select class="select" id="csv-country-select">${opts}</select>
      <p class="hint" style="flex-basis:100%">Used when a phone number doesn't start with <code>+</code>. Numbers already in international format are used as-is.</p>
    `;

    $('#csv-country-select').addEventListener('change', (e) => {
      session.dial = e.target.value;
      revalidate();
    });
  }

  const PREVIEW_CAP = 300;

  function renderPreview(){
    const body = $('#csv-preview-body');
    const sum  = $('#csv-preview-summary');
    if (!body || !sum) return;

    const s = summarise();
    sum.innerHTML = `
      <span class="ok">✓ ${s.ok} ready</span>
      ${s.warn ? `<span class="warn">⚠ ${s.warn} warning${s.warn === 1 ? '' : 's'}</span>` : ''}
      ${s.err  ? `<span class="err">✗ ${s.err} error${s.err === 1 ? '' : 's'}</span>` : ''}
      ${s.dup  ? `<span class="warn">↻ ${s.dup} duplicate${s.dup === 1 ? '' : 's'}</span>` : ''}
    `;

    const rows = session.validated.slice(0, PREVIEW_CAP);
    body.innerHTML = rows.map(v => {
      const icon = v.status === 'error' ? '✗'
                 : v.status === 'warn'  ? '⚠'
                 :                        '✓';
      const cls = 'row-' + (v.status === 'error' ? 'error'
                          : v.status === 'warn'  ? 'warn'
                          :                        'ok');
      const n = v.normalized;

      return `<tr class="${cls}">
        <td class="status">${icon}</td>
        <td>${escapeHtml(n.name || '—')}</td>
        <td><code style="font-size:.76rem">${escapeHtml(n.phone || '—')}</code></td>
        <td>${escapeHtml(n.loc || '—')}</td>
        <td>${escapeHtml(n.crop || '—')}</td>
        <td class="issues">${v.issues.length ? escapeHtml(v.issues.join(' · ')) : ''}</td>
      </tr>`;
    }).join('');

    const more = $('#csv-preview-more');
    if (more){
      more.textContent = session.validated.length > PREVIEW_CAP
        ? `Showing ${PREVIEW_CAP} of ${session.validated.length} rows — the rest will still be imported.`
        : '';
    }

    const importable = session.validated.filter(v => v.status !== 'error').length;
    const btn = $('#csv-import');
    if (btn){
      btn.disabled = importable === 0;
      btn.textContent = importable === 1
        ? 'Import 1 farmer'
        : `Import ${importable} farmers`;
    }
  }

  function revalidate(){
    runValidation();
    renderPreview();
  }

  function loadFile({ fileName, filePath, text }){
    if (!text || !text.trim()){
      ctx.toast('That file appears to be empty.', 'warn');
      return;
    }

    const rows = parseCSV(text);
    if (rows.length < 2){
      ctx.toast('No data rows found. The file must have a header row and at least one farmer.', 'warn');
      return;
    }

    session.fileName = fileName;
    session.filePath = filePath || '';
    session.rawText  = text;
    session.headers  = rows[0].map(h => String(h || '').trim());
    session.rows     = rows;
    session.mapping  = autoMap(session.headers);

    const locCol = session.mapping.loc;
    if (locCol){
      const counts = {};
      for (let i = 1; i < rows.length; i++){
        const loc = getCell(rows[i], locCol, session.headers);
        const found = ctx.LOCATIONS.find(l => l.name === loc);
        if (found){
          const dial = REGION_TO_DIAL[found.region] || '+254';
          counts[dial] = (counts[dial] || 0) + 1;
        }
      }
      const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      if (top) session.dial = top;
    }

    stepFileEl.style.display = 'none';
    stepReviewEl.style.display = '';

    $('#csv-file-info').innerHTML = `
      <span class="icon">📄</span>
      <div>
        <div class="name">${escapeHtml(fileName)}</div>
        <div class="size">${rows.length - 1} data row${rows.length - 1 === 1 ? '' : 's'}</div>
      </div>
      <button class="replace" id="csv-replace">Replace file</button>
    `;
    $('#csv-replace').addEventListener('click', resetToFileStep);

    renderCountryRow();
    renderMapping();
    revalidate();
  }

  function resetToFileStep(){
    session.fileName = '';
    session.filePath = '';
    session.rawText  = '';
    session.headers  = [];
    session.rows     = [];
    session.mapping  = {};
    session.validated = [];

    stepReviewEl.style.display = 'none';
    stepFileEl.style.display = '';
    $('#csv-import').disabled = true;
  }

  async function doImport(){
    const importable = session.validated.filter(v => v.status !== 'error');
    if (!importable.length){
      ctx.toast('No valid rows to import.', 'warn');
      return;
    }

    const btn = $('#csv-import');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Importing…';

    const payload = importable.map(v => ({
      id: undefined,
      name: v.normalized.name,
      phone: v.normalized.phone,
      loc: v.normalized.loc,
      crop: v.normalized.crop,
      planted: v.normalized.planted,
      lang: v.normalized.lang,
      channels: v.normalized.channels
    }));

    let result;
    try {
      result = await window.rainbrush.addFarmersBatch(payload);
    } catch (err){
      btn.disabled = false;
      btn.textContent = original;
      ctx.toast(`Import failed: ${err.message || err}`, 'warn');
      return;
    }

    await ctx.reloadFarmers();
    ctx.renderGallery();

    close();

    const skipped = session.validated.filter(v => v.status === 'error').length;
    ctx.toast(
      `Imported ${result.inserted} farmer${result.inserted === 1 ? '' : 's'}` +
      (skipped ? ` — ${skipped} row${skipped === 1 ? '' : 's'} skipped` : '') + '.',
      'ok'
    );
  }

  function wireDropzone(){
    const zone = $('#csv-dropzone');
    if (!zone) return;

    ['dragover', 'drop'].forEach(ev =>
      window.addEventListener(ev, (e) => { e.preventDefault(); }, false)
    );

    ['dragenter', 'dragover'].forEach(ev =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('dragging');
      })
    );

    ['dragleave', 'drop'].forEach(ev =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (ev === 'dragleave' && zone.contains(e.relatedTarget)) return;
        zone.classList.remove('dragging');
      })
    );

    zone.addEventListener('drop', async (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024){
        ctx.toast('File is larger than 10 MB.', 'warn');
        return;
      }
      try {
        const text = await file.text();
        loadFile({ fileName: file.name, filePath: '', text });
      } catch (err){
        ctx.toast(`Could not read file: ${err.message || err}`, 'warn');
      }
    });

    $('#csv-browse').addEventListener('click', async () => {
      const r = await window.rainbrush.csvPickFile();
      if (!r) return;
      if (r.error){ ctx.toast(r.error, 'warn'); return; }
      loadFile({ fileName: r.fileName, filePath: r.filePath, text: r.text });
    });

    $('#csv-template').addEventListener('click', async (e) => {
      e.preventDefault();
      const p = await window.rainbrush.csvExportTemplate();
      if (p){
        ctx.toast('Template saved.', 'ok');
        window.rainbrush.showInFolder(p);
      }
    });
  }

  function escapeHtml(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])
    );
  }
  function escapeAttr(s){ return escapeHtml(s); }

  function open(){
    if (!modalEl) return;
    resetToFileStep();
    modalEl.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function close(){
    if (!modalEl) return;
    modalEl.classList.remove('open');
    document.body.style.overflow = '';
  }

  function init(context){
    ctx = context;

    modalEl      = $('#csv-modal');
    stepFileEl   = $('#csv-step-file');
    stepReviewEl = $('#csv-step-review');

    if (!modalEl) return;

    $('#csv-close').addEventListener('click', close);
    $('#csv-cancel').addEventListener('click', close);

    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!modalEl.classList.contains('open')) return;
      if (document.getElementById('edit-modal').classList.contains('open')) return;
      close();
    });

    $('#csv-import').addEventListener('click', doImport);

    wireDropzone();
  }

  window.RainbrushCSV = { init, open, close };

})();