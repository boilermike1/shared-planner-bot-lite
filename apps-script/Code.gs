// Shared Planner Bot (lite): Telegram -> Gemini -> Google Sheet tabs + a shared Google Calendar
// Secrets live in Config.gs (private, never committed). See Config.example.gs.

// ===================== SETTINGS (not secret) =====================
const GEMINI_MODEL      = 'gemini-3.8-flash';
const USE_GOOGLE_SEARCH = true;    // look up hours, prices and booking rules (needs paid Gemini tier)
const DEFAULT_EVENT_MIN = 120;     // event length when neither you nor the idea says otherwise
const KEEP_IDEAS        = 100;     // newest ideas whose buttons and replies keep working
const ASK_TTL_DAYS      = 3;       // unanswered "when?" questions expire after this long
const WALK_MAX_MIN      = 20;      // commutes this short show as a walk instead of drive + transit
// =================================================================

const PROPS = PropertiesService.getScriptProperties(); // SEEN_IDS, IDEA_<id>, IDEA_INDEX, MSG_<chat>_<msg>, ASK_<chat>_<msg>
let LOCK_HELD = false; // per-execution flag so nested lock calls don't deadlock

// Config values are read inside functions (not at top level) so file order in the project doesn't matter
function tgBase_() { return `https://api.telegram.org/bot${BOT_TOKEN}`; }

// Home settings from Config.gs (see Config.example.gs)
/** The calendar for the 📅 / ⏰ buttons; blank turns the buttons off. */
function calendarId_() { return typeof CALENDAR_ID !== 'undefined' ? String(CALENDAR_ID || '').trim() : ''; }
function homeArea_() { return typeof HOME_CITY !== 'undefined' && String(HOME_CITY || '').trim() ? String(HOME_CITY).trim() : 'their city'; }
/** The in-town tab is named after the city ("Austin, TX" → "Austin"); "Local" until HOME_CITY is set. */
function homeTabName_() { const c = typeof HOME_CITY !== 'undefined' ? String(HOME_CITY || '').split(',')[0].trim() : ''; return c || 'Local'; }
function homeTz_() { return typeof HOME_TIMEZONE !== 'undefined' && String(HOME_TIMEZONE || '').trim() ? String(HOME_TIMEZONE).trim() : Session.getScriptTimeZone(); }
/** "Alex and Sam, who live in Austin, TX," or "a household in Austin, TX" for the AI prompts. */
function householdLine_() {
  const names = typeof HOUSEHOLD_NAMES !== 'undefined' ? String(HOUSEHOLD_NAMES || '').trim() : '';
  return names ? `${names}, who live in ${homeArea_()},` : `a household in ${homeArea_()}`;
}

// =============== WEBHOOK VIA CLOUDFLARE WORKER ===============

function doPost(e) {
  try {
    if (!e || !e.parameter || e.parameter.secret !== WEBHOOK_SECRET) return ok_();
    if (!e.postData || !e.postData.contents) return ok_();
    const update = JSON.parse(e.postData.contents);
    if (!update.update_id) return ok_();
    const isNew = withLock_(() => markSeen_(update.update_id));
    if (isNew) processUpdate_(update);
  } catch (err) {
    Logger.log('doPost error: ' + (err.stack || err));
  }
  return ok_();
}

// =============== ROUTING ===============

function processUpdate_(update) {
  let chatId = null;
  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
      handleButton_(cq, chatId);
      return;
    }

    const msg = update.message;
    if (!msg || !msg.chat) return;
    chatId = msg.chat.id;
    const text = (msg.text || msg.caption || '').trim();
    const cmd = text.toLowerCase().split(/[\s@]/)[0];

    if (cmd === '/id') {
      sendTelegramMessage(chatId, 'This chat\'s ID: ' + chatId);
      return;
    }
    if (!allowedChats_().length) {
      sendTelegramMessage(chatId, 'Setup isn\'t finished: put this chat\'s ID (' + chatId + ') in ALLOWED_CHAT_IDS in Config.gs, then deploy a new version.');
      return;
    }
    if (!isAllowed_(chatId)) return;

    if (cmd === '/start' || cmd === '/help') {
      sendTelegramMessage(chatId, helpText_());
      return;
    }
    if (cmd === '/trips') {
      sendTelegramMessage(chatId, tripsText_());
      return;
    }
    if (text.startsWith('/')) return; // ignore other commands
    if (!text && !msg.photo) return;  // stickers, voice notes, etc.

    // A reply to one of the bot's messages: answers a question, or corrects a saved idea
    if (msg.reply_to_message && handleReply_(msg, text)) return;

    saveNewIdea_({
      chatId: chatId,
      replyTo: msg.message_id,
      by: senderName_(msg.from),
      date: msg.date,
      text: text,
      urls: extractUrls_(msg),
      photoId: msg.photo ? pickPhoto_(msg.photo).file_id : ''
    });

  } catch (err) {
    reportError_(chatId, err);
  }
}

