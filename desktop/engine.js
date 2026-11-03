'use strict';

/* ==================================================================
   Rainbrush — shared engine
   Used by main.js (scheduler) and index.html (UI).
   UMD pattern: exposes CommonJS exports or a window global.
   ================================================================== */
(function(root, factory){
  if (typeof module === 'object' && module.exports){
    module.exports = factory();
  } else {
    root.RainbrushEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){

  const LOCATIONS = [
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

  const CROPS = ['Maize','Beans','Sorghum','Millet','Rice','Wheat',
                 'Tomato','Cassava','Groundnut','Cotton','Kale','Potato'];

  const LANG_NAMES = { en:'English', sw:'Kiswahili' };
  const SUPPORTED_LANGS = ['en', 'sw'];

  const CROP_COLORS = {
    Maize:'#d99b3f', Beans:'#7d9b76', Sorghum:'#c05f3c', Millet:'#b87c26',
    Rice:'#6f96b8', Wheat:'#e3b654', Tomato:'#c0392b', Cassava:'#8a6b4a',
    Groundnut:'#a3743f', Cotton:'#c9c2b0', Kale:'#4f7a48', Potato:'#a98a63'
  };

  const REGION_TO_DIAL = {
    'Kenya':'+254', 'Tanzania':'+255', 'Nigeria':'+234',
    'Ethiopia':'+251', 'Rwanda':'+250', 'India':'+91',
    'Malawi':'+265', 'Ghana':'+233'
  };

  function hashStr(s){
    let h = 2166136261;
    for (let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
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

  function sumRain(days, n){
    return days.slice(0, n).reduce((s, x) => s + x.rain, 0);
  }

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

  /* ---------- Rules — SMS + Voice templates (en/sw only) ---------- */
  const RULES = [
    { id:'heavy_rain', sev:'critical', icon:'🌧',
      label:{en:'Heavy Rain',sw:'Mvua Kubwa'},
      test: d => d.rain >= 45,
      msg:{
        en:(f,d)=>`RAIN ALERT ${f.loc}: ${Math.round(d.rain)}mm ${d.label}. No spraying or fertiliser. Clear drains, stake tall crops now.`,
        sw:(f,d)=>`MVUA KUBWA ${f.loc}: ${Math.round(d.rain)}mm ${d.label}. Usinyunyize dawa wala mbolea. Safisha mifereji, imarisha mimea mirefu.`
      },
      msgVoice:{
        en:(f,d)=>`Rainbrush alert for ${f.loc}. Heavy rain expected ${d.label}, about ${Math.round(d.rain)} millimetres. Do not apply fertiliser or spray today. Clear your drains and support tall crops. Repeating. Heavy rain ${d.label}, ${Math.round(d.rain)} millimetres. No fertiliser or spraying.`,
        sw:(f,d)=>`Tahadhari ya Rainbrush kwa ${f.loc}. Mvua kubwa inatarajiwa ${d.label}, takriban milimita ${Math.round(d.rain)}. Usiweke mbolea wala dawa leo. Safisha mifereji na imarisha mimea mirefu. Ujumbe unarudiwa. Mvua kubwa ${d.label}.`
      }},

    { id:'wind', sev:'critical', icon:'💨',
      label:{en:'High Wind',sw:'Upepo Mkali'},
      test: d => d.wind >= 40,
      msg:{
        en:(f,d)=>`WIND ALERT ${f.loc}: up to ${Math.round(d.wind)}km/h ${d.label}. Secure roofs and tarps, stake tall ${f.crop}. No spraying.`,
        sw:(f,d)=>`UPEPO MKALI ${f.loc}: ${Math.round(d.wind)}km/h ${d.label}. Imarisha paa na maturubai, simamisha ${f.crop}. Usinyunyize.`
      },
      msgVoice:{
        en:(f,d)=>`Rainbrush alert for ${f.loc}. Strong winds up to ${Math.round(d.wind)} kilometres per hour expected ${d.label}. Secure your roof and tarpaulins. Support tall ${f.crop}. Do not spray. Repeating. Strong winds ${d.label}.`,
        sw:(f,d)=>`Tahadhari ya Rainbrush kwa ${f.loc}. Upepo mkali hadi kilomita ${Math.round(d.wind)} kwa saa unatarajiwa ${d.label}. Imarisha paa na maturubai. Simamisha ${f.crop} mirefu. Usinyunyize dawa. Ujumbe unarudiwa.`
      }},

    { id:'frost', sev:'critical', icon:'❄️',
      label:{en:'Frost Risk',sw:'Hatari ya Baridi'},
      test: d => d.tmin <= 3,
      msg:{
        en:(f,d)=>`FROST ALERT ${f.loc}: down to ${Math.round(d.tmin)}C ${d.label} night. Cover seedlings and young ${f.crop}. Water soil this afternoon.`,
        sw:(f,d)=>`BARIDI KALI ${f.loc}: hadi ${Math.round(d.tmin)}C usiku ${d.label}. Funika miche na ${f.crop} changa. Mwagilia udongo mchana.`
      },
      msgVoice:{
        en:(f,d)=>`Rainbrush alert for ${f.loc}. Frost is likely ${d.label} night. Temperatures may drop to ${Math.round(d.tmin)} degrees Celsius. Cover seedlings and young ${f.crop}. Water the soil this afternoon to help retain heat. Repeating. Frost ${d.label} night.`,
        sw:(f,d)=>`Tahadhari ya Rainbrush kwa ${f.loc}. Baridi kali inatarajiwa usiku wa ${d.label}. Joto linaweza kushuka hadi digrii ${Math.round(d.tmin)}. Funika miche na ${f.crop} changa. Mwagilia udongo mchana ili kuhifadhi joto. Ujumbe unarudiwa.`
      }},

    { id:'heat', sev:'warning', icon:'🔥',
      label:{en:'Heat Stress',sw:'Joto Kali'},
      test: d => d.tmax >= 37,
      msg:{
        en:(f,d)=>`HEAT ${f.loc}: high ${Math.round(d.tmax)}C ${d.label}. Irrigate early morning or evening, not midday. Mulch around ${f.crop}.`,
        sw:(f,d)=>`JOTO KALI ${f.loc}: hadi ${Math.round(d.tmax)}C ${d.label}. Mwagilia asubuhi au jioni, sio mchana. Weka majani kwa ${f.crop}.`
      },
      msgVoice:{
        en:(f,d)=>`Rainbrush alert for ${f.loc}. High temperatures of ${Math.round(d.tmax)} degrees Celsius expected ${d.label}. Irrigate early morning or evening, never at midday. Mulch around your ${f.crop} to hold moisture. Repeating. High heat ${d.label}.`,
        sw:(f,d)=>`Tahadhari ya Rainbrush kwa ${f.loc}. Joto kali la digrii ${Math.round(d.tmax)} linatarajiwa ${d.label}. Mwagilia asubuhi mapema au jioni, sio mchana. Weka majani kuzunguka ${f.crop} ili kuhifadhi unyevu. Ujumbe unarudiwa.`
      }},

    { id:'dry', sev:'warning', icon:'🏜',
      label:{en:'Dry Spell',sw:'Kiangazi'},
      test: d => sumRain(d.remaining, 5) < 2.5 && d.tmax >= 30,
      msg:{
        en:(f,d)=>`DRY SPELL ${f.loc}: no rain 5 days, high ${Math.round(d.tmax)}C. Irrigate ${f.crop} now. Mulch to save water.`,
        sw:(f,d)=>`KIANGAZI ${f.loc}: hakuna mvua siku 5, joto ${Math.round(d.tmax)}C. Mwagilia ${f.crop} sasa. Weka majani kuhifadhi maji.`
      },
      msgVoice:{
        en:(f,d)=>`Rainbrush alert for ${f.loc}. No significant rain is expected over the next five days. Highs near ${Math.round(d.tmax)} degrees. Irrigate your ${f.crop} now. Mulch to save water. Repeating. Dry spell ahead.`,
        sw:(f,d)=>`Tahadhari ya Rainbrush kwa ${f.loc}. Hakuna mvua inayotarajiwa kwa siku tano zijazo. Joto hadi digrii ${Math.round(d.tmax)}. Mwagilia ${f.crop} yako sasa. Weka majani kuhifadhi maji. Ujumbe unarudiwa.`
      }},

    { id:'fungal', sev:'advisory', icon:'🍄',
      label:{en:'Fungal Risk',sw:'Hatari ya Ukungu'},
      test: d => d.hum >= 80 && d.tmax >= 18 && d.tmax <= 31 && d.rain > 2,
      msg:{
        en:(f,d)=>`DISEASE RISK ${f.loc}: humidity ${Math.round(d.hum)}%, rain ${Math.round(d.rain)}mm ${d.label}. Check ${f.crop} leaves, remove infected plants.`,
        sw:(f,d)=>`UGONJWA ${f.loc}: unyevu ${Math.round(d.hum)}%, mvua ${Math.round(d.rain)}mm ${d.label}. Kagua majani ya ${f.crop}, ng'oa yaliyoathirika.`
      },
      msgVoice:{
        en:(f,d)=>`Rainbrush alert for ${f.loc}. Fungal disease risk is high ${d.label}. Humidity ${Math.round(d.hum)} percent with ${Math.round(d.rain)} millimetres of rain. Inspect your ${f.crop} leaves today. Remove and destroy any infected plants. Repeating. Disease risk ${d.label}.`,
        sw:(f,d)=>`Tahadhari ya Rainbrush kwa ${f.loc}. Hatari ya ukungu ni kubwa ${d.label}. Unyevu wa asilimia ${Math.round(d.hum)} na mvua milimita ${Math.round(d.rain)}. Kagua majani ya ${f.crop} leo. Ng'oa na choma mimea iliyoathirika. Ujumbe unarudiwa.`
      }},

    { id:'pest', sev:'advisory', icon:'🐛',
      label:{en:'Pest Pressure',sw:'Wadudu'},
      test: d => d.tmax >= 25 && d.tmax <= 33 && d.hum >= 65,
      msg:{
        en:(f,d)=>`PEST RISK ${f.loc}: warm and humid ${d.label}. Scout ${f.crop} at dawn, pick and destroy eggs.`,
        sw:(f,d)=>`WADUDU ${f.loc}: joto na unyevu ${d.label}. Kagua ${f.crop} alfajiri, okota na haribu mayai.`
      },
      msgVoice:{
        en:(f,d)=>`Rainbrush alert for ${f.loc}. Pest pressure is high ${d.label} due to warm and humid conditions. Scout your ${f.crop} at dawn. Pick and destroy any egg masses you find. Repeating. Pest risk ${d.label}.`,
        sw:(f,d)=>`Tahadhari ya Rainbrush kwa ${f.loc}. Wadudu wanaweza kuongezeka ${d.label} kwa sababu ya joto na unyevu. Kagua ${f.crop} yako alfajiri. Okota na haribu mayai. Ujumbe unarudiwa.`
      }},

    { id:'planting', sev:'info', icon:'🌱',
      label:{en:'Planting Window',sw:'Wakati wa Kupanda'},
      test: d => {
        const s = sumRain(d.remaining, 3);
        return s >= 12 && s <= 60;
      },
      msg:{
        en:(f,d)=>`PLANTING ${f.loc}: ${Math.round(sumRain(d.remaining,3))}mm rain in 3 days. Good time to sow ${f.crop}. Plant within 48h of good shower.`,
        sw:(f,d)=>`KUPANDA ${f.loc}: ${Math.round(sumRain(d.remaining,3))}mm mvua siku 3. Wakati mzuri wa kupanda ${f.crop}. Panda saa 48 baada ya mvua.`
      },
      msgVoice:{
        en:(f,d)=>`Rainbrush planting advisory for ${f.loc}. About ${Math.round(sumRain(d.remaining,3))} millimetres of rain is expected over the next three days. This is a good window to sow ${f.crop}. Prepare your seed and plant within forty-eight hours of the first good shower. Repeating.`,
        sw:(f,d)=>`Ushauri wa kupanda kutoka Rainbrush kwa ${f.loc}. Takriban milimita ${Math.round(sumRain(d.remaining,3))} ya mvua inatarajiwa kwa siku tatu zijazo. Huu ni wakati mzuri wa kupanda ${f.crop}. Tayarisha mbegu na panda ndani ya saa arobaini na nane baada ya mvua ya kwanza. Ujumbe unarudiwa.`
      }}
  ];

  /* ---------- Weather ---------- */
  function simulateForecast(loc){
    const rnd = mulberry32(hashStr(loc.name + loc.region));
    const latFactor = Math.abs(loc.lat);
    const baseMax = 34 - latFactor * 0.42 + (rnd() * 5 - 2.5);
    const swing = 8 + rnd() * 5;
    let wet = 0.25 + rnd() * 0.5;
    const days = [];
    const today = new Date();

    for (let i = 0; i < 7; i++){
      wet = clamp(wet + (rnd() - 0.5) * 0.55, 0, 1);
      const dayRnd = mulberry32(hashStr(loc.name + i * 977));
      const tmax = baseMax + (dayRnd() * 4 - 2);
      const tmin = tmax - swing + (dayRnd() * 3 - 1.5);
      const rain = Math.round(Math.pow(wet, 2.6) * 105 * (0.45 + dayRnd() * 0.9));
      const hum  = Math.round(clamp(52 + wet * 40 + dayRnd() * 12, 30, 96));
      const wind = Math.round(8 + dayRnd() * 34 + wet * 12);
      const prob = Math.round(clamp(rain > 0 ? 45 + rain * 0.9 : 12 + dayRnd() * 20, 0, 96));
      const d = new Date(today); d.setDate(d.getDate() + i);
      const iso = d.toISOString().slice(0,10);
      days.push({
        date: iso, label: dayLabel(iso, i), dow: dayLabelShort(iso, i),
        dayNum: d.getDate(), tmax: Math.round(tmax), tmin: Math.round(tmin),
        rain, wind, hum, prob
      });
    }
    return { location: loc.name, region: loc.region, source:'sim', days };
  }

  async function fetchForecast(loc){
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
        + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,precipitation_probability_max`
        + `&hourly=relative_humidity_2m&timezone=auto&forecast_days=7`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 7000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('bad status');

      const j = await res.json();
      if (!j.daily || !j.daily.time) throw new Error('malformed');

      const humByDate = {};
      const hTimes = (j.hourly && j.hourly.time) || [];
      const hVals  = (j.hourly && j.hourly.relative_humidity_2m) || [];
      for (let i = 0; i < hTimes.length; i++){
        const key = hTimes[i].slice(0,10);
        (humByDate[key] = humByDate[key] || []).push(hVals[i]);
      }

      const days = j.daily.time.map((iso, i) => {
        const arr = (humByDate[iso] || []).filter(v => v != null);
        const hum = arr.length ? Math.round(arr.reduce((a,b)=>a+b,0) / arr.length) : 65;
        return {
          date: iso, label: dayLabel(iso, i), dow: dayLabelShort(iso, i),
          dayNum: new Date(iso+'T12:00:00').getDate(),
          tmax: Math.round(j.daily.temperature_2m_max[i] ?? 28),
          tmin: Math.round(j.daily.temperature_2m_min[i] ?? 16),
          rain: Math.round(j.daily.precipitation_sum[i] ?? 0),
          wind: Math.round(j.daily.wind_speed_10m_max[i] ?? 12),
          hum,
          prob: Math.round(j.daily.precipitation_probability_max?.[i] ?? 0)
        };
      });
      if (!days.length) throw new Error('no days');
      return { location: loc.name, region: loc.region, source:'live', days };
    } catch {
      return simulateForecast(loc);
    }
  }

  /* ---------- Alert generation ---------- */
  function generateAlerts(farmers, forecasts){
    const out = [];

    farmers.forEach(f => {
      const fc = forecasts[f.loc];
      if (!fc) return;

      RULES.forEach(rule => {
        let hitIndex = -1;
        for (let i = 0; i < fc.days.length; i++){
          const remaining = fc.days.slice(i);
          const day = fc.days[i];
          const rel = Object.assign({}, day, { label: dayLabel(day.date, i), remaining });
          if (rule.test(rel)){ hitIndex = i; break; }
        }
        if (hitIndex === -1) return;

        const remaining = fc.days.slice(hitIndex);
        const day = fc.days[hitIndex];
        const rel = Object.assign({}, day, { label: dayLabel(day.date, hitIndex), remaining });

        const lang = SUPPORTED_LANGS.includes(f.lang) ? f.lang : 'en';
        const tpl = rule.msg[lang] || rule.msg.en;
        const voiceTpl = rule.msgVoice && (rule.msgVoice[lang] || rule.msgVoice.en);
        const text = tpl(f, rel);
        const voiceText = voiceTpl ? voiceTpl(f, rel) : text;

        out.push({
          id: f.id + '::' + rule.id,
          farmerId: f.id,
          farmer: f,
          rule,
          day: rel,
          dayIndex: hitIndex,
          severity: rule.sev,
          title: (rule.label[lang] || rule.label.en),
          text,
          voiceText
        });
      });
    });

    const order = { critical:0, warning:1, advisory:2, info:3 };
    out.sort((a,b) => (order[a.severity] - order[b.severity]) || (a.dayIndex - b.dayIndex));
    return out;
  }

  return {
    LOCATIONS, CROPS, LANG_NAMES, CROP_COLORS, REGION_TO_DIAL, RULES,
    SUPPORTED_LANGS,
    simulateForecast, fetchForecast, generateAlerts,
    dayLabel, dayLabelShort, sumRain
  };
});