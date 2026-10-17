# Shared Planner Bot (lite)

Public, generic Telegram bot for a household's shared plans: send a TikTok/Instagram/web link, a screenshot,
or a sentence → Gemini (+ Google Search) identifies it and writes practical notes → row on the right Sheet
tab → optional event or "Plan:" reminder on a shared Google Calendar. This repo is public: never add
anyone's personal details, real addresses, IDs, URLs or keys to committed files. Real values live only in
Config.gs inside Apps Script (gitignored).

## Architecture
Telegram → webhook → Cloudflare Worker (worker/worker.js, relay only; answers Telegram instantly, forwards to
Apps Script with ?secret=) → Apps Script web app (doPost, bound to the Sheet) → link lookups + Gemini →
Sheet + CalendarApp. Never point Telegram straight at Apps Script (302 → retries, duplicates).

- Config.gs (template Config.example.gs). Required: BOT_TOKEN, GEMINI_API_KEY, ALLOWED_CHAT_IDS, HOME_CITY,
  HOME_TIMEZONE, WEBHOOK_SECRET, WORKER_URL. Optional (typeof-guarded so an older Config.gs keeps working):
  CALENDAR_ID (blank = no calendar buttons), HOME_ADDRESS (commutes), PLACES_API_KEY (ratings, websites,
  addresses, Maps links), HOUSEHOLD_NAMES (prompt wording; blank = "a household").
- Config values are read inside functions (homeArea_, homeTz_, homeTabName_, calendarId_, householdLine_),
  never at top level, so Apps Script file order doesn't matter.
- Tabs (setup() creates them; new bot tabs go before Archive): Restaurants, <city> (category key "Local";
  name = HOME_CITY before the comma, "Local" if unset, via a getter on TABS.Local), Trips, Life, Recipes,
  Shopping, Archive, Trip List (starts empty; Trip, Destination, Base, Start, End, Time Zone, Notes).
- Each tab's column order is TABS[key].headers; hidden ID/Message/Sources at the far right. Rows are read and
  written by header name (headerMap_), so users can reorder or add columns. syncHeaders_ lays out empty tabs
  fresh, only adds columns to tabs with data, and reports unused ones. New columns: add to TABS (and
  AI_HEADERS if the AI owns them); users rerun setup(). Never require deleting tabs that hold data.
- Ownership: AI_HEADERS are rewritten on a correction; PREFILL_HEADERS (Must Order) only if blank; everything
  else (Status, Priority, Our Rating, Our Notes, Calendar, Last Visited, Seasons, Weight, Last Made, Times
  Made…) belongs to the user. A correction that changes category moves the row, keeping user columns.
- Script Properties: SEEN_IDS, IDEA_<id> (newest KEEP_IDEAS), IDEA_INDEX, MSG_<chat>_<msg> → idea id,
  ASK_<chat>_<msg> (pending questions, expire after ASK_TTL_DAYS). The Sheet is the permanent record.

## Behavior to preserve
- Privacy mode must be disabled in BotFather; Gemini's is_idea=false keeps the bot quiet on chit-chat.
- Calendar is only written after a button tap. 📅 adds straight away if the idea has a fixed date, else asks
  "when?" (force_reply). ⏰ adds an all-day "📝 Plan: <title>" item; plan_by is offered as a one-tap button.
  done.event / done.reminder are claimed under the lock first, so double taps can't duplicate.
- Timed events use the idea's IANA time zone (trip ideas → the trip's zone).
- Links: short links resolved by hand; TikTok/YouTube via oEmbed; Instagram via og: tags (often blocked) →
  if Gemini can't tell what it is, the bot asks for a few words. Duplicate links (same cleaned URL in any
  tab's Source column, Archive included) aren't saved twice.
- enrichPlace_: Places text search when PLACES_API_KEY is set and Gemini says specific_place (namesOverlap_
  stops another business's rating being attached), website check, Maps link, commute via the built-in
  Maps.DirectionFinder from HOME_ADDRESS or the trip's Base (walk if ≤ WALK_MAX_MIN, else drive + transit).
- Booking links are found via search, never constructed; linkOpens_ checks them (401/403/429/503 from known
  big sites counts as real). Broken → a Google search for "<title> <area> reservations". No booking APIs.
- Recipes: recipeFromHtml_ tries JSON-LD (type matched case-insensitively), then itemprop="recipeIngredient"
  microdata, then the text under the page's "Ingredients" heading. Ingredients are never invented. Replies to a
  saved recipe re-read its page; a reply with a screenshot revises the idea. Recipes get no calendar buttons
  and are never archived. Seasons is the user's; the bot never fills it.
- Shopping: Household/Gift, To Buy/Bought/Skip; Best Time to Buy is the usual sale pattern ("usually");
  plan_by = next good sale before any deadline, else the order-by date. Groceries are answered, not saved.
- archiveOld() runs nightly ~3 AM (trigger from setup()); rules in shouldArchive_.

## Testing
tests/harness.js runs Code.gs + Config.example.gs in a Node vm with fakes for Telegram, Gemini (queue answers
with setGemini), Sheets (incl. rich-text links), Calendar, Maps and UrlFetch pages. MINIMAL_CONFIG=1 blanks
every optional setting. Run all: `for f in tests/*.test.js; do node "$f"; done`. Keep fixtures fictional.