function allowedChats_() {
  return String(ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** Only chats in ALLOWED_CHAT_IDS can use the bot; if it's blank, nobody can (so strangers can't spend your Gemini credits). */
function isAllowed_(chatId) {
  return allowedChats_().indexOf(String(chatId)) !== -1;
}

function reportError_(chatId, err) {
  Logger.log(err.stack || err);
  if (!chatId) return;
  try {
    sendTelegramMessage(chatId, '⚠️ Error: ' + esc_(String(err.message || err).slice(0, 500)) +
      '\nResend if you want to retry.');
  } catch (_) {}
}

function helpText_() {
  const lines = [
    '👋 Send me anything you want to do: a TikTok or Instagram link, any web link, a screenshot, or just a sentence like "try the new taco place downtown."',
    '',
    `I'll file it under Restaurants, ${homeTabName_()}, Trips, Life, Recipes or Shopping (household things and gift ideas), with notes on how to make it happen. Groceries aren't tracked yet.`
  ];
  if (calendarId_()) lines.push('• Tap 📅 to put it on the calendar, or ⏰ for a reminder to plan it.');
  lines.push(
    '• Reply to one of my saved messages to fix anything ("this is for our Lisbon trip", "it\'s the one downtown"). You can reply with a screenshot too, e.g. of a full recipe.',
    '• /trips shows the trips I know about. Add new ones in the Trip List tab of the sheet.');
  return lines.join('\n');
}

function tripsText_() {
  const trips = getTrips_();
  if (!trips.length) return 'No upcoming trips. Add one in the Trip List tab of the sheet.';
  return '✈️ Upcoming trips:\n' + trips.map(t =>
    `• <b>${esc_(t.name)}</b>: ${esc_(t.destination)}, ${fmtDay_(t.start)} – ${fmtDay_(t.end)}`).join('\n');
}

// =============== NEW IDEAS ===============

/**
 * Reads any links, asks Gemini what the idea is and how to do it, saves a row and posts a summary
 * with calendar buttons. p: {chatId, replyTo, by, date, text, urls, photoId, forceSave}
 */
function saveNewIdea_(p) {
  sendChatAction_(p.chatId, 'typing');
  const links = p.urls.slice(0, 3).map(fetchLinkInfo_);

  const dup = links.length ? findDuplicate_(links[0].url) : null;
  if (dup) {
    sendTelegramMessage(p.chatId,
      `👀 Already saved: <b>${esc_(dup.title)}</b> (${esc_(dup.tab)}, added ${dup.added}${dup.by ? ' by ' + esc_(dup.by) : ''}).`,
      null, p.replyTo);
    return;
  }

  const r = analyzeIdea_(p.text, links, p.photoId, getTrips_());
  if (!r.is_idea && !p.forceSave) return; // chit-chat in the group: stay quiet
  if (r.category === 'Grocery') {
    sendTelegramMessage(p.chatId, '🛒 That looks like a grocery item. I don\'t track groceries yet, so I didn\'t save it.', null, p.replyTo);
    return;
  }

  if (!r.understood && !p.forceSave) {
    const askId = sendTelegramMessage(p.chatId,
      '🤔 I couldn\'t tell what\'s in that post. Reply to this message with a few words about it (what and where), and I\'ll save it.',
      { force_reply: true }, p.replyTo);
    if (askId) saveAsk_(p.chatId, askId, { kind: 'info', p: p });
    return;
  }

  const idea = {
    id: Utilities.getUuid().slice(0, 8),
    chatId: p.chatId,
    by: p.by,
    addedAt: p.date * 1000,
    text: p.text.slice(0, 1500),
    links: links.map(l => l.url),
    result: r,
    done: { event: false, reminder: false }
  };
  withLock_(() => appendIdea_(idea));
  idea.msgId = sendTelegramMessage(p.chatId, ideaText_(idea), ideaButtons_(idea), p.replyTo);
  rememberIdea_(idea);
}

function senderName_(from) {
  return from ? (from.first_name || from.username || '') : '';
}

/** Links in the message: Telegram marks them as entities; hidden links (text_link) carry their own URL. */
function extractUrls_(msg) {
  const text = msg.text || msg.caption || '';
  const entities = msg.entities || msg.caption_entities || [];
  const urls = [];
  entities.forEach(en => {
    let u = '';
    if (en.type === 'url') u = text.substr(en.offset, en.length);
    else if (en.type === 'text_link') u = en.url;
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (urls.indexOf(u) === -1) urls.push(u);
  });
  if (!urls.length) (text.match(/https?:\/\/[^\s<>"]+/gi) || []).forEach(u => { if (urls.indexOf(u) === -1) urls.push(u); });
  return urls;
}

function pickPhoto_(photos) {
  // Second-largest size keeps download + inference fast
  return photos.length > 2 ? photos[photos.length - 2] : photos[photos.length - 1];
}

function getPhotoBase64_(fileId) {
  const fileRes = UrlFetchApp.fetch(`${tgBase_()}/getFile?file_id=${fileId}`);
  const filePath = JSON.parse(fileRes.getContentText()).result.file_path;
  const blob = UrlFetchApp.fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`).getBlob();
  return Utilities.base64Encode(blob.getBytes());
}

// =============== READING LINKS ===============

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SHORT_LINK_RE = /^https?:\/\/(vm\.tiktok\.com|vt\.tiktok\.com|(www\.)?tiktok\.com\/t\/|instagr\.am|bit\.ly|tinyurl\.com|t\.co|maps\.app\.goo\.gl|goo\.gl|a\.co|amzn\.to|share\.google)/i;

/**
 * What the bot can learn from a link without logging in. TikTok and YouTube have public lookups
 * (oEmbed) that return the caption; Instagram usually hides captions, so that's best effort; other
 * sites give their page title and description.
 */
function fetchLinkInfo_(rawUrl) {
  const info = { url: rawUrl, site: '', title: '', author: '', description: '' };
  try {
    info.url = cleanUrl_(SHORT_LINK_RE.test(rawUrl) ? resolveUrl_(rawUrl) : rawUrl);
    info.site = hostOf_(info.url);

    if (/(^|\.)tiktok\.com$/.test(info.site)) {
      const o = fetchJson_('https://www.tiktok.com/oembed?url=' + encodeURIComponent(info.url));
      if (o) { info.title = o.title || ''; info.author = o.author_name || ''; }
    } else if (/(^|\.)(youtube\.com|youtu\.be)$/.test(info.site)) {
      const o = fetchJson_('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(info.url));
      if (o) { info.title = o.title || ''; info.author = o.author_name || ''; }
    }

    if (!info.title) {
      // Instagram only shows post captions to link-preview crawlers
      const ua = /(^|\.)instagram\.com$/.test(info.site) ? 'facebookexternalhit/1.1' : BROWSER_UA;
      const meta = pageMeta_(info.url, ua);
      info.title = meta.title;
      info.description = meta.description;
      info.recipe = meta.recipe;
    }
  } catch (err) {
    Logger.log('Link lookup failed for ' + rawUrl + ': ' + err);
  }
  return info;
}

/** Follows redirects by hand (short links) to find the real address. */
function resolveUrl_(url) {
  for (let i = 0; i < 5; i++) {
    const res = UrlFetchApp.fetch(url, {
      followRedirects: false, muteHttpExceptions: true, headers: { 'User-Agent': BROWSER_UA }
    });
    const code = res.getResponseCode();
    const headers = res.getAllHeaders();
    const loc = headers.Location || headers.location;
    if (code < 300 || code >= 400 || !loc) break;
    url = /^https?:\/\//i.test(loc) ? loc : url.match(/^https?:\/\/[^\/]+/)[0] + (loc.charAt(0) === '/' ? '' : '/') + loc;
  }
  return url;
}

/** Drops tracking junk so the same post always looks the same (for duplicate checks). */
function cleanUrl_(url) {
  let u = String(url).split('#')[0];
  const host = hostOf_(u);
  if (/(^|\.)(tiktok\.com|instagram\.com)$/.test(host)) {
    u = u.split('?')[0];
  } else if (u.indexOf('?') !== -1) {
    const [base, query] = u.split('?');
    const kept = query.split('&').filter(kv => kv && !/^(utm_|fbclid|gclid|igsh|si=|mc_)/i.test(kv));
    u = base + (kept.length ? '?' + kept.join('&') : '');
  }
  return u.replace(/\/+$/, '');
}

function hostOf_(url) {
  const m = String(url).match(/^https?:\/\/([^\/?#:]+)/i);
  return m ? m[1].toLowerCase().replace(/^(www|m)\./, '') : '';
}

function fetchJson_(url) {
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': BROWSER_UA } });
  if (res.getResponseCode() !== 200) return null;
  try { return JSON.parse(res.getContentText()); } catch (_) { return null; }
}

function pageMeta_(url, userAgent) {
  const out = { title: '', description: '', recipe: null };
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': userAgent } });
  if (res.getResponseCode() !== 200) return out;
  const html = res.getContentText().slice(0, 600000);
  out.recipe = recipeFromHtml_(html);
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  out.title = decodeEntities_(metaContent_(html, 'og:title') || titleTag).trim();
  out.description = decodeEntities_(metaContent_(html, 'og:description') || metaContent_(html, 'description')).trim();
  return out;
}

/**
 * The recipe on a page, for exact ingredients. Tries, in order: schema.org data in a JSON-LD script
 * (most recipe sites), the same data tagged on the page itself with itemprop="recipeIngredient"
 * (older or custom sites), and finally the page text under the "Ingredients" heading, which Gemini
 * reads. Returns {name, ingredients, prepTime, cookTime, totalTime, servings, cuisine, pageText} or null.
 */
function recipeFromHtml_(html) {
  const ld = recipeFromJsonLd_(html);
  const md = recipeFromMicrodata_(html);
  const rec = ld || md;
  if (rec && md && rec !== md) {
    if (!rec.ingredients.length) rec.ingredients = md.ingredients; // e.g. JSON-LD with only a name and rating
    ['name', 'prepTime', 'cookTime', 'totalTime', 'servings', 'cuisine'].forEach(k => { if (!rec[k]) rec[k] = md[k]; });
  }
  if (rec && rec.ingredients.length) return rec;
  const pageText = ingredientsText_(html);
  if (!pageText) return rec;
  return Object.assign(rec || { name: '', ingredients: [], prepTime: '', cookTime: '', totalTime: '', servings: '', cuisine: '' }, { pageText: pageText });
}

function recipeFromJsonLd_(html) {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  const isRecipe = o => o && [].concat(o['@type'] || []).some(t => String(t).toLowerCase() === 'recipe');
  const find = o => {
    if (!o || typeof o !== 'object') return null;
    if (Array.isArray(o)) { for (const x of o) { const hit = find(x); if (hit) return hit; } return null; }
    if (isRecipe(o)) return o;
    return find(o['@graph']);
  };
  for (const block of blocks) {
    let data;
    try { data = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/gi, '')); } catch (_) { continue; }
    const r = find(data);
    if (!r) continue;
    const text = v => decodeEntities_(Array.isArray(v) ? v.join(', ') : String(v || '')).trim();
    return {
      name: text(r.name),
      ingredients: (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : []).map(text).filter(Boolean).slice(0, 60),
      prepTime: isoDuration_(r.prepTime),
      cookTime: isoDuration_(r.cookTime),
      totalTime: isoDuration_(r.totalTime),
      servings: text(Array.isArray(r.recipeYield) ? r.recipeYield[0] : r.recipeYield),
      cuisine: text(r.recipeCuisine)
    };
  }
  return null;
}

/** Recipe fields tagged on the page itself: <li itemprop="recipeIngredient">2 tbsp olive oil</li>. */
function recipeFromMicrodata_(html) {
  const tagged = prop => {
    const re = new RegExp('<(\\w+)\\b[^>]*\\bitemprop=["\'][^"\']*\\b' + prop + '\\b[^"\']*["\']([^>]*)>([\\s\\S]*?)<\\/\\1>', 'gi');
    const out = [];
    let m;
    while ((m = re.exec(html)) && out.length < 60) {
      const content = (m[0].slice(0, m[0].indexOf('>')).match(/\bcontent=["']([^"']*)["']/i) || [])[1] || ''; // e.g. content="PT30M"
      out.push({ text: cleanText_(m[3]), content: content });
    }
    return out;
  };
  const ingredients = tagged('recipeIngredient').map(x => x.text).filter(Boolean);
  if (!ingredients.length) return null;
  const first = prop => {
    const hit = tagged(prop)[0];
    if (hit) return isoDuration_(hit.content) || isoDuration_(hit.text) || hit.text;
    const meta = html.match(new RegExp('<meta\\b[^>]*\\bitemprop=["\'][^"\']*\\b' + prop + '\\b[^>]*>', 'i')); // <meta itemprop="totalTime" content="PT30M">
    const content = meta && (meta[0].match(/\bcontent=["']([^"']*)["']/i) || [])[1];
    return content ? (isoDuration_(content) || content) : '';
  };
  return {
    name: '', ingredients: ingredients,
    prepTime: first('prepTime'), cookTime: first('cookTime'), totalTime: first('totalTime'),
    servings: first('recipeYield'), cuisine: first('recipeCuisine')
  };
}

/** Plain text under the page's "Ingredients" heading (about 2,500 characters), for pages with no recipe data. */
function ingredientsText_(html) {
  const m = html.match(/<h[1-6][^>]*>\s*(?:<[^>]+>\s*)*ingredients\b[\s\S]{0,20000}/i);
  if (!m) return '';
  return cleanText_(m[0].replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')).slice(0, 2500);
}

function cleanText_(fragment) {
  return decodeEntities_(String(fragment).replace(/<br\s*\/?>|<\/(li|p|div|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/** "PT1H30M" → "1 hr 30 min". */
function isoDuration_(v) {
  const m = String(v || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
  if (!m || !(m[1] || m[2] || m[3])) return '';
  return fmtMinutes_(Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0));
}

/** Content of <meta property|name="key" content="...">, whatever order the attributes are in. */
function metaContent_(html, key) {
  const tags = html.match(/<meta\s[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    tag.replace(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (m, name, q, dq, sq) => {
      attrs[name.toLowerCase()] = dq !== undefined ? dq : sq;
      return m;
    });
    if ((attrs.property || attrs.name || '').toLowerCase() === key) return attrs.content || '';
  }
  return '';
}

function decodeEntities_(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

// =============== GEMINI ===============

const CATEGORIES = ['Restaurant', 'Local', 'Trip', 'Life', 'Recipe', 'Shopping', 'Grocery']; // Grocery isn't saved

function analyzeIdea_(text, links, photoId, trips) {
  const parts = [{ text: buildIdeaPrompt_(text, links, !!photoId, trips) }];
  if (photoId) parts.push({ inline_data: { mime_type: 'image/jpeg', data: getPhotoBase64_(photoId) } });
  return enrichPlace_(normalizeResult_(callGemini_(parts), trips), trips, links.map(l => l.url));
}

function buildIdeaPrompt_(text, links, hasPhoto, trips) {
  const linkLines = links.length
    ? links.map(l => {
      const bits = [`site ${l.site || 'unknown'}`];
      if (l.author) bits.push(`creator ${l.author}`);
      if (l.title) bits.push(`title/caption "${l.title}"`);
      if (l.description) bits.push(`description "${l.description.slice(0, 600)}"`);
      if (l.recipe) {
        const rc = l.recipe;
        if (rc.ingredients.length || rc.totalTime || rc.servings) {
          bits.push(`structured recipe on the page: "${rc.name}"; ingredients: ${JSON.stringify(rc.ingredients)}; prep ${rc.prepTime || '?'}, cook ${rc.cookTime || '?'}, total ${rc.totalTime || '?'}; serves ${rc.servings || '?'}${rc.cuisine ? '; cuisine ' + rc.cuisine : ''}`);
        }
        if (rc.pageText) bits.push(`recipe text from the page, starting at its Ingredients heading (may include other text): <<<${rc.pageText}>>>`);
      }
      if (!l.title && !l.description) bits.push('the bot could not read anything from this link');
      return `- ${l.url}: ${bits.join('; ')}`;
    }).join('\n')
    : 'No links.';

  return `You help ${householdLine_()} keep a shared list of things they want to do: on upcoming trips, in and around their city, and in life in general. Someone in the household just sent this to their planning bot.

Today is ${Utilities.formatDate(new Date(), homeTz_(), 'EEEE, MMMM d, yyyy')} (local time).

Upcoming trips:
${tripLines_(trips)}

Message:
"""${text || '(no text)'}"""
${hasPhoto ? '\nA photo or screenshot is attached; read it for names, places, dates and prices.\n' : ''}
What the bot could read from the link(s):
${linkLines}

Use Google Search to identify the exact place, event or activity and to check practical details: address, website, hours and closed days, prices, reservations or tickets, how far ahead to book, seasonal notes. Don't invent specifics you can't verify; say "check ahead" instead.

Decide:
- is_idea: false only if the message is plainly not something to save (chit-chat like "lol", "ok", "sounds good", "thanks"). Otherwise true.
- understood: false only if the message is just a link and neither the caption nor a search tells you what the post is about. Never guess from the URL alone.
- category:
  - "Restaurant": a restaurant, bar, café, bakery or other food spot in or near ${homeArea_()}.
  - "Local": anything else to do in ${homeArea_()} or within about 2 hours (day trips included).
  - "Trip": anything for one of the trips above or anywhere farther away, including restaurants there.
  - "Recipe": a recipe or dish to cook at home.
  - "Shopping": something to buy that isn't groceries: household items, furniture, gear, clothes, and gifts or gift ideas.
  - "Grocery": food or everyday consumables for the weekly grocery run (milk, olive oil, paper towels). These aren't saved.
  - "Life": anything else not tied to a place and not something to buy or cook: home projects, habits, goals, plans for someone.
- trip: for "Trip" ideas, the exact trip name from the list above if it's at or near that trip's destination, otherwise "Someday". "" for other categories.
- destination: for "Trip" ideas, the city or region (e.g. "Lisbon", "Maui, HI"). Otherwise "".
- title: the place's own name when it's one place (e.g. "Joe's Pizza"), otherwise a short name for the activity (e.g. "Sunrise Ridge Hike"). No extra words.
- specific_place: true if this is one named business, venue or landmark; false for general activities ("a surf lesson in Waikiki") and Life ideas.
- where: the full street address with city and state, or for outdoor spots the most specific location (e.g. "Lighthouse Beach, Cape Point"). "" if it isn't a place.
- area: the neighborhood or area (e.g. "Downtown", "Old Town", "Wine country (day trip)"), "" if none.
- website: the official website, only if you found it in search results. For "Recipe", the page with the written recipe (the message's own link if it's a recipe page, or the creator's posted recipe). For "Shopping", the product page. Never make one up.
- ingredients ("Recipe" only): one string per ingredient with its amount, e.g. "2 lb chicken thighs". Only from the page's structured recipe, the recipe text from the page, the caption, an attached screenshot, or a written recipe you found from the same creator. Never invent them; [] if you can't find them.
- tips: 0-3 short tips that no other field covers: parking or transit, cash only, dress code, what to bring, age limits. Don't repeat the summary, booking or when_to_go.
- book_url / book_platform: if reservations or tickets are needed or recommended, the page where they actually take them (their Resy, OpenTable, Tock or SevenRooms page, a tour operator's booking page, a state park reservation page, or the venue's own booking page) and that site's name. Only use an address you found in search results or on the venue's own site; never make one up. "" if walk-in only or you can't find it.
- when: only if the idea has a fixed date (a concert, festival, dated event, or a date mentioned in the message). Use the next upcoming occurrence; never a past date. Otherwise null.
- plan_by: the day they should book or act so it isn't too late (reservations that open N days ahead, tickets that sell out, permits, seasonal timing; for shopping, the day to buy: the next good sale if it comes before any deadline, otherwise the day to order so a gift arrives in time). For trip ideas, work back from the trip dates. Today or later. null if nothing needs planning ahead.
- timezone: IANA time zone where the idea happens (e.g. "America/New_York", "Europe/Lisbon").

Return ONLY JSON, no other text:
{
  "is_idea": true,
  "understood": true,
  "category": "Restaurant" | "Local" | "Trip" | "Recipe" | "Shopping" | "Grocery" | "Life",
  "trip": "",
  "destination": "",
  "type": "Activity" | "Event" | "Sight" | "Nature" | "Food & Drink" | "Stay" | "Class" | "Home" | "Health" | "Other",
  "title": "Joe's Pizza",
  "specific_place": true,
  "where": "",
  "area": "",
  "website": "https://... or ''",
  "summary": "1-2 friendly sentences: what it is and why it looks fun",
  "tips": [],
  "when_to_go": "best time plus closed days or seasons, e.g. 'Sunrise on weekdays; closed Mon-Tue', '' if not relevant",
  "time_needed": "activities only: how long it takes, e.g. '2-3 hrs', else ''",
  "est_cost": "price level and estimate, e.g. '$$$ (~$120 for two)' or 'Free', '' if unknown",
  "booking": "how to book, under 35 words: where, when reservations or tickets open (with time zone, e.g. '30 days ahead at 10 AM local time'), deposits or cancellation fees, and tips (e.g. 'set a Resy Notify', 'bar seats are walk-in'). 'Walk-in' if no booking. '' if not relevant",
  "book_url": "https://... or ''",
  "book_platform": "e.g. 'Resy', 'OpenTable', 'Tock', 'Recreation.gov', or ''",
  "cuisine": "restaurants only, e.g. 'Korean BBQ', else ''",
  "good_for": "restaurants only, e.g. 'date night, groups', else ''",
  "must_order": "restaurants only: the dishes it's known for, else ''",
  "for_whom": "gifts or plans for someone: who, else ''",
  "main_ingredient": "recipes only, e.g. 'Chicken', 'Salmon', 'Chickpeas', else ''",
  "method": "recipes only: 'Grill' | 'Oven' | 'Stovetop' | 'Slow Cooker' | 'Instant Pot' | 'Air Fryer' | 'No-Cook' | 'Other', else ''",
  "effort": "recipes only: 'Weeknight' (about 45 minutes or less, hands-on) or 'Weekend', else ''",
  "active_time": "recipes only, e.g. '20 min', else ''",
  "total_time": "recipes only, e.g. '1 hr 15 min', else ''",
  "servings": "recipes only, e.g. '4', else ''",
  "ingredients": [],
  "shop_type": "shopping only: 'Household' or 'Gift', else ''",
  "occasion": "gifts only, e.g. 'Birthday', 'Christmas', else ''",
  "where_to_buy": "shopping only: stores or sites that carry it, e.g. 'Costco, Amazon', else ''",
  "best_time_to_buy": "shopping only, under 35 words: when this product or brand usually has its best prices, from search (e.g. 'Biggest discounts are usually Black Friday-Cyber Monday and Prime Day in July; Bombas rarely discounts outside its own sales'), and the next such sale with its date if known. Say 'usually': past patterns aren't guarantees. '' if nothing useful",
  "duration_minutes": 120,
  "timezone": "America/New_York",
  "when": null or {"date": "YYYY-MM-DD", "start_time": "HH:mm" or null, "end_time": "HH:mm" or null},
  "plan_by": null or {"date": "YYYY-MM-DD", "reason": "short reason, e.g. 'reservations open 30 days ahead'"}
}`;
}

function tripLines_(trips) {
  return trips.length
    ? trips.map(t => `- ${t.name}: ${t.destination}, ${t.start} to ${t.end} (time zone ${t.tz})${t.base ? ', staying at ' + t.base : ''}${t.notes ? '. Notes: ' + t.notes : ''}`).join('\n')
    : 'None listed.';
}

/** For a recipe, re-reads its page so a reply like "add the ingredients" can use the exact list. */
function recipePageLines_(idea) {
  if (idea.result.category !== 'Recipe') return '';
  const lines = idea.links.slice(0, 2).map(fetchLinkInfo_).filter(l => l.recipe).map(l => {
    const rc = l.recipe;
    return rc.ingredients.length
      ? `\nRecipe on ${l.url}: ingredients ${JSON.stringify(rc.ingredients)}; total ${rc.totalTime || '?'}; serves ${rc.servings || '?'}`
      : `\nRecipe text on ${l.url}: <<<${rc.pageText || ''}>>>`;
  });
  return lines.join('');
}

/** Applies a correction ("this is for our Lisbon trip", "it's the one downtown") to a saved idea. */
function reviseIdea_(idea, correction, photoId) {
  const trips = getTrips_();
  const current = Object.assign({}, idea.result);
  // Looked up by the bot, not Gemini; refreshed after the correction
  ['searched_sites', 'book_checked', 'website_checked', 'map_url', 'google_rating', 'commute'].forEach(k => delete current[k]);
  const prompt = `You help ${householdLine_()} keep a shared list of things to do. Today is ${Utilities.formatDate(new Date(), homeTz_(), 'EEEE, MMMM d, yyyy')}.

Upcoming trips:
${tripLines_(trips)}

This idea is saved as:
${JSON.stringify(current, null, 2)}

Original message: """${idea.text || '(no text)'}"""
Links: ${idea.links.join(', ') || 'none'}${recipePageLines_(idea)}

Someone in the household replied with this correction:
"""${correction}"""

Apply the correction. Use Google Search if it changes which place or event this is, and refresh the practical details to match (address, website, booking). Keep everything the correction doesn't affect. Return ONLY the full updated JSON in exactly the same shape.`;
  const parts = [{ text: prompt + (photoId ? '\n\nA screenshot is attached; use it (for a recipe, take the ingredients from it).' : '') }];
  if (photoId) parts.push({ inline_data: { mime_type: 'image/jpeg', data: getPhotoBase64_(photoId) } });
  const r = normalizeResult_(callGemini_(parts), trips);
  if (r.category === 'Grocery') r.category = idea.result.category; // a saved idea stays saved
  enrichPlace_(r, trips, idea.links);
  r.is_idea = true;
  r.understood = true;
  return r;
}

/** Turns a reply like "Sat 7pm" or "Nov 9 morning" into a date and optional times. */
function parseWhen_(answer, idea, kind) {
  const r = idea.result;
  const trip = getTrips_().find(t => t.name === r.trip);
  const prompt = `Today is ${Utilities.formatDate(new Date(), homeTz_(), 'EEEE, MMMM d, yyyy')} (local time).
Idea: "${r.title}"${r.where ? ' at ' + r.where : ''}.${trip ? ` It's part of the ${trip.name} trip, ${trip.start} to ${trip.end}.` : ''}
The user was asked ${kind === 'reminder' ? 'what day to be reminded to plan this' : 'when to put this on the calendar'} and replied:
"""${answer}"""

Rules: a date without a year means the next upcoming one. A weekday name means the next one${trip ? ', or the one during the trip if the idea is for the trip' : ''}. Parts of the day: morning 09:00, afternoon 14:00, evening or dinner 18:30, night 20:00. Only fill start_time if they gave a time or part of the day. ${kind === 'reminder' ? 'Reminders are all-day: start_time and end_time are always null.' : ''}
If you can't tell a date, set error to a short reason and date to null.

Return ONLY JSON: {"date": "YYYY-MM-DD" or null, "start_time": "HH:mm" or null, "end_time": "HH:mm" or null, "error": null}`;
  const w = callGemini_([{ text: prompt }], false);
  if (!w || !isDate_(w.date)) return { error: (w && w.error) || 'no date found' };
  return {
    date: w.date,
    start_time: kind === 'reminder' || !isTime_(w.start_time) ? null : w.start_time,
    end_time: kind === 'reminder' || !isTime_(w.end_time) ? null : w.end_time
  };
}

/** Fills in missing fields and drops anything malformed, so the rest of the code can trust the shape. */
function normalizeResult_(r, trips) {
  r = r || {};
  const str = v => (v === null || v === undefined ? '' : String(v)).trim();
  const url = v => /^https?:\/\/\S+$/i.test(str(v)) ? str(v) : '';
  const list = v => (Array.isArray(v) ? v : str(v).split(/\n+/)).map(str).filter(Boolean);
  const trip = trips.find(t => t.name.toLowerCase() === str(r.trip).toLowerCase());
  const out = {
    is_idea: r.is_idea !== false,
    understood: r.understood !== false,
    category: CATEGORIES.indexOf(r.category) !== -1 ? r.category : 'Life',
    trip: trip ? trip.name : '',
    destination: str(r.destination) || (trip ? trip.destination : ''),
    type: str(r.type) || 'Other',
    title: str(r.title).slice(0, 120) || 'Untitled idea',
    specific_place: r.specific_place === true,
    where: str(r.where),
    area: str(r.area),
    website: url(r.website),
    summary: str(r.summary),
    tips: list(r.tips).slice(0, 3),
    when_to_go: str(r.when_to_go),
    time_needed: str(r.time_needed),
    est_cost: str(r.est_cost),
    booking: str(r.booking),
    book_url: url(r.book_url),
    book_platform: str(r.book_platform).slice(0, 30),
    cuisine: str(r.cuisine),
    good_for: str(r.good_for),
    must_order: str(r.must_order),
    for_whom: str(r.for_whom),
    main_ingredient: str(r.main_ingredient),
    method: str(r.method),
    effort: ['Weeknight', 'Weekend'].indexOf(str(r.effort)) !== -1 ? str(r.effort) : '',
    active_time: str(r.active_time),
    total_time: str(r.total_time),
    servings: str(r.servings),
    ingredients: list(r.ingredients).slice(0, 60),
    shop_type: ['Household', 'Gift'].indexOf(str(r.shop_type)) !== -1 ? str(r.shop_type) : '',
    occasion: str(r.occasion),
    where_to_buy: str(r.where_to_buy),
    best_time_to_buy: str(r.best_time_to_buy),
    duration_minutes: Number(r.duration_minutes) > 0 ? Math.min(Number(r.duration_minutes), 24 * 60) : null,
    timezone: /^[A-Za-z]+\/[A-Za-z_\/+-]+$/.test(str(r.timezone)) ? str(r.timezone) : homeTz_(),
    when: null,
    plan_by: null,
    // Filled in by enrichPlace_
    map_url: '',
    google_rating: '',
    commute: '',
    searched_sites: r.searched_sites || []
  };
  if (out.trip) out.category = 'Trip';
  if (out.category === 'Trip' && !out.trip) out.trip = 'Someday';
  if (out.category !== 'Recipe') out.effort = ''; // "effort" means Weeknight/Weekend for recipes only
  if (['Life', 'Recipe', 'Shopping', 'Grocery'].indexOf(out.category) !== -1) out.specific_place = false;
  if (out.category === 'Shopping' && !out.shop_type) out.shop_type = out.for_whom || out.occasion ? 'Gift' : 'Household';
  if (r.when && isDate_(r.when.date)) {
    out.when = {
      date: r.when.date,
      start_time: isTime_(r.when.start_time) ? r.when.start_time : null,
      end_time: isTime_(r.when.end_time) ? r.when.end_time : null
    };
  }
  if (r.plan_by && isDate_(r.plan_by.date)) out.plan_by = { date: r.plan_by.date, reason: str(r.plan_by.reason) };
  return out;
}

// =============== PLACES, LINKS AND COMMUTES ===============

const PLACE_CATEGORIES = ['Restaurant', 'Local', 'Trip'];
// Big sites that often turn bots away (401/403/429/503) even though the page exists
const BOOKING_SITES_RE = /(^|\.)(resy\.com|opentable\.com|exploretock\.com|sevenrooms\.com|yelp\.com|recreation\.gov|viator\.com|getyourguide\.com|fareharbor\.com|eventbrite\.com|ticketmaster\.com|amazon\.com|target\.com|walmart\.com|bestbuy\.com|costco\.com|homedepot\.com|lowes\.com|wayfair\.com|etsy\.com|williams-sonoma\.com|nytimes\.com)$/;

// Optional Config.gs values: the bot still runs without them
function homeAddress_() { return typeof HOME_ADDRESS !== 'undefined' ? String(HOME_ADDRESS || '').trim() : ''; }
function placesKey_() { return typeof PLACES_API_KEY !== 'undefined' ? String(PLACES_API_KEY || '').trim() : ''; }

/**
 * Adds what Google knows about a place: official address, website, Maps page and rating (Places
 * API, when PLACES_API_KEY is set), checked website and booking links, and the travel time from
 * home (or, for a trip, from the hotel in the Trip List's Base column).
 */
function enrichPlace_(r, trips, links) {
  if (!r.is_idea || !r.understood || r.category === 'Grocery') return r;
  const isPlace = PLACE_CATEGORIES.indexOf(r.category) !== -1 && !!(r.where || r.specific_place);
  // A recipe or product sent as a plain web link: that page is the one to link
  if ((r.category === 'Recipe' || r.category === 'Shopping') && !r.website) {
    r.website = (links || []).find(u => !/(^|\.)(tiktok\.com|instagram\.com|youtube\.com|youtu\.be|facebook\.com|x\.com|twitter\.com)$/.test(hostOf_(u))) || '';
  }

  if (isPlace && r.specific_place) {
    const p = findPlace_(r);
    if (p) {
      if (p.formattedAddress) r.where = p.formattedAddress;
      if (p.websiteUri) { r.website = p.websiteUri; r.website_checked = true; }
      if (p.googleMapsUri) r.map_url = p.googleMapsUri;
      if (p.rating) r.google_rating = Number(p.rating).toFixed(1) + (p.userRatingCount ? ` (${Number(p.userRatingCount).toLocaleString('en-US')})` : '');
    }
  }
  if (r.website && !r.website_checked) {
    r.website = linkOpens_(r.website) || '';
    r.website_checked = true;
  }
  if (isPlace && !r.map_url && r.where) r.map_url = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(r.where);
  if (isPlace && r.where) r.commute = commuteText_(commuteFrom_(r, trips), r.where);
  return checkBookingLink_(r);
}

/** Google Places text search for the one place this idea is about, or null (no key, no match, or an error). */
function findPlace_(r) {
  const key = placesKey_();
  if (!key) return null;
  const near = r.where || [r.area, r.destination].filter(Boolean).join(', ') || homeArea_();
  try {
    const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.websiteUri,places.googleMapsUri,places.rating,places.userRatingCount'
      },
      payload: JSON.stringify({ textQuery: r.title + ', ' + near, maxResultCount: 1 })
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('Places ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
      return null;
    }
    const place = (JSON.parse(res.getContentText()).places || [])[0];
    // Only trust it if the names overlap, so a vague search can't attach some other business's rating
    return place && namesOverlap_(r.title, place.displayName && place.displayName.text) ? place : null;
  } catch (err) {
    Logger.log('Places lookup failed: ' + err);
    return null;
  }
}

/**
 * True when the place Google found is the one the idea names: every word of the idea's name is in
 * Google's name ("Joe's" → "Joe's Pizza"), or at least half of each name's words are in the other
 * ("Café Lumière brunch" → "Café Lumière"). "Surf lesson" → "Bay Surf School" doesn't count.
 */
function namesOverlap_(a, b) {
  const words = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length >= 3 && ['the', 'and'].indexOf(w) === -1);
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return false;
  const share = (x, y) => x.filter(w => y.indexOf(w) !== -1).length / x.length;
  return share(wa, wb) === 1 || (share(wa, wb) >= 0.5 && share(wb, wa) >= 0.5);
}

/**
 * The link's real address if it opens, else ''. Big booking sites often turn bots away
 * (401/403/429/503), which still means the page exists.
 */
function linkOpens_(url) {
  try {
    if (/(^|\.)vertexaisearch\.cloud\.google\.com$/.test(hostOf_(url))) url = resolveUrl_(url); // search redirect → real page
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': BROWSER_UA } });
    const code = res.getResponseCode();
    if (code < 400 || (BOOKING_SITES_RE.test(hostOf_(url)) && [401, 403, 429, 503].indexOf(code) !== -1)) return url;
  } catch (err) {
    Logger.log('Link check failed for ' + url + ': ' + err);
  }
  return '';
}

/** A booking link that doesn't open becomes a Google search for the place's reservations. */
function checkBookingLink_(r) {
  if (!r.book_url || r.book_checked) return r;
  const ok = linkOpens_(r.book_url);
  if (ok) {
    r.book_url = ok;
  } else {
    r.book_url = 'https://www.google.com/search?q=' + encodeURIComponent([r.title, r.area || r.destination || homeArea_(), 'reservations'].join(' '));
    r.book_platform = '';
  }
  r.book_checked = true;
  return r;
}

function commuteFrom_(r, trips) {
  if (r.category !== 'Trip') return homeAddress_();
  const trip = trips.find(t => t.name === r.trip);
  return trip ? trip.base : '';
}

/** "🚶 4 min walk" when it's close, otherwise "🚗 15 min · 🚇 35 min" (Google Maps, typical traffic). */
function commuteText_(origin, dest) {
  if (!origin || !dest) return '';
  const minutes = mode => {
    try {
      const d = Maps.newDirectionFinder().setOrigin(origin).setDestination(dest).setMode(mode).getDirections();
      const leg = d && d.routes && d.routes[0] && d.routes[0].legs && d.routes[0].legs[0];
      return leg ? Math.max(1, Math.round(leg.duration.value / 60)) : null;
    } catch (err) {
      Logger.log('Directions failed (' + mode + '): ' + err);
      return null;
    }
  };
  const walk = minutes(Maps.DirectionFinder.Mode.WALKING);
  if (walk !== null && walk <= WALK_MAX_MIN) return `🚶 ${fmtMinutes_(walk)} walk`;
  const parts = [];
  const drive = minutes(Maps.DirectionFinder.Mode.DRIVING);
  if (drive !== null) parts.push('🚗 ' + fmtMinutes_(drive));
  const transit = minutes(Maps.DirectionFinder.Mode.TRANSIT);
  if (transit !== null) parts.push('🚇 ' + fmtMinutes_(transit));
  return parts.join(' · ');
}

function fmtMinutes_(m) {
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60), rest = m % 60;
  return h + ' hr' + (rest ? ' ' + rest + ' min' : '');
}

/** Calls Gemini with Google Search; if search isn't available or the reply isn't usable, retries without it. */
function callGemini_(parts, allowSearch) {
  const modes = USE_GOOGLE_SEARCH && allowSearch !== false ? [true, false] : [false];
  let lastErr = null;

  for (const withSearch of modes) {
    const payload = { contents: [{ parts: parts }] };
    if (withSearch) {
      payload.tools = [{ google_search: {} }];
    } else {
      payload.generationConfig = { response_mime_type: 'application/json' };
    }

    const res = UrlFetchApp.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': GEMINI_API_KEY },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
    const code = res.getResponseCode();
    const raw = res.getContentText();

    if (code !== 200) {
      lastErr = new Error(`Gemini ${code}: ${raw.slice(0, 300)}`);
      // 400/403 with search usually means search isn't allowed for this key or request: retry without it
      if (withSearch && (code === 400 || code === 403)) {
        Logger.log('Search request rejected, retrying without search: ' + raw.slice(0, 300));
        continue;
      }
      throw lastErr;
    }

    try {
      const body = JSON.parse(raw);
      const cand = body.candidates[0];
      const text = (cand.content.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
      if (!text) throw new Error('Empty Gemini response: ' + raw.slice(0, 300));
      const result = extractJson_(text);

      // Remember which sites the search actually consulted
      const chunks = (cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
      result.searched_sites = [...new Set(chunks.map(c => c.web && c.web.title).filter(Boolean))].slice(0, 5);
      return result;
    } catch (err) {
      lastErr = err;
      if (withSearch) { Logger.log('Unusable search reply, retrying without search: ' + err); continue; }
      throw err;
    }
  }
  throw lastErr;
}

function extractJson_(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON in Gemini reply: ' + clean.slice(0, 200));
  return JSON.parse(clean.slice(start, end + 1));
}

// =============== REPLIES AND BUTTONS ===============

/** Returns true if the reply was meant for the bot (answer to a question, or a correction to an idea). */
function handleReply_(msg, text) {
  const chatId = msg.chat.id;
  const key = chatId + '_' + msg.reply_to_message.message_id;
  const ask = getJson_('ASK_' + key);

  if (ask) {
    if (!text) return true;
    if (ask.kind === 'info') {
      PROPS.deleteProperty('ASK_' + key);
      const p = ask.p;
      saveNewIdea_(Object.assign({}, p, {
        replyTo: msg.message_id,
        text: (p.text ? p.text + '\n' : '') + text,
        forceSave: true
      }));
      return true;
    }

    const idea = getIdea_(ask.ideaId);
    if (!idea) {
      PROPS.deleteProperty('ASK_' + key);
      sendTelegramMessage(chatId, 'That idea is too old for me to change. Add it to the calendar by hand.', null, msg.message_id);
      return true;
    }
    sendChatAction_(chatId, 'typing');
    const when = parseWhen_(text, idea, ask.kind);
    if (when.error) {
      sendTelegramMessage(chatId,
        `🤷 I couldn't tell the date from that (${esc_(when.error)}). Reply to my question again, e.g. "Sat 7pm", "Nov 9 morning" or "Oct 30".`,
        null, msg.message_id);
      return true;
    }
    PROPS.deleteProperty('ASK_' + key);
    const done = addToCalendar_(idea, ask.kind, when);
    sendTelegramMessage(chatId, done, null, msg.message_id);
    return true;
  }

  const ideaId = PROPS.getProperty('MSG_' + key);
  if (ideaId) {
    const idea = getIdea_(ideaId);
    const photoId = msg.photo ? pickPhoto_(msg.photo).file_id : '';
    if (!idea || (!text && !photoId)) return true;
    sendChatAction_(chatId, 'typing');
    const revised = reviseIdea_(idea, text || 'Here is a screenshot with more details.', photoId);
    const oldTab = idea.tab;
    const fresh = withLock_(() => {
      const cur = getIdea_(ideaId) || idea;
      cur.result = revised;
      updateIdeaRow_(cur);
      saveIdea_(cur);
      return cur;
    });
    editMessage_(chatId, fresh.msgId, ideaText_(fresh), ideaButtons_(fresh));
    const moved = fresh.tab !== oldTab ? ` (moved to ${TABS[fresh.tab].name})` : '';
    sendTelegramMessage(chatId, `✏️ Updated: <b>${esc_(fresh.result.title)}</b>${moved}`, null, msg.message_id);
    return true;
  }
  return false;
}

function handleButton_(cq, chatId) {
  if (!chatId || !isAllowed_(chatId)) { answerCallback_(cq.id); return; }
  const [action, id] = String(cq.data || '').split(':');
  const idea = getIdea_(id);
  if (!idea) {
    answerCallback_(cq.id, 'That idea is too old for buttons. Add it to the calendar by hand.');
    return;
  }
  const kind = { cal: 'event', rem: 'reminder', remok: 'reminder' }[action];
  if (kind && idea.done[kind]) {
    answerCallback_(cq.id, kind === 'event' ? 'That\'s already on the calendar.' : 'That reminder is already on the calendar.');
    return;
  }
  answerCallback_(cq.id); // stop the button's loading spinner right away
  const r = idea.result;

  if (action === 'cal') {
    if (r.when && r.when.date >= today_()) {
      sendTelegramMessage(chatId, addToCalendar_(idea, 'event', r.when), null, idea.msgId);
      return;
    }
    const trip = getTrips_().find(t => t.name === r.trip);
    const askId = sendTelegramMessage(chatId,
      `📅 When should I put <b>${esc_(r.title)}</b> on the calendar? Reply with a day and time, e.g. "Sat 7pm", "Nov 9 morning" or just "Nov 10".` +
      (trip ? `\n(${esc_(trip.name)}: ${fmtDay_(trip.start)} – ${fmtDay_(trip.end)})` : ''),
      { force_reply: true }, idea.msgId);
    if (askId) saveAsk_(chatId, askId, { kind: 'event', ideaId: id });
    return;
  }

  if (action === 'rem') {
    const suggest = r.plan_by && r.plan_by.date >= today_() ? r.plan_by : null;
    const askText = `⏰ When should I remind you to plan <b>${esc_(r.title)}</b>?` +
      (suggest
        ? `\nSuggested: ${fmtDay_(suggest.date)}${suggest.reason ? ' (' + esc_(suggest.reason) + ')' : ''}. Tap to use it, or reply to this message with another date.`
        : ' Reply with a date, e.g. "next Friday" or "Oct 30".');
    const markup = suggest
      ? { inline_keyboard: [[{ text: '✅ ' + fmtDay_(suggest.date), callback_data: 'remok:' + id }]] }
      : { force_reply: true };
    const askId = sendTelegramMessage(chatId, askText, markup, idea.msgId);
    if (askId) saveAsk_(chatId, askId, { kind: 'reminder', ideaId: id });
    return;
  }

  if (action === 'remok') {
    if (!r.plan_by) return;
    const done = addToCalendar_(idea, 'reminder', { date: r.plan_by.date });
    PROPS.deleteProperty('ASK_' + chatId + '_' + cq.message.message_id);
    editMessage_(chatId, cq.message.message_id, done);
  }
}

// =============== CALENDAR ===============

/** Creates the event (or all-day "Plan:" reminder), notes it in the sheet, and returns the confirmation text. */
function addToCalendar_(idea, kind, when) {
  const cal = calendarId_() ? CalendarApp.getCalendarById(calendarId_()) : null;
  if (!cal) throw new Error('Can\'t open the calendar. Check CALENDAR_ID in Config.gs and that this Google account can edit it.');

  // Claim it first, so a double tap can't add it twice
  idea = withLock_(() => {
    const fresh = getIdea_(idea.id);
    if (!fresh || fresh.done[kind]) return null;
    fresh.done[kind] = true;
    saveIdea_(fresh);
    return fresh;
  });
  if (!idea) return kind === 'reminder' ? '⏰ That reminder is already on the calendar.' : '📅 That\'s already on the calendar.';
  try {
    return createCalendarItem_(cal, idea, kind, when);
  } catch (err) {
    idea.done[kind] = false;
    saveIdea_(idea);
    throw err;
  }
}

function createCalendarItem_(cal, idea, kind, when) {
  const r = idea.result;
  const desc = eventDescription_(idea);
  const tz = r.timezone || homeTz_();
  let label;

  if (kind === 'reminder') {
    cal.createAllDayEvent('📝 Plan: ' + r.title, noonOf_(when.date), { description: desc });
    label = '⏰ Plan by ' + fmtDay_(when.date);
  } else if (!when.start_time) {
    cal.createAllDayEvent(r.title, noonOf_(when.date), { description: desc, location: r.where });
    label = '📅 ' + fmtDay_(when.date);
  } else {
    const start = Utilities.parseDate(when.date + ' ' + when.start_time, tz, 'yyyy-MM-dd HH:mm');
    let end = when.end_time ? Utilities.parseDate(when.date + ' ' + when.end_time, tz, 'yyyy-MM-dd HH:mm') : null;
    if (!end || end <= start) end = new Date(start.getTime() + (r.duration_minutes || DEFAULT_EVENT_MIN) * 60000);
    cal.createEvent(r.title, start, end, { description: desc, location: r.where });
    label = '📅 ' + Utilities.formatDate(start, tz, 'EEE, MMM d · h:mm a z');
  }

  withLock_(() => noteCalendar_(idea, label, kind === 'event'));
  editMessage_(idea.chatId, idea.msgId, ideaText_(idea), ideaButtons_(idea));
  return `${kind === 'reminder' ? '⏰ Reminder added' : '📅 Added'} to the ${esc_(cal.getName())} calendar: <b>${esc_(r.title)}</b>, ${esc_(label.replace(/^\S+\s/, ''))}`;
}

function eventDescription_(idea) {
  const r = idea.result;
  const lines = [r.summary, ''];
  if (r.tips.length) lines.push(...r.tips.map(s => '• ' + s), '');
  if (r.when_to_go) lines.push('When to go: ' + r.when_to_go);
  if (r.est_cost) lines.push('Cost: ' + r.est_cost);
  if (r.booking) lines.push('Booking: ' + r.booking);
  if (r.book_url) lines.push('Book: ' + r.book_url);
  if (r.website) lines.push('Website: ' + r.website);
  if (r.map_url) lines.push('Map: ' + r.map_url);
  if (idea.links.length) lines.push('', ...idea.links);
  lines.push('', `Saved by ${idea.by || 'you'} via Telegram`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// =============== SHEET ===============
// Each tab's columns are listed below. Rows are read and written by header name, so you can
// reorder columns or add your own without breaking the bot.

const HIDDEN_HEADERS = ['ID', 'Message', 'Sources']; // far right, hidden
const PLAN_STATUSES = ['Idea', 'Planned', 'Done', 'Skip'];
const PRIORITIES = ['Must', 'Nice', 'Maybe'];
const TABS = {
  Restaurant: {
    name: 'Restaurants', icon: '🍽',
    statuses: ['Want to Try', 'Go Back', 'Once Was Enough'],
    headers: ['Title', 'Area', 'Cuisine', 'Est. Cost', 'Google Rating', 'Summary', 'Must Order', 'Good For', 'Tips',
      'When to Go', 'Booking', 'Book Link', 'Plan By', 'Where', 'Map', 'Commute', 'Status', 'Priority', 'Our Rating',
      'Last Visited', 'Calendar', 'Our Notes', 'Source', 'Added', 'Added By']
  },
  // Things to do in town and on day trips; the tab is named after HOME_CITY in Config.gs
  Local: {
    get name() { return homeTabName_(); }, icon: '🏙', statuses: PLAN_STATUSES,
    headers: ['Title', 'Type', 'Area', 'Summary', 'Tips', 'When to Go', 'Date', 'Time Needed', 'Est. Cost', 'Google Rating',
      'Booking', 'Book Link', 'Plan By', 'Where', 'Map', 'Commute', 'Status', 'Priority', 'Our Rating', 'Calendar',
      'Our Notes', 'Source', 'Added', 'Added By']
  },
  Trip: {
    name: 'Trips', icon: '✈️', statuses: PLAN_STATUSES,
    headers: ['Title', 'Trip', 'Destination', 'Type', 'Area', 'Summary', 'Tips', 'When to Go', 'Date', 'Time Needed',
      'Est. Cost', 'Google Rating', 'Booking', 'Book Link', 'Plan By', 'Where', 'Map', 'Commute', 'Status', 'Priority',
      'Our Rating', 'Calendar', 'Our Notes', 'Source', 'Added', 'Added By']
  },
  Life: {
    name: 'Life', icon: '🌱', statuses: PLAN_STATUSES,
    headers: ['Title', 'Type', 'For Whom', 'Summary', 'Tips', 'Est. Cost', 'Booking', 'Book Link', 'Plan By', 'Status',
      'Priority', 'Our Rating', 'Calendar', 'Our Notes', 'Source', 'Added', 'Added By']
  },
  // Permanent: never archived. A meal planner can read this tab (see README).
  Recipe: {
    name: 'Recipes', icon: '📖', statuses: ['Active', 'Retired'], defaults: { 'Weight': 3, 'Times Made': 0 },
    headers: ['Title', 'Cuisine', 'Main Ingredient', 'Method', 'Effort', 'Active Time', 'Total Time', 'Servings',
      'Seasons', 'Weight', 'Last Made', 'Times Made', 'Our Rating', 'Status', 'Summary', 'Ingredients', 'Tips',
      'Our Notes', 'Source', 'Added', 'Added By']
  },
  Shopping: {
    name: 'Shopping', icon: '🛍', statuses: ['To Buy', 'Bought', 'Skip'],
    headers: ['Title', 'Type', 'For Whom', 'Occasion', 'Summary', 'Est. Cost', 'Where to Buy', 'Best Time to Buy', 'Plan By', 'Status',
      'Priority', 'Calendar', 'Our Notes', 'Source', 'Added', 'Added By']
  }
};
const ARCHIVE_TAB = 'Archive';
const ARCHIVE_HEADERS = ['Title', 'From', 'Archived On', 'Trip', 'Destination', 'Type', 'Area', 'Cuisine', 'Summary',
  'Must Order', 'Good For', 'Tips', 'When to Go', 'Date', 'Time Needed', 'For Whom', 'Occasion', 'Where to Buy', 'Best Time to Buy', 'Est. Cost', 'Google Rating',
  'Booking', 'Book Link', 'Plan By', 'Where', 'Map', 'Commute', 'Status', 'Priority', 'Our Rating', 'Last Visited',
  'Calendar', 'Our Notes', 'Source', 'Added', 'Added By'];
const TRIP_LIST_TAB = 'Trip List';
const TRIP_HEADERS = ['Trip', 'Destination', 'Base', 'Start', 'End', 'Time Zone', 'Notes']; // Base = hotel, for commutes
// Columns the AI writes; a correction rewrites these. Everything else is yours.
const AI_HEADERS = ['Title', 'Area', 'Cuisine', 'Est. Cost', 'Google Rating', 'Summary', 'Good For', 'Tips', 'When to Go',
  'Booking', 'Book Link', 'Plan By', 'Where', 'Map', 'Commute', 'Trip', 'Destination', 'Type', 'Date', 'Time Needed',
  'For Whom', 'Main Ingredient', 'Method', 'Effort', 'Active Time', 'Total Time', 'Servings', 'Ingredients',
  'Occasion', 'Where to Buy', 'Best Time to Buy', 'Sources'];
// The AI suggests these, but a correction only fills them if you left them blank
const PREFILL_HEADERS = ['Must Order'];
// Cells shown as a word with a link behind it
const LINK_HEADERS = ['Title', 'Book Link', 'Map'];

function tabHeaders_(key) { return TABS[key].headers.concat(HIDDEN_HEADERS); }

function archiveHeaders_() {
  const all = ARCHIVE_HEADERS.slice();
  Object.keys(TABS).forEach(k => TABS[k].headers.forEach(h => { if (all.indexOf(h) === -1) all.push(h); }));
  return all.concat(HIDDEN_HEADERS);
}

/** Gets a tab, creating it (with headers and formatting) if it doesn't exist yet. */
function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (sh) return sh;
  const archive = name !== ARCHIVE_TAB && name !== TRIP_LIST_TAB ? ss.getSheetByName(ARCHIVE_TAB) : null;
  sh = ss.insertSheet(name, archive ? archive.getIndex() - 1 : ss.getNumSheets());
  layoutHeaders_(sh, headers);
  return sh;
}

function layoutHeaders_(sh, headers) {
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  const col = h => headers.indexOf(h) + 1;
  HIDDEN_HEADERS.forEach(h => { if (col(h)) sh.hideColumns(col(h)); });
  ['Summary', 'Tips', 'Ingredients'].forEach(h => {
    if (!col(h)) return;
    sh.setColumnWidth(col(h), 300);
    sh.getRange(1, col(h), sh.getMaxRows(), 1).setWrap(true);
  });
}

/** Adds any missing headers to an existing tab, each right after the nearest earlier one. Returns what it added. */
function ensureHeaders_(sh, headers) {
  const added = [];
  headers.forEach((h, i) => {
    const cols = headerMap_(sh);
    if (cols[h]) return;
    let after = 0;
    for (let j = i - 1; j >= 0 && !after; j--) after = cols[headers[j]] || 0;
    if (after) sh.insertColumnAfter(after); else sh.insertColumnBefore(1);
    const col = after + 1;
    sh.getRange(1, col).setValue(h).setFontWeight('bold');
    if (HIDDEN_HEADERS.indexOf(h) !== -1) sh.hideColumns(col);
    added.push(h);
  });
  return added;
}

/**
 * Brings a tab's columns up to date. A tab with no rows yet is simply laid out fresh; a tab with
 * data only gains columns, and any it no longer uses are reported so you can delete them by hand.
 */
function syncHeaders_(sh, headers) {
  const current = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim()) : [];
  if (current.join('|') === headers.join('|')) return 'up to date';
  if (sh.getLastRow() <= 1) {
    sh.clear();
    sh.showColumns(1, sh.getMaxColumns());
    layoutHeaders_(sh, headers);
    return 'set up with the latest columns';
  }
  const added = ensureHeaders_(sh, headers);
  const unused = current.filter(h => h && headers.indexOf(h) === -1);
  return (added.length ? 'added ' + added.join(', ') : 'up to date') +
    (unused.length ? '. No longer used (delete them if you like): ' + unused.join(', ') : '');
}

function tabSheet_(key) { return getSheet_(TABS[key].name, tabHeaders_(key)); }
function archiveSheet_() { return getSheet_(ARCHIVE_TAB, archiveHeaders_()); }

function tripListSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TRIP_LIST_TAB);
  if (sh) return sh;
  sh = getSheet_(TRIP_LIST_TAB, TRIP_HEADERS); // starts empty: add a row per trip (see SETUP.md)
  sh.getRange(2, TRIP_HEADERS.indexOf('Start') + 1, sh.getMaxRows() - 1, 2).setNumberFormat('yyyy-mm-dd');
  return sh;
}

