// Fake Apps Script environment (Telegram, Gemini, Sheets, Calendar, Maps) for running Code.gs in Node.
// Run a suite with: node tests/core.js   (or: for f in tests/*.test.js; do node "$f"; done)
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const log = [], tg = [], events = [], geminiCalls = []; let geminiQueue = []; let msgSeq = 1000;
let CtxDate = Date;
function parts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'long', timeZoneName: 'short' });
  const o = {}; f.formatToParts(date).forEach(p => o[p.type] = p.value); if (o.hour === '24') o.hour = '00'; return o;
}
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const Utilities = {
  formatDate(d, tz, pat) {
    const p = parts(d, tz); const h = +p.hour; const m = MONTHS[+p.month - 1];
    return pat.replace(/EEEE|EEE|MMMM|MMM|yyyy|MM|dd|HH|mm|h|a|z|d/g, t => ({ EEEE: p.weekday, EEE: p.weekday.slice(0, 3), MMMM: m, MMM: m.slice(0, 3), yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, h: String(h % 12 || 12), a: h < 12 ? 'AM' : 'PM', z: p.timeZoneName, d: String(+p.day) })[t]);
  },
  parseDate(str, tz) {
    const [d, t] = str.split(' '); const [Y, M, D] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number);
    let g = Date.UTC(Y, M - 1, D, hh, mm);
    for (let i = 0; i < 3; i++) { const p = parts(new Date(g), tz); g += Date.UTC(Y, M - 1, D, hh, mm) - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute); }
    return new Date(g);
  },
  getUuid() { return 'abcd' + (msgSeq++) + 'xyz'; },
  base64Encode() { return 'BASE64'; }
};
const store = {};
const PropertiesService = { getScriptProperties: () => ({
  getProperty: k => k in store ? store[k] : null,
  setProperty: (k, v) => { if (String(v).length > 9000) throw new Error('property too big: ' + k); store[k] = String(v); },
  deleteProperty: k => { delete store[k]; }, getProperties: () => Object.assign({}, store) }) };
const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {}, tryLock() { return true; } }) };
const Logger = { log: s => log.push(String(s)) };
const ContentService = { createTextOutput: s => s };
const asCell = x => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) ? new CtxDate(x + 'T00:00:00-06:00') : x;
const order = [], sheets = {};
function makeSheet(name) {
  const data = [];
  const sh = { name, data, links: {}, validations: {},
    getName: () => name, getIndex: () => order.indexOf(name) + 1,
    clear() { data.length = 0; sh.links = {}; }, showColumns() {}, getMaxColumns: () => 26, getMaxRows: () => 1000,
    setFrozenRows() {}, hideColumns() {}, setColumnWidth() {},
    getLastRow() { let n = data.length; while (n && !data[n - 1]) n--; return n; },
    getLastColumn() { return Math.max(0, ...data.filter(Boolean).map(r => r.length)); },
    appendRow(row) { data[sh.getLastRow()] = row.map(asCell); },
    deleteRow(r) { data.splice(r - 1, 1); },
    insertColumnAfter(c) { data.forEach(row => row && row.splice(c, 0, '')); },
    insertColumnBefore(c) { data.forEach(row => row && row.splice(c - 1, 0, '')); },
    getRange(r, c, nr = 1, nc = 1) {
      const rng = {
        setValues(v) { v.forEach((row, i) => row.forEach((x, j) => { (data[r - 1 + i] = data[r - 1 + i] || [])[c - 1 + j] = asCell(x); })); return rng; },
        getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((data[r - 1 + i] || [])[c - 1 + j]) ?? ''); out.push(row); } return out; },
        setValue(v) { (data[r - 1] = data[r - 1] || [])[c - 1] = asCell(v); delete sh.links[r + ',' + c]; return rng; },
        getValue() { return ((data[r - 1] || [])[c - 1]) ?? ''; },
        setRichTextValue(v) { (data[r - 1] = data[r - 1] || [])[c - 1] = v.text; sh.links[r + ',' + c] = v.url; return rng; },
        getRichTextValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const u = sh.links[(r + i) + ',' + (c + j)]; row.push({ getLinkUrl: () => u || null }); } out.push(row); } return out; },
        setFontWeight() { return rng; }, setNumberFormat() { return rng; }, setWrap() { return rng; },
        setDataValidation(v) { sh.validations[r + ',' + c] = v; return rng; },
        createTextFinder(t) { return { matchEntireCell() { return this; }, findNext() { for (let i = 0; i < nr; i++) if (String(((data[r - 1 + i] || [])[c - 1]) ?? '') === t) return { getRow: () => r + i }; return null; } }; }
      };
      return rng;
    }
  };
  return sh;
}
const ss = {
  getSheetByName: n => sheets[n] || null, getNumSheets: () => order.length, getSpreadsheetTimeZone: () => 'America/Chicago',
  insertSheet(n, i) { if (i === undefined || i >= order.length) order.push(n); else order.splice(i, 0, n); return (sheets[n] = makeSheet(n)); }
};
const builder = () => ({ requireValueInList() { return this; }, requireNumberBetween() { return this; }, setHelpText() { return this; }, setAllowInvalid() { return this; }, build() { return 'rule'; } });
const SpreadsheetApp = { getActiveSpreadsheet: () => ss, newDataValidation: builder,
  newRichTextValue: () => { const v = {}; return { setText(t) { v.text = t; return this; }, setLinkUrl(u) { v.url = u; return this; }, build() { return v; } }; } };
