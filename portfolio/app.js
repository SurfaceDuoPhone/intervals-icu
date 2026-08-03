'use strict';
/* Mein Portfolio – Live-Bewertung via Yahoo Finance (durch CORS-Proxy) + neutrale Analyse */

const LS_POS = 'pf_positions_v1';
const LS_CACHE = 'pf_cache_v1';
const PALETTE = ['#4f8cff','#22c55e','#f59e0b','#ef4444','#a855f7','#14b8a6','#ec4899','#84cc16','#f97316','#06b6d4','#eab308','#8b5cf6'];
const INDEX_DAX = '^GDAXI';
const INDEX_WORLD = 'EUNL.DE';

/* ---------- reine Funktionen (testbar) ---------- */
function parseNum(s) {
  if (s == null) return NaN;
  s = String(s).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function defaultCurrency(symbol) {
  const s = String(symbol).toUpperCase();
  const map = {'.DE':'EUR','.PA':'EUR','.AS':'EUR','.BR':'EUR','.BE':'EUR','.MI':'EUR','.MC':'EUR','.VI':'EUR','.LS':'EUR','.IR':'EUR','.HE':'EUR','.L':'GBP','.SW':'CHF','.ST':'SEK','.OL':'NOK','.CO':'DKK','.TO':'CAD','.V':'CAD','.AX':'AUD','.NZ':'NZD','.HK':'HKD','.T':'JPY','.TW':'TWD','.SI':'SGD','.KS':'KRW','.KQ':'KRW','.SS':'CNY','.SZ':'CNY','.NS':'INR','.BO':'INR','.SA':'BRL','.ME':'MXN','.TA':'ILS','.WA':'PLN','.PR':'CZK','.BD':'HUF'};
  for (const [suf, cur] of Object.entries(map)) if (s.endsWith(suf)) return cur;
  if (/-USD$/.test(s)) return 'USD';
  if (/-EUR$/.test(s)) return 'EUR';
  return 'USD';
}

function positionCurrency(p) {
  if (p.currency && p.currency !== 'AUTO') return p.currency;
  return defaultCurrency(p.symbol);
}

function annualVol(closes) {
  if (!Array.isArray(closes) || closes.length < 4) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (Number.isFinite(closes[i]) && Number.isFinite(closes[i - 1]) && closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
  }
  if (rets.length < 3) return null;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
  return v * Math.sqrt(252) * 100;
}

function interp(arr, t) {
  let v = null;
  for (const pt of arr) { if (pt.t <= t) v = pt.v; else break; }
  return v;
}

function compute(positions, quotes, fx) {
  const rows = [];
  let totalEur = 0, costEur = 0, dayEur = 0, missingFx = false, missingDates = 0;
  positions.forEach((p, i) => {
    const q = quotes[p.symbol];
    const cur = positionCurrency(p);
    const rate = cur === 'EUR' ? 1 : (fx[cur] || null);
    if (cur !== 'EUR' && !rate) missingFx = true;
    const price = q ? q.price : null;
    const prev = q ? q.prev : null;
    const localValue = price != null ? price * p.qty : null;
    const eurValue = localValue != null && rate ? localValue / rate : (localValue != null && cur === 'EUR' ? localValue : null);
    const localCost = p.buyPrice * p.qty;
    const eurCost = rate ? localCost / rate : (cur === 'EUR' ? localCost : null);
    const pl = localValue != null ? localValue - localCost : null;
    const plEur = eurValue != null && eurCost != null ? eurValue - eurCost : null;
    const plPct = localCost > 0 && pl != null ? (pl / localCost) * 100 : null;
    const dayPct = price != null && prev ? (price / prev - 1) * 100 : null;
    const dayAbs = price != null && prev != null ? (price - prev) * p.qty : null;
    let years = null, cagr = null;
    if (p.buyDate) {
      years = (Date.now() - new Date(p.buyDate + 'T00:00:00').getTime()) / 31556952000;
      if (years > 0.5 && plPct != null) cagr = (Math.pow(1 + plPct / 100, 1 / years) - 1) * 100;
    } else missingDates++;
    if (eurValue != null) totalEur += eurValue;
    if (eurCost != null) costEur += eurCost;
    if (eurValue != null && dayAbs != null) dayEur += dayAbs / (rate || 1);
    rows.push({
      p, i, cur, rate, q, price, prev, localValue, eurValue, localCost, pl, plEur, plPct,
      dayPct, dayAbs, years, cagr,
      vol: q ? annualVol(q.series) : null,
      color: PALETTE[i % PALETTE.length]
    });
  });
  rows.sort((a, b) => (b.eurValue ?? -1) - (a.eurValue ?? -1));
  const total = totalEur;
  rows.forEach(r => { r.weight = total > 0 && r.eurValue != null ? r.eurValue / total : null; });
  const gain = totalEur - costEur;
  const gainPct = costEur > 0 ? (gain / costEur) * 100 : null;

  // Währungs- und Branchenverteilung
  const curShares = {};
  rows.forEach(r => { if (r.eurValue != null) curShares[r.cur] = (curShares[r.cur] || 0) + r.eurValue; });
  const secShares = {};
  rows.forEach(r => { if (r.eurValue != null) { const s = sectorLabel(r.p); secShares[s] = (secShares[s] || 0) + r.eurValue; } });
  const secSharesSorted = Object.entries(secShares).map(([name, val]) => ({ name, share: total > 0 ? val / total : 0 })).sort((a, b) => b.share - a.share);

  // Verlauf + Volatilität Portfolio
  const series = buildPortfolioSeries(positions, quotes, fx);
  let volPct = null;
  if (series && series.length > 4) {
    const rets = [];
    for (let i = 1; i < series.length; i++) if (series[i - 1].val > 0) rets.push(series[i].val / series[i - 1].val - 1);
    if (rets.length >= 3) {
      const m = rets.reduce((a, b) => a + b, 0) / rets.length;
      volPct = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252) * 100;
    }
  }

  // Index-Vergleich
  const cmp = buildCompare(positions, quotes, series);

  // Rendite p. a. (Portfolio)
  const datedVal = rows.reduce((a, r) => a + (r.years != null && r.eurValue != null ? r.eurValue : 0), 0);
  const weightedYears = rows.reduce((a, r) => a + (r.years != null && r.eurValue != null ? r.years * r.eurValue : 0), 0) / (datedVal || 1);
  let cagrPort = null;
  if (datedVal / (total || 1) >= 0.5 && weightedYears > 0.5 && gainPct != null) cagrPort = (Math.pow(1 + gainPct / 100, 1 / weightedYears) - 1) * 100;

  return { rows, totalEur, costEur, gain, gainPct, dayEur, missingFx, missingDates, curShares, secSharesSorted, series, volPct, cmp, cagrPort, weightedYears };
}