/** Every trip in the Trip List, dates as yyyy-MM-dd strings. */
function readTrips_() {
  const sh = tripListSheet_();
  if (sh.getLastRow() < 2) return [];
  const cols = headerMap_(sh);
  const str = v => String(v === null || v === undefined ? '' : v).trim();
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues()
    .map(row => rowObject_(cols, row))
    .map(rec => ({
      name: str(rec['Trip']),
      destination: str(rec['Destination']),
      base: str(rec['Base']),
      start: dateStr_(rec['Start']),
      end: dateStr_(rec['End']),
      tz: str(rec['Time Zone']) || homeTz_(),
      notes: str(rec['Notes'])
    }))
    .filter(t => t.name && isDate_(t.start) && isDate_(t.end));
}

/** Trips that haven't ended yet. */
function getTrips_() {
  const today = today_();
  return readTrips_().filter(t => t.end >= today);
}

/** A sheet date cell (Date, or text like 2026-11-07) as yyyy-MM-dd, or '' if it isn't one. */
function dateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  const s = String(v || '').trim().slice(0, 10);
  return isDate_(s) ? s : '';
}

function headerMap_(sh) {
  const map = {};
  if (!sh.getLastColumn()) return map;
  sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].forEach((h, i) => { if (h) map[String(h).trim()] = i + 1; });
  return map;
}