const cal = { getName: () => 'Household',
  createEvent: (t, s, e, o) => events.push({ t, s: s.toISOString(), e: e.toISOString(), o }),
  createAllDayEvent: (t, d, o) => events.push({ t, allDay: d.toISOString(), o }) };
const CalendarApp = { getCalendarById: id => id === 'shared@group' ? cal : null, getAllCalendars: () => [] };
const Session = { getScriptTimeZone: () => 'America/Chicago' };
const pages = {};
function resp(code, body, headers) { return { getResponseCode: () => code, getContentText: () => typeof body === 'string' ? body : JSON.stringify(body), getAllHeaders: () => headers || {}, getBlob: () => ({ getBytes: () => [] }) }; }
const UrlFetchApp = { fetch(url, opts = {}) {
  if (url.startsWith('https://api.telegram.org/bot')) {
    const method = url.split('/').pop().split('?')[0];
    tg.push({ method, payload: opts.payload ? JSON.parse(opts.payload) : {} });
    if (method === 'sendMessage') return resp(200, { ok: true, result: { message_id: ++msgSeq } });
    if (method === 'getFile') return resp(200, { ok: true, result: { file_path: 'x.jpg' } });
    return resp(200, { ok: true, result: true });
  }
  if (url.startsWith('https://api.telegram.org/file/')) return resp(200, '');
  if (url.includes('generativelanguage')) {
    geminiCalls.push(JSON.parse(opts.payload));
    const next = geminiQueue.shift(); if (!next) throw new Error('no gemini mock queued');
    return resp(200, { candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(next) + '\n```' }] }, groundingMetadata: { groundingChunks: [{ web: { title: 'example.org' } }] } }] });
  }
  if (url in pages) return typeof pages[url] === 'function' ? pages[url](opts) : pages[url];
  return resp(404, 'nope');
} };
const directions = {};
const Maps = { DirectionFinder: { Mode: { WALKING: 'walking', DRIVING: 'driving', TRANSIT: 'transit' } },
  newDirectionFinder: () => { const q = {}; return { setOrigin(o) { q.o = o; return this; }, setDestination(d) { q.d = d; return this; }, setMode(m) { q.m = m; return this; },
    getDirections() { const k = q.o + '|' + q.d + '|' + q.m; return k in directions ? { routes: [{ legs: [{ duration: { value: directions[k] * 60 } }] }] } : { routes: [] }; } }; } };