function sectorLabel(p) {
  if (p.type === 'ETF' || p.type === 'MUTUALFUND') return 'ETF / Indexfonds';
  return p.sector || 'Unbekannt';
}

function buildPortfolioSeries(positions, quotes, fx) {
  const bySym = {};
  let usable = 0;
  positions.forEach(p => {
    const q = quotes[p.symbol];
    if (!q || !q.ts || !q.ts.length) return;
    const cur = positionCurrency(p);
    const rate = cur === 'EUR' ? 1 : (fx[cur] || null);
    if (!rate) return;
    bySym[p.symbol] = q.ts.map((t, i) => ({ t, v: q.closeArr[i] / rate * p.qty }));
    usable++;
  });
  if (!usable) return null;
  const tsSet = new Set();
  Object.values(bySym).forEach(pts => pts.forEach(pt => tsSet.add(pt.t)));
  const days = [...tsSet].sort((a, b) => a - b);
  const series = [];
  days.forEach(t => {
    let val = 0;
    for (const p of positions) {
      const pts = bySym[p.symbol];
      if (!pts) return;
      const v = interp(pts, t);
      if (v == null) return;
      val += v;
    }
    series.push({ t, val });
  });
  return series.length > 5 ? series.slice(-60) : (series.length ? series : null);
}

function buildCompare(positions, quotes, portSeries) {
  if (!portSeries || portSeries.length < 2) return null;
  const lines = [];
  const mk = (sym, name, color, isPort) => {
    let arr;
    if (isPort) {
      const v0 = portSeries[0].val;
      arr = portSeries.map(d => ({ t: d.t, v: d.val / v0 * 100 }));
    } else {
      const q = quotes[sym];
      if (!q || !q.ts || q.ts.length < 2) return;
      const v0 = q.closeArr[0];
      if (!v0) return;
      arr = q.ts.map((t, i) => ({ t, v: q.closeArr[i] / v0 * 100 }));
    }
    lines.push({ name, color, arr });
  };
  mk(null, 'Portfolio', '#4f8cff', true);
  mk(INDEX_DAX, 'DAX', '#22c55e', false);
  mk(INDEX_WORLD, 'MSCI World (EUNL)', '#eab308', false);
  if (!lines.length) return null;
  const start = Math.max(...lines.map(l => l.arr[0].t));
  const end = Math.min(...lines.map(l => l.arr[l.arr.length - 1].t));
  if (start >= end) return null;
  const days = portSeries.map(d => d.t).filter(t => t >= start && t <= end);
  if (days.length < 2) return null;
  const perf = lines.map(l => {
    const v0 = interp(l.arr, start), v1 = interp(l.arr, end);
    return { name: l.name, color: l.color, p: v0 && v1 ? (v1 / v0 - 1) * 100 : null };
  });
  return { days, lines, perf };
}