function rowObject_(cols, values) {
  const rec = {};
  Object.keys(cols).forEach(h => { rec[h] = values[cols[h] - 1]; });
  return rec;
}

/** Appends {header: value} as a new row and returns its row number. */
function appendRecord_(sh, cols, rec) {
  const out = new Array(sh.getLastColumn()).fill('');
  Object.keys(rec).forEach(h => { if (cols[h]) out[cols[h] - 1] = rec[h] === null || rec[h] === undefined ? '' : rec[h]; });
  sh.appendRow(out);
  return sh.getLastRow();
}

/** Everything the bot knows about an idea, by column name. Each tab uses only its own columns. */
function fieldValues_(idea) {
  const r = idea.result;
  const whenText = r.when ? r.when.date + (r.when.start_time ? ' ' + r.when.start_time : '') : '';
  return {
    'Title': r.title, 'Area': r.area, 'Cuisine': r.cuisine, 'Est. Cost': r.est_cost, 'Google Rating': r.google_rating,
    'Summary': r.summary, 'Must Order': r.must_order, 'Good For': r.good_for, 'Tips': r.tips.map(s => '• ' + s).join('\n'),
    'When to Go': r.when_to_go, 'Booking': r.booking, 'Book Link': bookLabel_(r), 'Plan By': r.plan_by ? r.plan_by.date : '',
    'Where': r.where, 'Map': r.map_url ? 'Map' : '', 'Commute': r.commute,
    'Trip': r.trip, 'Destination': r.destination,
    'Type': r.category === 'Shopping' ? r.shop_type : r.type, 'Effort': r.effort, 'Date': whenText, 'Time Needed': r.time_needed,
    'For Whom': r.for_whom, 'Main Ingredient': r.main_ingredient, 'Method': r.method,
    'Active Time': r.active_time, 'Total Time': r.total_time, 'Servings': r.servings, 'Ingredients': r.ingredients.join('\n'),
    'Occasion': r.occasion, 'Where to Buy': r.where_to_buy, 'Best Time to Buy': r.best_time_to_buy, 'Source': idea.links.join('\n'), 'Added': new Date(idea.addedAt), 'Added By': idea.by,
    'ID': idea.id, 'Message': idea.text, 'Sources': (r.searched_sites || []).join('\n')
  };
}

