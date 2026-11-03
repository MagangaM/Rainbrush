'use strict';

/* ==================================================================
   Rainbrush USSD relay — Open-Meteo client
   Pure API wrapper. Takes coordinates as arguments. The list of known
   locations lives in the relay's database, populated by the desktop
   app on sync.
   ================================================================== */

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function dayLabel(dateStr, i){
  if (i === 0) return 'today';
  if (i === 1) return 'tomorrow';
  return 'on ' + DAY_NAMES[new Date(dateStr + 'T12:00:00').getDay()];
}
function dayLabelShort(dateStr, i){
  if (i === 0) return 'Today';
  if (i === 1) return 'Tmrw';
  return DAY_SHORT[new Date(dateStr + 'T12:00:00').getDay()];
}

/* ------------------------------------------------------------------
   LIVE FETCH
------------------------------------------------------------------ */
async function fetchFromOpenMeteo({ name, region, lat, lon, days }){
  const params = new URLSearchParams({
    latitude:  String(lat),
    longitude: String(lon),
    daily: [
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'wind_speed_10m_max',
      'precipitation_probability_max'
    ].join(','),
    hourly: 'relative_humidity_2m',
    timezone: 'auto',
    forecast_days: String(days || 7)
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  try {
    const res = await fetch(OPEN_METEO + '?' + params.toString(), {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error('Open-Meteo responded ' + res.status);

    const j = await res.json();
    if (!j.daily || !Array.isArray(j.daily.time)){
      throw new Error('malformed Open-Meteo payload');
    }

    const humByDate = {};
    const hTimes = (j.hourly && j.hourly.time) || [];
    const hVals  = (j.hourly && j.hourly.relative_humidity_2m) || [];
    for (let i = 0; i < hTimes.length; i++){
      const key = hTimes[i].slice(0, 10);
      if (!humByDate[key]) humByDate[key] = [];
      if (hVals[i] != null) humByDate[key].push(hVals[i]);
    }

    const daysOut = j.daily.time.map((iso, i) => {
      const arr = humByDate[iso] || [];
      const hum = arr.length
        ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
        : 65;
      return {
        date: iso,
        label: dayLabel(iso, i),
        dow: dayLabelShort(iso, i),
        dayNum: new Date(iso + 'T12:00:00').getDate(),
        tmax: Math.round(j.daily.temperature_2m_max[i] ?? 28),
        tmin: Math.round(j.daily.temperature_2m_min[i] ?? 16),
        rain: Math.round(j.daily.precipitation_sum[i] ?? 0),
        wind: Math.round(j.daily.wind_speed_10m_max[i] ?? 12),
        hum,
        prob: Math.round(j.daily.precipitation_probability_max?.[i] ?? 0)
      };
    });

    if (!daysOut.length) throw new Error('no forecast days returned');

    return {
      location: name,
      region: region || '',
      source: 'live',
      fetchedAt: new Date().toISOString(),
      days: daysOut
    };

  } catch (err){
    clearTimeout(timer);
    throw err;
  }
}

/* ------------------------------------------------------------------
   DETERMINISTIC FALLBACK
   Identical algorithm to the desktop engine. Only used if Open-Meteo
   is unreachable.
------------------------------------------------------------------ */
function hashStr(s){
  let h = 2166136261;
  for (let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function simulateForecast({ name, region, lat, days }){
  const rnd = mulberry32(hashStr(name + (region || '')));
  const latFactor = Math.abs(lat || 0);
  const baseMax = 34 - latFactor * 0.42 + (rnd() * 5 - 2.5);
  const swing = 8 + rnd() * 5;
  let wet = 0.25 + rnd() * 0.5;
  const out = [];
  const today = new Date();
  const n = days || 7;

  for (let i = 0; i < n; i++){
    wet = clamp(wet + (rnd() - 0.5) * 0.55, 0, 1);
    const dayRnd = mulberry32(hashStr(name + i * 977));
    const tmax = baseMax + (dayRnd() * 4 - 2);
    const tmin = tmax - swing + (dayRnd() * 3 - 1.5);
    const rain = Math.round(Math.pow(wet, 2.6) * 105 * (0.45 + dayRnd() * 0.9));
    const hum  = Math.round(clamp(52 + wet * 40 + dayRnd() * 12, 30, 96));
    const wind = Math.round(8 + dayRnd() * 34 + wet * 12);
    const prob = Math.round(clamp(rain > 0 ? 45 + rain * 0.9 : 12 + dayRnd() * 20, 0, 96));

    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);

    out.push({
      date: iso,
      label: dayLabel(iso, i),
      dow: dayLabelShort(iso, i),
      dayNum: d.getDate(),
      tmax: Math.round(tmax),
      tmin: Math.round(tmin),
      rain, wind, hum, prob
    });
  }

  return {
    location: name,
    region: region || '',
    source: 'sim',
    fetchedAt: new Date().toISOString(),
    days: out
  };
}

/* ------------------------------------------------------------------
   PUBLIC
------------------------------------------------------------------ */
async function getForecast({ name, region, lat, lon, days }){
  try {
    return await fetchFromOpenMeteo({ name, region, lat, lon, days });
  } catch (err){
    console.error('[forecast] Open-Meteo failed for ' + name + ': ' + err.message);
    const sim = simulateForecast({ name, region, lat, days });
    sim.fallbackReason = err.message;
    return sim;
  }
}

module.exports = { getForecast, fetchFromOpenMeteo, simulateForecast };