/* ---------- UI-Helfer ---------- */
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = v => (Number.isFinite(v) ? v.toLocaleString('de-DE', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : '–');
const fmtEur = v => (Number.isFinite(v) ? fmtNum(v) + ' €' : '– €');
const fmtPct = v => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + fmtNum(v) + ' %' : '–');
const signCls = v => (v > 0.004 ? 'pos' : v < -0.004 ? 'neg' : 'flat');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Zustand ---------- */
let positions = loadPositions();
let quotes = {};
let fx = {};
let lastFetch = 0;
let editId = null;
let picked = null;
let deferredInstall = null;

function loadPositions() {
  try { const p = JSON.parse(localStorage.getItem(LS_POS) || '[]'); return Array.isArray(p) ? p : []; }
  catch { return []; }
}
function savePositions() { localStorage.setItem(LS_POS, JSON.stringify(positions)); }
function loadCache() { try { return JSON.parse(localStorage.getItem(LS_CACHE) || 'null'); } catch { return null; } }
function saveCache() { localStorage.setItem(LS_CACHE, JSON.stringify({ quotes, fx, at: lastFetch })); }

/* ---------- Kurse ---------- */
const YAHOO = 'https://query1.finance.yahoo.com';
async function fetchViaProxy(url, tries = 0) {
  const proxies = [
    u => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
    u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  ];
  const idx = tries % proxies.length;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(proxies[idx](url), { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    clearTimeout(t);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (j && j.error) throw new Error(j.error);
    return j;
  } catch (e) {
    if (tries < proxies.length * 2) { await sleep(400); return fetchViaProxy(url, tries + 1); }
    throw e;
  }
}

function neededSymbols() {
  const syms = new Set(positions.map(p => p.symbol));
  positions.map(positionCurrency).filter(c => c && c !== 'EUR').forEach(c => syms.add('EUR' + c + '=X'));
  if (positions.length) { syms.add(INDEX_DAX); syms.add(INDEX_WORLD); }
  return [...syms];
}

async function refresh() {
  if (!positions.length) { render(); return; }
  setStatus('Kurse werden geladen …');
  try {
    const url = YAHOO + '/v8/finance/spark?symbols=' + encodeURIComponent(neededSymbols().join(',')) + '&range=3mo&interval=1d';
    const j = await fetchViaProxy(url);
    const newQuotes = {};
    for (const [sym, d] of Object.entries(j || {})) {
      const closes = (d && Array.isArray(d.close) ? d.close : []).filter(v => Number.isFinite(v));
      const ts = (d && Array.isArray(d.timestamp) ? d.timestamp : []);
      const n = Math.min(closes.length, ts.length);
      if (!n) continue;
      const from = Math.max(0, n - 60);
      newQuotes[sym] = {
        price: closes[n - 1],
        prev: n > 1 ? closes[n - 2] : closes[n - 1],
        series: closes.slice(from),
        ts: ts.slice(from),
        closeArr: closes.slice(from),
      };
    }
    const newFx = {};
    for (const [sym, q] of Object.entries(newQuotes)) {
      const m = /^EUR([A-Z]{3})=X$/.exec(sym);
      if (m) newFx[m[1]] = q.price;
    }
    quotes = newQuotes;
    fx = { ...fx, ...newFx };
    lastFetch = Date.now();
    saveCache();
    render();
    setStatus('Aktualisiert: ' + new Date().toLocaleTimeString('de-DE'));
    enrichSectors();
  } catch (e) {
    const c = loadCache();
    if (c && c.quotes) { quotes = c.quotes; fx = c.fx || {}; lastFetch = c.at || 0; render(); }
    setStatus('Kurse konnten nicht geladen werden. Zeige Stand von ' + (c && c.at ? new Date(c.at).toLocaleString('de-DE') : 'nie') + '. Tippe auf ↻ für einen neuen Versuch.');
  }
}

async function enrichSectors() {
  const need = positions.filter(p => !p.sector || !p.type);
  if (!need.length) return;
  let changed = false;
  for (const p of need.slice(0, 12)) {
    try {
      const url = YAHOO + '/v1/finance/search?q=' + encodeURIComponent(p.symbol) + '&quotesCount=1&newsCount=0';
      const j = await fetchViaProxy(url);
      const q0 = (j.quotes || []).find(x => x.symbol === p.symbol) || (j.quotes || [])[0];
      if (q0) { p.sector = q0.sector || null; p.type = q0.quoteType || null; changed = true; }
    } catch (e) { /* stillen Fehler ignorieren */ }
    await sleep(150);
  }
  if (changed) { savePositions(); render(); }
}

/* ---------- Rendering ---------- */
function render() {
  const c = compute(positions, quotes, fx);
  $('lastUpdate').textContent = lastFetch ? 'Kurse vom ' + new Date(lastFetch).toLocaleString('de-DE') : 'Noch keine Kurse geladen';

  $('totalValue').textContent = fmtEur(c.totalEur);
  const plEl = $('totalPl');
  if (c.gainPct != null) { plEl.textContent = fmtEur(c.gain) + ' (' + fmtPct(c.gainPct) + ')'; plEl.className = 'sub ' + signCls(c.gain); }
  else { plEl.textContent = '–'; plEl.className = 'sub'; }
  const dayAbs = $('dayAbs'), dayPct = $('dayPct');
  dayAbs.textContent = fmtEur(c.dayEur);
  dayAbs.className = 'big sm ' + signCls(c.dayEur);
  dayPct.textContent = '≈ ' + fmtPct(c.totalEur ? (c.dayEur / c.totalEur) * 100 : null);
  dayPct.className = 'sub ' + signCls(c.dayEur);
  $('gainAbs').textContent = fmtEur(c.gain);
  $('gainAbs').className = 'big sm ' + signCls(c.gain);
  $('gainPct').textContent = c.gainPct != null ? fmtPct(c.gainPct) : '–';
  $('gainPct').className = 'sub ' + signCls(c.gain);

  const aw = $('allocWrap');
  if (c.rows.length && c.totalEur > 0) {
    aw.hidden = false;
    const alloc = $('alloc'); alloc.innerHTML = '';
    c.rows.forEach(r => { if (r.eurValue) { const s = el('div'); s.style.width = (r.eurValue / c.totalEur * 100).toFixed(2) + '%'; s.style.background = r.color; s.title = r.p.name + ': ' + fmtEur(r.eurValue); alloc.appendChild(s); } });
    $('allocNote').textContent = 'Anteile am Gesamtwert';
  } else aw.hidden = true;

  $('posCount').textContent = positions.length;
  $('empty').hidden = positions.length > 0;
  const list = $('list'); list.innerHTML = '';
  c.rows.forEach(r => list.appendChild(rowEl(r)));

  renderAnalysis(c);
  if (c.missingFx) setStatus('Hinweis: Währungskurse für einige Positionen fehlen – Gesamtwert nur teilweise in EUR.', true);
}

function rowEl(r) {
  const row = el('div', 'row');
  const dot = el('span', 'dot');
  dot.style.background = r.color;
  row.appendChild(dot);
  const left = el('div', 'l');
  left.appendChild(el('div', 'name', r.p.name || r.p.symbol));
  left.appendChild(el('div', 'sym', r.p.symbol + ' · ' + r.p.qty + ' × ' + fmtNum(r.p.buyPrice) + ' ' + r.cur));
  const vals = el('div', 'vals');
  vals.appendChild(el('div', 'v', r.eurValue != null ? fmtEur(r.eurValue) : (r.localValue != null ? fmtNum(r.localValue) + ' ' + r.cur : '–')));
  const d = el('div', 'd ' + signCls(r.plEur ?? r.pl));
  d.textContent = (r.plEur != null ? fmtEur(r.plEur) : (r.pl != null ? fmtNum(r.pl) + ' ' + r.cur : '–')) + (r.plPct != null ? ' (' + fmtPct(r.plPct) + ')' : '');
  vals.appendChild(d);
  if (r.dayPct != null) { const d2 = el('div', 'd ' + signCls(r.dayPct)); d2.textContent = 'Heute ' + fmtPct(r.dayPct); vals.appendChild(d2); }
  row.appendChild(left); row.appendChild(vals);
  if (r.q && r.q.series && r.q.series.length > 1) row.appendChild(sparkEl(r.q.series, r.dayPct ?? 0));
  else row.appendChild(el('span', 'spark'));
  row.addEventListener('click', () => openEdit(r.p));
  return row;
}

function sparkEl(series, dayPct) {
  const w = 64, h = 24, pad = 1;
  const n = series.length;
  const min = Math.min(...series), max = Math.max(...series);
  const span = (max - min) || 1;
  const pts = series.map((v, i) => {
    const x = pad + (i / (n - 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / span) * (h - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 24');
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('points', pts);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', dayPct > 0.004 ? '#22c55e' : dayPct < -0.004 ? '#ef4444' : '#8b93a7');
  poly.setAttribute('stroke-width', '2');
  poly.setAttribute('stroke-linejoin', 'round');
  poly.setAttribute('stroke-linecap', 'round');
  svg.appendChild(poly);
  const wrap = el('span', 'spark'); wrap.appendChild(svg);
  return wrap;
}

function renderAnalysis(c) {
  const wrap = $('analysisWrap');
  if (!c.rows.length) { wrap.hidden = true; return; }
  wrap.hidden = false;

  // Zusammenfassung
  const top = c.rows[0];
  const parts = [];
  parts.push(c.rows.length + (c.rows.length === 1 ? ' Position' : ' Positionen'));
  if (top && top.weight != null) parts.push('Top: ' + top.p.name + ' ' + fmtPct(top.weight * 100));
  if (c.gainPct != null) parts.push('Rendite ' + fmtPct(c.gainPct));
  if (c.volPct != null) parts.push('Volatilität ' + fmtPct(c.volPct) + ' p. a.');
  $('analysisSummary').textContent = parts.join(' · ');

  // Flags
  const flags = buildFlags(c);
  const fBox = $('flags'); fBox.innerHTML = '';
  flags.forEach(f => {
    const row = el('div', 'flag ' + f.lvl);
    row.appendChild(el('span', 'flagdot'));
    row.appendChild(el('span', 'flagtxt', f.txt));
    fBox.appendChild(row);
  });

  // Kennzahlen
  $('anGain').textContent = c.gainPct != null ? fmtPct(c.gainPct) : '–';
  $('anGain').className = 'big sm ' + signCls(c.gain);
  $('anGainSub').textContent = fmtEur(c.gain) + ' auf ' + fmtEur(c.costEur) + ' Einkauf';
  $('anCagr').textContent = c.cagrPort != null ? fmtPct(c.cagrPort) : '–';
  $('anCagrSub').textContent = c.cagrPort != null ? '≈ ' + c.weightedYears.toFixed(1) + ' J. Ø Haltedauer' : (c.missingDates ? 'Kaufdaten fehlen' : 'Haltedauer < 6 Monate');
  $('anVol').textContent = c.volPct != null ? fmtPct(c.volPct) : '–';
  const volCls = c.volPct == null ? 'flat' : c.volPct > 30 ? 'neg' : c.volPct > 20 ? 'flat' : 'pos';
  $('anVol').className = 'big sm ' + volCls;
  $('anVolSub').textContent = 'Jährlich, aus 3-Monats-Verlauf';

  // Währungen
  const curEntries = Object.entries(c.curShares).sort((a, b) => b[1] - a[1]);
  barFill($('curBar'), curEntries.map(([k, v]) => ({ name: k, val: v / (c.totalEur || 1) })), PALETTE);
  legendFill($('curLegend'), curEntries.map(([k, v]) => ({ name: k, val: v / (c.totalEur || 1) })), PALETTE);

  // Branchen
  barFill($('secBar'), c.secSharesSorted.map(s => ({ name: s.name, val: s.share })), PALETTE);
  legendFill($('secLegend'), c.secSharesSorted.map(s => ({ name: s.name, val: s.share })), PALETTE);

  // Index-Vergleich
  if (c.cmp) {
    drawCompare($('cmpChart'), c.cmp);
    const leg = $('cmpLegend'); leg.innerHTML = '';
    c.cmp.perf.forEach(p => {
      const item = el('span', 'legitem');
      item.appendChild(el('span', 'legdot')).style.background = p.color;
      item.appendChild(document.createTextNode(p.name + ' ' + fmtPct(p.p)));
      leg.appendChild(item);
    });
    $('cmpPerf').textContent = '3 Monate (Start = 100) · Portfolio inkl. heutiger Bestände, ohne Käufe/Verkäufe · Währungskurse konstant';
  } else {
    $('cmpChart').innerHTML = '<div class="sub muted">Kein Verlauf verfügbar (Kurse nicht vollständig geladen).</div>';
    $('cmpLegend').innerHTML = '';
    $('cmpPerf').textContent = '';
  }

  // Detailtabelle
  const t = $('anTable'); t.innerHTML = '';
  c.rows.forEach(r => {
    const row = el('div', 'anrow');
    const dot = el('span', 'dot'); dot.style.background = r.color; row.appendChild(dot);
    const mid = el('div', 'anmid');
    mid.appendChild(el('div', 'anname', r.p.name || r.p.symbol));
    const volTxt = r.vol != null ? fmtPct(r.vol) + ' p. a.' : '–';
    const cagrTxt = r.cagr != null ? fmtPct(r.cagr) + ' p. a.' : '–';
    mid.appendChild(el('div', 'ansub muted', 'Vol ' + volTxt + ' · ' + (r.p.buyDate ? 'seit ' + r.p.buyDate : 'ohne Kaufdatum')));
    const right = el('div', 'anright');
    right.appendChild(el('div', 'anval', r.weight != null ? fmtPct(r.weight * 100) : '–'));
    right.appendChild(el('div', 'ansub ' + signCls(r.cagr ?? r.plPct), cagrTxt));
    row.appendChild(mid); row.appendChild(right);
    row.appendChild(ampel(r));
    t.appendChild(row);
  });
}

function buildFlags(c) {
  const flags = [];
  if (!c.rows.length) return flags;
  const top = c.rows[0];
  if (top.weight != null && top.weight > 0.25) flags.push({ lvl: 'red', txt: 'Klumpenrisiko: ' + top.p.name + ' macht ' + fmtPct(top.weight * 100) + ' des Portfolios aus' });
  else if (top.weight != null && top.weight >= 0.10) flags.push({ lvl: 'yellow', txt: 'Größte Position: ' + top.p.name + ' mit ' + fmtPct(top.weight * 100) });
  if (c.rows.length < 5) flags.push({ lvl: 'yellow', txt: 'Nur ' + c.rows.length + ' Position' + (c.rows.length === 1 ? '' : 'en') + ' – geringe Streuung' });
  const nonEur = 1 - (c.curShares['EUR'] || 0) / (c.totalEur || 1);
  if (nonEur > 0.4) flags.push({ lvl: 'yellow', txt: 'Währungsrisiko: ' + fmtPct(nonEur * 100) + ' des Portfolios liegt nicht in EUR' });
  const topSec = c.secSharesSorted[0];
  if (topSec && topSec.share > 0.5) flags.push({ lvl: 'yellow', txt: 'Branchen-Klumpen: ' + topSec.name + ' macht ' + fmtPct(topSec.share * 100) + ' aus' });
  const highVol = c.rows.filter(r => r.vol != null && r.vol > 35);
  if (highVol.length) flags.push({ lvl: 'yellow', txt: 'Hohe Kursschwankung (Volatilität > 35 % p. a.): ' + highVol.map(r => r.p.name).join(', ') });
  if (c.missingDates > 0) flags.push({ lvl: 'grey', txt: 'Kaufdatum fehlt bei ' + c.missingDates + ' Position' + (c.missingDates > 1 ? 'en' : '') + ' – Rendite p. a. dadurch unvollständig' });
  if (!flags.length) flags.push({ lvl: 'green', txt: 'Keine auffälligen Risiken erkannt (neutrale Betrachtung)' });
  return flags;
}

function ampel(r) {
  const box = el('span', 'ampel');
  const dots = [];
  let w = r.weight != null ? r.weight : 0;
  dots.push(w > 0.25 ? 'red' : w >= 0.10 ? 'yellow' : 'green');
  let v = r.vol != null ? r.vol : 0;
  dots.push(v > 35 ? 'red' : v > 20 ? 'yellow' : 'green');
  dots.forEach(d => { const s = el('span', 'adot ' + d); box.appendChild(s); });
  box.title = 'Punkte: Positionsgewicht · Volatilität';
  return box;
}

function barFill(container, items, palette) {
  container.innerHTML = '';
  if (!items.length) return;
  items.forEach((it, i) => {
    if (it.val > 0.005) { const s = el('div'); s.style.width = (it.val * 100).toFixed(1) + '%'; s.style.background = palette[i % palette.length]; s.title = it.name + ': ' + fmtPct(it.val * 100); container.appendChild(s); }
  });
}

function legendFill(container, items, palette) {
  container.innerHTML = '';
  items.forEach((it, i) => {
    const item = el('span', 'legitem');
    const d = el('span', 'legdot'); d.style.background = palette[i % palette.length]; item.appendChild(d);
    item.appendChild(document.createTextNode(it.name + ' ' + fmtPct(it.val * 100)));
    container.appendChild(item);
  });
}

function drawCompare(container, cmp) {
  const w = 320, h = 130, padL = 6, padR = 8, padT = 6, padB = 8;
  let min = Infinity, max = -Infinity;
  cmp.lines.forEach(l => l.arr.forEach(p => { if (Number.isFinite(p.v)) { min = Math.min(min, p.v); max = Math.max(max, p.v); } }));
  if (!Number.isFinite(min) || min === max) { container.innerHTML = '<div class="sub muted">Zu wenig Daten für den Verlauf.</div>'; return; }
  const span = (max - min) || 1;
  const n = cmp.days.length;
  const X = i => padL + (i / (n - 1)) * (w - padL - padR);
  const Y = v => padT + (1 - (v - min) / span) * (h - padT - padB);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 320 130');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'cmpchart');
  // Raster
  [0.25, 0.5, 0.75].forEach(f => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', padL); line.setAttribute('x2', w - padR);
    line.setAttribute('y1', Y(min + span * f)); line.setAttribute('y2', Y(min + span * f));
    line.setAttribute('stroke', '#2a3550'); line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
  });
  cmp.lines.forEach(l => {
    const pts = l.arr.filter(p => Number.isFinite(p.v) && p.t >= cmp.days[0] && p.t <= cmp.days[n - 1])
      .map(p => X(cmp.days.indexOf(p.t)) + ',' + Y(p.v)).join(' ');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', l.color);
    poly.setAttribute('stroke-width', '2');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('stroke-linecap', 'round');
    svg.appendChild(poly);
  });
  container.innerHTML = '';
  container.appendChild(svg);
}

function setStatus(txt, sticky) {
  const s = $('status');
  s.hidden = !txt;
  s.textContent = txt || '';
  if (!sticky && txt) setTimeout(() => { if (s.textContent === txt) s.hidden = true; }, 4000);
}

/* ---------- Suche ---------- */
let searchSeq = 0;
async function doSearch(q) {
  q = q.trim();
  const res = $('searchResults');
  if (q.length < 2) { res.hidden = true; res.innerHTML = ''; return; }
  const seq = ++searchSeq;
  res.hidden = false;
  res.innerHTML = '<div class="result rs">Suche …</div>';
  try {
    const url = YAHOO + '/v1/finance/search?q=' + encodeURIComponent(q) + '&quotesCount=10&newsCount=0';
    const j = await fetchViaProxy(url);
    if (seq !== searchSeq) return;
    const qs = (j.quotes || []).filter(x => ['EQUITY', 'ETF', 'CRYPTOCURRENCY', 'FUTURE', 'MUTUALFUND', 'INDEX'].includes(x.quoteType)).slice(0, 8);
    res.innerHTML = '';
    if (!qs.length) { res.innerHTML = '<div class="result rs">Keine Treffer – prüfe Schreibweise oder Symbol (z. B. SAP.DE, AAPL).</div>'; return; }
    qs.forEach(x => {
      const r = el('div', 'result');
      r.appendChild(el('div', 'rn', x.longname || x.shortname || x.symbol));
      r.appendChild(el('div', 'rs', x.symbol + (x.exchDisp ? ' · ' + x.exchDisp : '')));
      r.addEventListener('click', () => pickResult({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, exchange: x.exchDisp || '', sector: x.sector || null, type: x.quoteType || null }));
      res.appendChild(r);
    });
  } catch {
    if (seq === searchSeq) res.innerHTML = '<div class="result rs">Suche fehlgeschlagen – bitte erneut versuchen.</div>';
  }
}

function pickResult(p) {
  picked = p;
  $('searchResults').hidden = true;
  $('pickBox').hidden = false;
  $('pickInfo').innerHTML = '<span class="pn">' + esc(p.name) + '</span><br><span class="ps">' + esc(p.symbol) + (p.exchange ? ' · ' + esc(p.exchange) : '') + '</span>';
  $('fCur').value = 'AUTO';
  $('fQty').focus();
}

/* ---------- Formular ---------- */
function openSheet(title) {
  $('sheetTitle').textContent = title;
  $('sheetBackdrop').hidden = false;
  $('sheet').hidden = false;
}
function closeSheet() {
  $('sheet').hidden = true;
  $('sheetBackdrop').hidden = true;
  editId = null; picked = null;
  $('searchInput').value = '';
  $('searchResults').hidden = true; $('searchResults').innerHTML = '';
  $('pickBox').hidden = true;
  $('fQty').value = ''; $('fPrice').value = ''; $('fDate').value = '';
  $('deleteBtn').hidden = true;
  $('searchBox').hidden = false;
}
function openAdd() { editId = null; openSheet('Position hinzufügen'); $('searchInput').focus(); }
function openEdit(p) {
  editId = p.id;
  picked = { symbol: p.symbol, name: p.name, exchange: p.exchange || '' };
  openSheet('Position bearbeiten');
  $('searchBox').hidden = true;
  $('pickBox').hidden = false;
  $('pickInfo').innerHTML = '<span class="pn">' + esc(p.name) + '</span><br><span class="ps">' + esc(p.symbol) + '</span>';
  $('fQty').value = String(p.qty).replace('.', ',');
  $('fPrice').value = String(p.buyPrice).replace('.', ',');
  $('fDate').value = p.buyDate || '';
  $('fCur').value = p.currency || 'AUTO';
  $('deleteBtn').hidden = false;
}
function savePosition() {
  const qty = parseNum($('fQty').value);
  const price = parseNum($('fPrice').value);
  const cur = $('fCur').value || 'AUTO';
  if (editId == null && !picked) { setStatus('Bitte zuerst eine Aktie auswählen.', true); return; }
  if (!Number.isFinite(qty) || qty <= 0) { setStatus('Bitte gültige Stückzahl eingeben.', true); return; }
  if (!Number.isFinite(price) || price <= 0) { setStatus('Bitte gültigen Einkaufskurs eingeben.', true); return; }
  const base = {
    qty: Math.round(qty * 10000) / 10000,
    buyPrice: Math.round(price * 10000) / 10000,
    buyDate: $('fDate').value || null,
    currency: cur,
  };
  if (editId != null) {
    const idx = positions.findIndex(x => x.id === editId);
    if (idx >= 0) positions[idx] = { ...positions[idx], ...base };
  } else {
    positions.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), symbol: picked.symbol, name: picked.name, exchange: picked.exchange || '', sector: picked.sector || null, type: picked.type || null, ...base });
  }
  savePositions();
  closeSheet();
  render();
  refresh();
}
function deletePosition() {
  if (editId == null) return;
  positions = positions.filter(x => x.id !== editId);
  savePositions();
  closeSheet();
  render();
  refresh();
}

/* ---------- Init (nur im Browser) ---------- */
if (typeof document !== 'undefined' && document.getElementById) {
  $('addBtn').addEventListener('click', openAdd);
  $('closeSheet').addEventListener('click', closeSheet);
  $('sheetBackdrop').addEventListener('click', closeSheet);
  $('refreshBtn').addEventListener('click', () => refresh());
  $('saveBtn').addEventListener('click', savePosition);
  $('deleteBtn').addEventListener('click', deletePosition);

  let debounceT = null;
  $('searchInput').addEventListener('input', e => {
    clearTimeout(debounceT);
    const v = e.target.value;
    debounceT = setTimeout(() => doSearch(v), 350);
  });
  $('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(e.target.value); } });
  $('fQty').addEventListener('keydown', e => { if (e.key === 'Enter') $('fPrice').focus(); });
  $('fPrice').addEventListener('keydown', e => { if (e.key === 'Enter') savePosition(); });

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstall = e;
    $('installBtn').hidden = false;
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $('installBtn').hidden = true;
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  (function init() {
    const c = loadCache();
    if (c && c.quotes) { quotes = c.quotes; fx = c.fx || {}; lastFetch = c.at || 0; }
    render();
    if (positions.length) { refresh(); enrichSectors(); }
  })();

  let lastVisible = Date.now();
  document.addEventListener('visibilitychange', () => {
    const now = Date.now();
    if (document.visibilityState === 'visible' && positions.length && now - lastVisible > 120000) refresh();
    if (document.visibilityState === 'visible') lastVisible = now;
  });
  setInterval(() => { if (document.visibilityState === 'visible' && positions.length) refresh(); }, 300000);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { compute, defaultCurrency, positionCurrency, annualVol, parseNum, buildPortfolioSeries, buildCompare, sectorLabel };
}