function linkUrls_(r) { return { 'Title': r.website, 'Book Link': r.book_url, 'Map': r.map_url }; }

function bookLabel_(r) {
  if (!r.book_url) return '';
  if (r.book_platform) return r.book_platform;
  return /^https:\/\/www\.google\.com\/search/.test(r.book_url) ? 'Search' : 'Book';
}

/** Puts the links behind the words in the Title, Book Link and Map cells. */
function applyLinks_(sh, cols, row, urls) {
  LINK_HEADERS.forEach(h => {
    if (!cols[h] || !urls[h]) return;
    const cell = sh.getRange(row, cols[h]);
    const text = String(cell.getValue() || '');
    if (text) cell.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(text).setLinkUrl(urls[h]).build());
  });
}

/** Number formats and dropdowns for one row. */
function formatRow_(sh, cols, row, key) {
  const list = values => SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build();
  if (cols['Added']) sh.getRange(row, cols['Added']).setNumberFormat('yyyy-mm-dd h:mm');
  ['Archived On', 'Last Visited', 'Last Made', 'Plan By'].forEach(h => { if (cols[h]) sh.getRange(row, cols[h]).setNumberFormat('yyyy-mm-dd'); });
  if (key && cols['Status']) sh.getRange(row, cols['Status']).setDataValidation(list(TABS[key].statuses));
  if (cols['Priority']) sh.getRange(row, cols['Priority']).setDataValidation(list(PRIORITIES));
  if (cols['Weight']) {
    sh.getRange(row, cols['Weight']).setDataValidation(
      SpreadsheetApp.newDataValidation().requireNumberBetween(1, 5).setAllowInvalid(false)
        .setHelpText('How often a meal planner should pick this: 1 (rarely) to 5 (often)').build());
  }
  if (cols['Our Rating']) {
    sh.getRange(row, cols['Our Rating']).setDataValidation(
      SpreadsheetApp.newDataValidation().requireNumberBetween(1, 5).setAllowInvalid(false)
        .setHelpText('Rate it 1 (meh) to 5 (amazing)').build());
  }
}

