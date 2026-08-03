'use strict';
/* Mein Portfolio – Live-Bewertung via Yahoo Finance (durch CORS-Proxy) */

const LS_POS = 'pf_positions_v1';
const LS_CACHE = 'pf_cache_v1';
const PALETTE = ['#4f8cff','#22c55e','#f59e0b','#ef4444','#a855f7','#14b8a6','#ec4899','#84cc16','#f97316','#06b6d4','#eab308','#8b5cf6'];
const CURRENCIES = ['EUR','USD','GBP','CHF','SEK','NOK','DKK','CAD','AUD','JPY','HKD','CNY','INR','BRL','PLN','CZK','HUF','TRY','KRW','TWD','SGD','ZAR','MXN','NZD'];

let positions = loadPositions();
let quotes = {};   // symbol -> {price, prev, series}
let fx = {};       // currency -> rate (1 CUR = x EUR)
let lastFetch = 0;
let editId = null;
let picked = null; // {symbol,name,exchange}
let deferredInstall = null;

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtNum = v => (Number.isFinite(v) ? v.toLocaleString('de-DE', {maximumFractionDigits: 2, minimumFractionDigits: 2}) : '–');
const fmtInt = v => (Number.isFinite(v) ? v.toLocaleString('de-DE', {maximumFractionDigits: 0}) : '–');
const fmtEur = v => (Number.isFinite(v) ? fmtNum(v) + ' €' : '– €');
const fmtPct = v => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + fmtNum(v) + ' %' : '–');
const signCls = v => (v > 0.004 ? 'pos' : v < -0.004 ? 'neg' : 'flat');
const parseNum = s => { if (s == null) return NaN; s = String(s).trim().replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return Number.isFinite(n) ? n : NaN; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function loadPositions() {
  try { const p = JSON.parse(localStorage.getItem(LS_POS) || '[]'); return Array.isArray(p) ? p : []; }
  catch { return []; }
}
function savePositions() { localStorage.setItem(LS_POS, JSON.stringify(positions)); }
function loadCache() {
  try { return JSON.parse(localStorage.getItem(LS_CACHE) || 'null'); } catch { return null; }
}
function saveCache() {
  localStorage.setItem(LS_CACHE, JSON.stringify({ quotes, fx, at: lastFetch }));
}

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

function neededSymbols() {
  const syms = positions.map(p => p.symbol);
  const curs = [...new Set(positions.map(positionCurrency).filter(c => c && c !== 'EUR'))];
  curs.forEach(c => syms.push('EUR' + c + '=X'));
  return syms;
}

async function refresh() {
  if (!positions.length) { render(); return; }
  setStatus('Kurse werden geladen …');
  try {
    const syms = neededSymbols();
    const url = YAHOO + '/v8/finance/spark?symbols=' + encodeURIComponent(syms.join(',')) + '&range=3mo&interval=1d';
    const j = await fetchViaProxy(url);
    const newQuotes = {};
    for (const [sym, d] of Object.entries(j || {})) {
      const closes = (d && Array.isArray(d.close) ? d.close : []).filter(v => Number.isFinite(v));
      if (!closes.length) continue;
      const price = closes[closes.length - 1];
      const prev = closes.length > 1 ? closes[closes.length - 2] : price;
      newQuotes[sym] = { price, prev, series: closes.slice(-40) };
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
  } catch (e) {
    const c = loadCache();
    if (c && c.quotes) { quotes = c.quotes; fx = c.fx || {}; lastFetch = c.at || 0; render(); }
    setStatus('Kurse konnten nicht geladen werden (Netzwerk?). Zeige Stand von ' + (c && c.at ? new Date(c.at).toLocaleString('de-DE') : 'nie') + '. Tippe auf ↻, um es erneut zu versuchen.');
  }
}

/* ---------- Berechnung ---------- */
function compute() {
  const rows = [];
  let totalEur = 0, costEur = 0, dayEur = 0, missingFx = false;
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
    const pl = localValue != null ? (localValue - localCost) : null;
    const plEur = eurValue != null && eurCost != null ? eurValue - eurCost : null;
    const plPct = localCost > 0 && pl != null ? (pl / localCost) * 100 : null;
    const dayPct = price != null && prev ? (price / prev - 1) * 100 : null;
    const dayAbs = price != null && prev != null ? (price - prev) * p.qty : null;
    if (eurValue != null) totalEur += eurValue;
    if (eurCost != null) costEur += eurCost;
    if (eurValue != null && dayAbs != null) dayEur += (dayAbs / (rate || 1));
    rows.push({ p, i, cur, rate, q, price, prev, localValue, eurValue, localCost, pl, plEur, plPct, dayPct, dayAbs, color: PALETTE[i % PALETTE.length] });
  });
  rows.sort((a, b) => (b.eurValue ?? -1) - (a.eurValue ?? -1));
  const gain = totalEur - costEur;
  const gainPct = costEur > 0 ? (gain / costEur) * 100 : null;
  return { rows, totalEur, costEur, gain, gainPct, dayEur, missingFx };
}

