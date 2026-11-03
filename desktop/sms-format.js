'use strict';

/* ==================================================================
   Rainbrush — SMS encoding & segment analysis

   GSM 03.38 basic set = 1 char each. Extension set = 2 chars each.
   Anything outside → UCS-2, which drops segment size to 70.
   ================================================================== */

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

const GSM_EXT = '^{}\\[~]|€';

function analyze(text){
  text = String(text || '');
  if (!text) return { encoding:'GSM-7', chars:0, segments:1, limit:160, gsm7:true, offenders:[] };

  let gsm7 = true;
  let count = 0;
  const offenders = [];

  for (const ch of text){
    if (GSM_BASIC.includes(ch)){ count += 1; }
    else if (GSM_EXT.includes(ch)){ count += 2; }
    else {
      gsm7 = false;
      if (!offenders.includes(ch) && offenders.length < 8) offenders.push(ch);
    }
  }

  if (gsm7){
    const segments = count <= 160 ? 1 : Math.ceil(count / 153);
    return { encoding:'GSM-7', chars:count, segments, limit:160, gsm7:true, offenders:[] };
  }

  const cp = Array.from(text).length;
  const segments = cp <= 70 ? 1 : Math.ceil(cp / 67);
  return { encoding:'UCS-2', chars:cp, segments, limit:70, gsm7:false, offenders };
}

const REPLACEMENTS = [
  [/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-'],
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u2026]/g, '...'],
  [/\u00B0/g, ''],
  [/[\u00A0\u2007\u202F]/g, ' '],
  [/[\u2022\u00B7]/g, '-'],
  [/[\u2009\u200A\u200B\u200C\u200D\uFEFF]/g, ''],
  [/[êë]/g, 'e'], [/[ÊË]/g, 'E'],
  [/[ïî]/g, 'i'], [/[ÏÎ]/g, 'I'],
  [/[ôö]/g, 'o'], [/[ÔÖ]/g, 'O'],
  [/[ûü]/g, 'u'], [/[ÛÜ]/g, 'U'],
  [/[âä]/g, 'a'], [/[ÂÄ]/g, 'A'],
  [/ç/g, 'c'], [/Ç/g, 'C'],
  [/ñ/g, 'n'], [/Ñ/g, 'N'],
  [/œ/g, 'oe'], [/Œ/g, 'OE'],
  [/æ/g, 'ae'], [/Æ/g, 'AE']
];

function sanitize(text){
  const log = [];
  let out = String(text || '');

  REPLACEMENTS.forEach(([re, rep]) => {
    if (re.test(out)){
      log.push(`replaced ${re} with "${rep}"`);
      out = out.replace(re, rep);
    }
  });

  const left = analyze(out);
  if (!left.gsm7){
    log.push(`unmapped characters: ${left.offenders.join(' ')}`);
    out = Array.from(out).map(ch => {
      if (GSM_BASIC.includes(ch) || GSM_EXT.includes(ch)) return ch;
      return '?';
    }).join('');
  }

  return { text: out, changed: out !== text, log };
}

function truncate(text, encoding){
  const budget = encoding === 'GSM-7' ? 160 : 70;
  const arr = encoding === 'GSM-7' ? text.split('') : Array.from(text);
  if (arr.length <= budget) return text;

  let slice = arr.slice(0, budget - 1);
  for (let i = slice.length - 1; i > slice.length - 20 && i > 0; i--){
    if (slice[i] === ' '){ slice = slice.slice(0, i); break; }
  }
  return slice.join('').replace(/[.,;:\s]+$/, '') + '...';
}

module.exports = { analyze, sanitize, truncate, GSM_BASIC, GSM_EXT };

if (typeof window !== 'undefined'){
  window.RainbrushSMS = { analyze, sanitize, truncate };
}