function appendIdea_(idea) {
  const key = idea.result.category;
  const sh = tabSheet_(key);
  const cols = headerMap_(sh);
  const row = appendRecord_(sh, cols, Object.assign(fieldValues_(idea), TABS[key].defaults || {}, { 'Status': TABS[key].statuses[0] }));
  formatRow_(sh, cols, row, key);
  applyLinks_(sh, cols, row, linkUrls_(idea.result));
  idea.tab = key;
}

/**
 * After a correction: rewrites the AI columns in place, or moves the row if the idea now belongs
 * on another tab (keeping your notes, rating, priority, calendar entries and, if it still fits, the status).
 */
function updateIdeaRow_(idea) {
  const oldKey = idea.tab;
  const newKey = idea.result.category;
  const sh = tabSheet_(oldKey);
  const cols = headerMap_(sh);
  const row = findRow_(sh, cols, idea.id);
  const fresh = fieldValues_(idea);

  if (!row) { // deleted or archived by hand: start a new row
    appendIdea_(idea);
    return;
  }

  if (newKey === oldKey) {
    AI_HEADERS.forEach(h => { if (cols[h]) sh.getRange(row, cols[h]).setValue(fresh[h]); });
    PREFILL_HEADERS.forEach(h => {
      if (cols[h] && !String(sh.getRange(row, cols[h]).getValue()).trim()) sh.getRange(row, cols[h]).setValue(fresh[h]);
    });
    applyLinks_(sh, cols, row, linkUrls_(idea.result));
    return;
  }

  const old = rowObject_(cols, sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0]);
  const rec = Object.assign({}, old, fresh);
  ['Priority', 'Our Rating', 'Last Visited', 'Seasons', 'Weight', 'Last Made', 'Times Made', 'Calendar', 'Our Notes',
    'Source', 'Added', 'Added By', 'Message'].forEach(h => { if (h in old) rec[h] = old[h]; });
  Object.keys(TABS[newKey].defaults || {}).forEach(h => { if (rec[h] === '' || rec[h] === undefined) rec[h] = TABS[newKey].defaults[h]; });
  PREFILL_HEADERS.forEach(h => { if (String(old[h] || '').trim()) rec[h] = old[h]; });
  rec['Status'] = TABS[newKey].statuses.indexOf(old['Status']) !== -1 ? old['Status'] : TABS[newKey].statuses[0];

  const target = tabSheet_(newKey);
  const tcols = headerMap_(target);
  const newRow = appendRecord_(target, tcols, rec);
  formatRow_(target, tcols, newRow, newKey);
  applyLinks_(target, tcols, newRow, linkUrls_(idea.result));
  sh.deleteRow(row);
  idea.tab = newKey;
}