const triggers = [];
const ScriptApp = { getProjectTriggers: () => triggers, newTrigger: fn => ({ timeBased() { return this; }, everyDays() { return this; }, atHour() { return this; }, inTimezone() { return this; }, create() { triggers.push({ getHandlerFunction: () => fn }); } }) };
const ctx = { Session, Utilities, PropertiesService, LockService, Logger, ContentService, SpreadsheetApp, CalendarApp, UrlFetchApp, Maps, ScriptApp, console };
vm.createContext(ctx); CtxDate = vm.runInContext('Date', ctx);
// Test config: a fictional household in Springfield, IL; group chat -100, a private chat 42.
// MINIMAL_CONFIG=1 leaves every optional setting blank, like a first install.
const optional = { CALENDAR_ID: "'shared@group'", HOME_ADDRESS: "'123 Main St, Springfield, IL'", PLACES_API_KEY: "'PK'", HOUSEHOLD_NAMES: "'Alex and Sam'" };
let config = fs.readFileSync(path.join(ROOT, 'apps-script/Config.example.gs'), 'utf8')
  .replace("'YOUR_TELEGRAM_BOT_TOKEN'", "'TOKEN'").replace("ALLOWED_CHAT_IDS = ''", "ALLOWED_CHAT_IDS = '-100, 42'")
  .replace("HOME_CITY        = ''", "HOME_CITY        = 'Springfield, IL'")
  .replace("HOME_TIMEZONE    = 'America/New_York'", "HOME_TIMEZONE    = 'America/Chicago'");
if (!process.env.MINIMAL_CONFIG) Object.keys(optional).forEach(k => { config = config.replace(new RegExp('(const ' + k + ' += )\'\''), '$1' + optional[k]); });
vm.runInContext(config + '\n' + fs.readFileSync(path.join(ROOT, 'apps-script/Code.gs'), 'utf8'), ctx);
const api = vm.runInContext('({ setup, archiveOld, processUpdate_, namesOverlap_, cleanUrl_, recipeFromHtml_, isoDuration_ })', ctx);
let uid = 1;
function send(text, extra = {}) {
  if (extra.auto) { const u = text.match(/^\S+/)[0]; extra = Object.assign({}, extra, { entities: [{ type: 'url', offset: 0, length: u.length }] }); delete extra.auto; }
  const m = Object.assign({ message_id: ++msgSeq, chat: { id: -100 }, from: { first_name: 'Sam' }, date: Math.floor(Date.now() / 1000), text }, extra);
  api.processUpdate_({ update_id: uid++, message: m }); return m;
}
const tap = (data, msgId, chatId = -100) => api.processUpdate_({ update_id: uid++, callback_query: { id: 'cb', data, message: { message_id: msgId, chat: { id: chatId } } } });
const lastSend = () => [...tg].reverse().find(t => t.method === 'sendMessage');
const rowOf = (tab, i = 1) => { const d = sheets[tab].data; return Object.fromEntries(d[0].map((h, j) => [h, d[i][j]])); };
const linkOf = (tab, h, row = 2) => sheets[tab].links[row + ',' + (sheets[tab].data[0].indexOf(h) + 1)];
const setCell = (tab, title, h, v) => { const d = sheets[tab].data; d.find(r => r && r[0] === title)[d[0].indexOf(h)] = v; };
const ideaIds = () => JSON.parse(store.IDEA_INDEX || '[]');
const idea = id => JSON.parse(store['IDEA_' + id]);
/** Adds a trip to the Trip List tab (dates as yyyy-mm-dd). */
function addTrip(name, destination, base, start, end, tz) {
  const sh = sheets['Trip List']; sh.data.push([name, destination, base, new CtxDate(start + 'T12:00:00Z'), new CtxDate(end + 'T12:00:00Z'), tz, '']);
}
const askIds = () => Object.keys(store).filter(k => k.startsWith('ASK_')).map(k => ({ msgId: Number(k.split('_')[2]), ask: JSON.parse(store[k]) }));
module.exports = { ctx, api, tg, events, log, store, sheets, order, pages, resp, directions, triggers, geminiCalls, CtxDate, ss,
  setGemini: q => { geminiQueue = q; }, addTrip, send, tap, lastSend, rowOf, linkOf, setCell, ideaIds, idea, askIds };