/* ---------- Rendering ---------- */
function render() {
  const c = compute();
  const nowTxt = lastFetch ? new Date(lastFetch).toLocaleString('de-DE') : '–';
  $('lastUpdate').textContent = lastFetch ? 'Kurse vom ' + nowTxt : 'Noch keine Kurse geladen';

  // Zusammenfassung
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

  // Aufteilung
  const aw = $('allocWrap');
  if (c.rows.length && c.totalEur > 0) {
    aw.hidden = false;
    const alloc = $('alloc'); alloc.innerHTML = '';
    c.rows.forEach(r => { if (r.eurValue) { const s = el('div'); s.style.width = (r.eurValue / c.totalEur * 100).toFixed(2) + '%'; s.style.background = r.color; s.title = r.p.name + ': ' + fmtEur(r.eurValue); alloc.appendChild(s); } });
    $('allocNote').textContent = 'Anteile am Gesamtwert';
  } else aw.hidden = true;

  // Liste
  $('posCount').textContent = positions.length;
  $('empty').hidden = positions.length > 0;
  const list = $('list'); list.innerHTML = '';
  c.rows.forEach(r => list.appendChild(rowEl(r)));

  if (c.missingFx) setStatus('Hinweis: Währungskurse für einige Positionen fehlen – Gesamtwert nur teilweise in EUR.', true);
}

function rowEl(r) {
  const row = el('div', 'row');
  const dot = el('span', 'dot');
  dot.style.background = r.color;
  row.appendChild(dot);
  const left = el('div', 'l');
  left.appendChild(el('div', 'name', r.p.name || r.p.symbol));
  const symTxt = r.p.symbol + ' · ' + r.qty + ' × ' + fmtNum(r.p.buyPrice) + ' ' + r.cur;
  left.appendChild(el('div', 'sym', symTxt));
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
    const quotes = (j.quotes || []).filter(x => ['EQUITY','ETF','CRYPTOCURRENCY','FUTURE','MUTUALFUND','INDEX'].includes(x.quoteType)).slice(0, 8);
    res.innerHTML = '';
    if (!quotes.length) { res.innerHTML = '<div class="result rs">Keine Treffer – prüfe Schreibweise oder Symbol (z. B. SAP.DE, AAPL).</div>'; return; }
    quotes.forEach(x => {
      const r = el('div', 'result');
      r.appendChild(el('div', 'rn', x.longname || x.shortname || x.symbol));
      r.appendChild(el('div', 'rs', x.symbol + (x.exchDisp ? ' · ' + x.exchDisp : '')));
      r.addEventListener('click', () => pickResult({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, exchange: x.exchDisp || '' }));
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
    positions.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), symbol: picked.symbol, name: picked.name, exchange: picked.exchange, ...base });
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

/* ---------- Init ---------- */
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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

(function init() {
  const c = loadCache();
  if (c && c.quotes) { quotes = c.quotes; fx = c.fx || {}; lastFetch = c.at || 0; }
  render();
  if (positions.length) refresh();
})();

let lastVisible = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && positions.length && Date.now() - lastVisible > 120000) refresh();
  if (document.visibilityState === 'visible') lastVisible = Date.now();
});
setInterval(() => { if (document.visibilityState === 'visible' && positions.length) refresh(); }, 300000);