function noteCalendar_(idea, label, planned) {
  const sh = tabSheet_(idea.tab);
  const cols = headerMap_(sh);
  const row = findRow_(sh, cols, idea.id);
  if (!row) return;
  const cell = sh.getRange(row, cols['Calendar']);
  const prev = String(cell.getValue() || '');
  cell.setValue(prev ? prev + '\n' + label : label);
  const status = sh.getRange(row, cols['Status']);
  if (planned && status.getValue() === 'Idea') status.setValue('Planned');
}

function findRow_(sh, cols, id) {
  if (!cols['ID'] || sh.getLastRow() < 2) return 0;
  const hit = sh.getRange(2, cols['ID'], sh.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

/** Was this link saved before (on any tab, archive included)? Returns {title, added, by, tab} or null. */
function findDuplicate_(url) {
  const sheets = Object.keys(TABS).map(tabSheet_).concat([archiveSheet_()]);
  for (const sh of sheets) {
    if (sh.getLastRow() < 2) continue;
    const cols = headerMap_(sh);
    if (!cols['Source']) continue;
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
    const row = rows.find(r => String(r[cols['Source'] - 1]).split('\n').indexOf(url) !== -1);
    if (!row) continue;
    const rec = rowObject_(cols, row);
    return {
      title: String(rec['Title'] || ''),
      added: rec['Added'] instanceof Date ? Utilities.formatDate(rec['Added'], homeTz_(), 'MMM d') : String(rec['Added'] || '').slice(0, 10),
      by: String(rec['Added By'] || ''),
      tab: sh.getName()
    };
  }
  return null;
}

// =============== ARCHIVE ===============

/**
 * Nightly (and runnable by hand): moves finished rows to the Archive tab.
 * - Trips: every row for a trip whose end date has passed; "Someday" rows once Done or Skip.
 * - Local (your city): Done or Skip, or a dated event whose date has passed.
 * - Life: Done or Skip.
 * - Restaurants: Once Was Enough ("Go Back" stays; that's your return list).
 * - Shopping: Bought or Skip (so past gifts are on record).
 * - Recipes: never.
 */
function archiveOld() {
  withLock_(() => {
    const today = today_();
    const ended = {};
    readTrips_().forEach(t => { if (t.end < today) ended[t.name.toLowerCase()] = true; });
    const arch = archiveSheet_();
    const acols = headerMap_(arch);
    let moved = 0;

    Object.keys(TABS).forEach(key => {
      const sh = tabSheet_(key);
      if (sh.getLastRow() < 2) return;
      const cols = headerMap_(sh);
      const range = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn());
      const rows = range.getValues();
      const rich = range.getRichTextValues(); // to carry the links across
      for (let i = rows.length - 1; i >= 0; i--) { // bottom up, so deleting doesn't shift rows still to check
        const rec = rowObject_(cols, rows[i]);
        if (!rec['Title'] || !shouldArchive_(key, rec, ended, today)) continue;
        rec['From'] = TABS[key].name;
        rec['Archived On'] = new Date();
        const newRow = appendRecord_(arch, acols, rec);
        formatRow_(arch, acols, newRow);
        const urls = {};
        LINK_HEADERS.forEach(h => { const rt = cols[h] && rich[i][cols[h] - 1]; urls[h] = rt ? rt.getLinkUrl() : ''; });
        applyLinks_(arch, acols, newRow, urls);
        sh.deleteRow(i + 2);
        moved++;
      }
    });
    Logger.log('Archived ' + moved + ' row(s).');
  });
}

function shouldArchive_(key, rec, endedTrips, today) {
  const status = String(rec['Status'] || '').trim();
  const finished = status === 'Done' || status === 'Skip';
  if (key === 'Restaurant') return status === 'Once Was Enough';
  if (key === 'Recipe') return false; // the recipe book is permanent
  if (key === 'Shopping') return status === 'Bought' || status === 'Skip';
  if (key === 'Trip') {
    const trip = String(rec['Trip'] || '').trim().toLowerCase();
    if (!trip || trip === 'someday') return finished;
    return !!endedTrips[trip];
  }
  if (finished) return true;
  if (key === 'Local') {
    const d = dateStr_(rec['Date']);
    return !!d && d < today;
  }
  return false;
}

// =============== MESSAGES ===============

function ideaText_(idea) {
  const r = idea.result;
  const tab = TABS[r.category];
  const tags = [];
  if (r.category === 'Trip') tags.push(r.trip === 'Someday' && r.destination ? 'Someday · ' + r.destination : r.trip);
  if (r.category === 'Restaurant' || r.category === 'Recipe') { if (r.cuisine) tags.push(r.cuisine); }
  if (r.category === 'Recipe') { if (r.main_ingredient) tags.push(r.main_ingredient); }
  else if (r.category === 'Shopping') { if (r.shop_type) tags.push(r.shop_type); }
  else if (r.category !== 'Restaurant' && r.type) tags.push(r.type);

  const title = r.website ? `<a href="${escAttr_(r.website)}">${esc_(r.title)}</a>` : esc_(r.title);
  const lines = [`✅ Saved to ${tab.icon} ${tab.name}${tags.length ? ' · ' + esc_(tags.join(' · ')) : ''}`, '', `<b>${title}</b>`];
  const placeLine = [r.area, r.commute].filter(Boolean).join(' · ');
  if (placeLine) lines.push('📍 ' + esc_(placeLine));
  if (r.google_rating) lines.push('⭐ ' + esc_(r.google_rating) + ' on Google');
  if (r.category === 'Recipe') {
    const times = [r.active_time && r.active_time + ' active', r.total_time && r.total_time + ' total'].filter(Boolean).join(' / ');
    const recipeLine = [r.method && '🔥 ' + r.method, times && '⏱ ' + times, r.servings && '🍽 Serves ' + r.servings, r.effort].filter(Boolean);
    if (recipeLine.length) lines.push(esc_(recipeLine.join(' · ')));
  }
  if (r.summary) lines.push('', esc_(r.summary));
  if (r.category === 'Recipe') {
    if (r.ingredients.length) {
      const shown = r.ingredients.slice(0, 8).map(s => '• ' + esc_(s));
      if (r.ingredients.length > 8) shown.push(`…and ${r.ingredients.length - 8} more (all in the sheet)`);
      lines.push('', `<b>Ingredients (${r.ingredients.length})</b>`, ...shown);
    } else {
      lines.push('', '⚠️ I couldn\'t find the ingredients. Reply to this message with a screenshot of the recipe (or paste it) and I\'ll add them.');
    }
  }

  const facts = [];
  if (r.must_order) facts.push('🍴 Known for: ' + esc_(r.must_order));
  if (r.good_for) facts.push('👥 Good for: ' + esc_(r.good_for));
  if (r.for_whom) facts.push('🎁 For: ' + esc_(r.for_whom) + (r.occasion ? ' · ' + esc_(r.occasion) : ''));
  if (r.where_to_buy) facts.push('🏬 ' + esc_(r.where_to_buy));
  if (r.best_time_to_buy) facts.push('🏷 ' + esc_(r.best_time_to_buy));
  if (r.when_to_go) facts.push('🕐 ' + esc_(r.when_to_go));
  if (r.time_needed) facts.push('⏱ ' + esc_(r.time_needed));
  if (r.est_cost) facts.push('💵 ' + esc_(r.est_cost));
  if (r.booking) facts.push('🎟 ' + esc_(r.booking));
  if (r.when) facts.push('🗓 ' + fmtWhen_(r.when, r.timezone));
  if (r.plan_by) facts.push(`⏰ ${r.category === 'Shopping' ? 'Buy' : 'Plan'} by ${fmtDay_(r.plan_by.date)}${r.plan_by.reason ? ' (' + esc_(r.plan_by.reason) + ')' : ''}`);
  if (facts.length) lines.push('', ...facts);
  if (r.tips.length) lines.push('', ...r.tips.map(s => '💡 ' + esc_(s)));

  const added = [];
  if (idea.done.event) added.push('📅 on the calendar');
  if (idea.done.reminder) added.push('⏰ reminder set');
  if (added.length) lines.push('', added.join(' · '));
  if (r.category === 'Recipe') lines.push('', '<i>Set Seasons and Weight in the sheet. Reply to this message to change anything.</i>');
  else lines.push('', '<i>Reply to this message to change anything.</i>');
  return lines.join('\n');
}

function ideaButtons_(idea) {
  const r = idea.result;
  const rows = [];
  const links = [];
  if (r.book_url) {
    links.push({
      text: r.book_platform ? `${r.category === 'Restaurant' ? '🍽 Reserve' : '🎟 Book'} on ${r.book_platform}` : '🔎 Find where to book',
      url: r.book_url
    });
  }
  if (r.map_url) links.push({ text: '📍 Map', url: r.map_url });
  if (r.website && r.category === 'Recipe') links.push({ text: '📖 Open recipe', url: r.website });
  if (r.website && r.category === 'Shopping') links.push({ text: '🛒 View product', url: r.website });
  if (links.length) rows.push(links);
  if (r.category === 'Recipe') return { inline_keyboard: rows }; // choosing cooking dates is a meal planner's job
  if (!calendarId_()) return { inline_keyboard: rows }; // no calendar set up
  const row = [];
  if (!idea.done.event) row.push({ text: '📅 Add to calendar', callback_data: 'cal:' + idea.id });
  if (!idea.done.reminder) row.push({ text: '⏰ Plan reminder', callback_data: 'rem:' + idea.id });
  if (row.length) rows.push(row);
  return { inline_keyboard: rows };
}

// =============== STORED STATE (Script Properties) ===============

function getIdea_(id) { return id ? getJson_('IDEA_' + id) : null; }
function saveIdea_(idea) { PROPS.setProperty('IDEA_' + idea.id, JSON.stringify(idea)); }

/** Keeps the newest KEEP_IDEAS ideas so buttons and replies work on them; older ones live only in the sheet. */
function rememberIdea_(idea) {
  withLock_(() => {
    saveIdea_(idea);
    if (idea.msgId) PROPS.setProperty('MSG_' + idea.chatId + '_' + idea.msgId, idea.id);
    const index = getJson_('IDEA_INDEX') || [];
    index.push(idea.id);
    while (index.length > KEEP_IDEAS) {
      const oldId = index.shift();
      const old = getIdea_(oldId);
      if (old && old.msgId) PROPS.deleteProperty('MSG_' + old.chatId + '_' + old.msgId);
      PROPS.deleteProperty('IDEA_' + oldId);
    }
    PROPS.setProperty('IDEA_INDEX', JSON.stringify(index));
  });
  pruneAsks_();
}

function saveAsk_(chatId, msgId, ask) {
  ask.at = Date.now();
  PROPS.setProperty('ASK_' + chatId + '_' + msgId, JSON.stringify(ask));
}

function pruneAsks_() {
  const cutoff = Date.now() - ASK_TTL_DAYS * 86400000;
  const all = PROPS.getProperties();
  Object.keys(all).filter(k => k.indexOf('ASK_') === 0).forEach(k => {
    let at = 0;
    try { at = JSON.parse(all[k]).at || 0; } catch (_) {}
    if (at < cutoff) PROPS.deleteProperty(k);
  });
}

function getJson_(key) {
  const s = PROPS.getProperty(key);
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return null; }
}

// =============== TELEGRAM ===============

function sendTelegramMessage(chatId, text, replyMarkup, replyToId) {
  const payload = { chat_id: chatId, text: text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyToId) payload.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true };
  const res = tgCall_('sendMessage', payload);
  if (res && !res.ok) Logger.log('sendMessage failed: ' + JSON.stringify(res));
  return res && res.ok ? res.result.message_id : null;
}

function editMessage_(chatId, messageId, text, replyMarkup) {
  if (!messageId) return;
  tgCall_('editMessageText', {
    chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }, reply_markup: replyMarkup || { inline_keyboard: [] }
  });
}

function answerCallback_(callbackId, text) {
  const payload = { callback_query_id: callbackId };
  if (text) { payload.text = text; payload.show_alert = true; }
  tgCall_('answerCallbackQuery', payload);
}

function sendChatAction_(chatId, action) { tgCall_('sendChatAction', { chat_id: chatId, action: action }); }

function tgCall_(method, payload) {
  const res = UrlFetchApp.fetch(`${tgBase_()}/${method}`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  try { return JSON.parse(res.getContentText()); } catch (_) { return null; }
}

// =============== UTILITIES ===============

function escAttr_(s) { return esc_(s).replace(/"/g, '&quot;'); }

function esc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function isTime_(s) { return /^\d{2}:\d{2}$/.test(String(s || '')); }
function today_() { return Utilities.formatDate(new Date(), homeTz_(), 'yyyy-MM-dd'); }

/** Noon avoids an all-day item landing on the wrong day if the script's time zone differs. */
function noonOf_(dateStr) { return Utilities.parseDate(dateStr + ' 12:00', homeTz_(), 'yyyy-MM-dd HH:mm'); }
function fmtDay_(dateStr) { return Utilities.formatDate(noonOf_(dateStr), homeTz_(), 'EEE, MMM d'); }

function fmtWhen_(when, tz) {
  if (!when.start_time) return fmtDay_(when.date);
  const start = Utilities.parseDate(when.date + ' ' + when.start_time, tz || homeTz_(), 'yyyy-MM-dd HH:mm');
  return Utilities.formatDate(start, tz || homeTz_(), 'EEE, MMM d · h:mm a z');
}

function markSeen_(updateId) {
  const seen = JSON.parse(PROPS.getProperty('SEEN_IDS') || '[]');
  if (seen.indexOf(updateId) !== -1) return false;
  seen.push(updateId);
  PROPS.setProperty('SEEN_IDS', JSON.stringify(seen.slice(-200)));
  return true;
}

function withLock_(fn) {
  if (LOCK_HELD) return fn();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  LOCK_HELD = true;
  try {
    return fn();
  } finally {
    LOCK_HELD = false;
    lock.releaseLock();
  }
}

function ok_() { return ContentService.createTextOutput('OK'); }

// =============== RUN THESE MANUALLY FROM THE EDITOR ===============

/** First run: creates the tabs and the nightly archive, asks for permissions, and checks the calendar. */
function setup() {
  if (homeTabName_() === 'Local') Logger.log('Tip: set HOME_CITY in Config.gs (e.g. \'Austin, TX\'); the in-town tab is named after it.');
  // Creates missing tabs and brings existing ones up to the latest columns
  const sheets = Object.keys(TABS).map(k => [tabSheet_(k), tabHeaders_(k)])
    .concat([[archiveSheet_(), archiveHeaders_()], [tripListSheet_(), TRIP_HEADERS]]);
  sheets.forEach(([sh, headers]) => Logger.log(sh.getName() + ': ' + syncHeaders_(sh, headers)));
  if (!getTrips_().every(t => t.base)) Logger.log('Tip: add your hotel to the Base column of the Trip List so trip ideas get commute times.');
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'archiveOld')) {
    ScriptApp.newTrigger('archiveOld').timeBased().everyDays(1).atHour(3).inTimezone(homeTz_()).create();
  }
  Logger.log('Tabs ready. Archive runs nightly around 3 AM.');
  const cal = calendarId_() ? CalendarApp.getCalendarById(calendarId_()) : null;
  Logger.log(!calendarId_() ? 'CALENDAR_ID is blank in Config.gs: calendar buttons are off (everything else works).' : cal
    ? 'Calendar OK: "' + cal.getName() + '"'
    : 'Calendar NOT found. Run listCalendars() and copy the right ID into CALENDAR_ID in Config.gs (the calendar buttons need it).');
  Logger.log(homeAddress_() ? 'Home address set: in-town ideas get commute times.' : 'HOME_ADDRESS is blank in Config.gs: in-town ideas won\'t get commute times.');
  Logger.log(placesKey_() ? 'Places key set: Google ratings on.' : 'PLACES_API_KEY is blank in Config.gs: Google Rating stays empty (everything else works).');
  Logger.log('Trips: ' + JSON.stringify(getTrips_()));
}

/** Logs every calendar this Google account can see, with its ID. */
function listCalendars() {
  CalendarApp.getAllCalendars().forEach(c => Logger.log(c.getName() + '  →  ' + c.getId()));
}

/** Tries the AI on a sample idea without Telegram or the sheet. Edit the text to test others. */
function testIdea() {
  const text = 'Try the best pizza place downtown';
  const r = analyzeIdea_(text, [], '', getTrips_());
  Logger.log(JSON.stringify(r, null, 2));
}

/** Tries reading a link the way the bot does. Paste any TikTok/Instagram/web link. */
function testLink() {
  const url = 'PASTE A LINK HERE';
  Logger.log(JSON.stringify(fetchLinkInfo_(url), null, 2));
}

/** Points Telegram at the Worker (messages + button taps). */
function switchToWorker() {
  const res = tgCall_('setWebhook', {
    url: WORKER_URL,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query']
  });
  Logger.log('setWebhook: ' + JSON.stringify(res));
}

/** Shows webhook status. */
function checkWebhook() {
  Logger.log(JSON.stringify(tgCall_('getWebhookInfo', {})));
}
