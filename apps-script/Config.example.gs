// ===================== CONFIG (private) =====================
// In Apps Script, create a file named Config.gs with this content and your REAL values.
// Never commit Config.gs anywhere public. This example file (fake values) is safe to share.
// SETUP.md explains where each value comes from.

// ----- Required -----
const BOT_TOKEN        = 'YOUR_TELEGRAM_BOT_TOKEN';   // from @BotFather (no "bot" prefix)
const GEMINI_API_KEY   = 'YOUR_GEMINI_API_KEY';       // from Google AI Studio (paid tier for Google Search lookups)
const ALLOWED_CHAT_IDS = '';                          // comma-separated chat IDs (send /id in each chat); blank = bot answers nobody
const HOME_CITY        = '';                          // e.g. 'Austin, TX'; the in-town tab is named after the city ("Austin")
const HOME_TIMEZONE    = 'America/New_York';          // your IANA time zone, e.g. 'America/New_York', 'Europe/London'

// Must match the WEBHOOK_SECRET stored in your Cloudflare Worker
const WEBHOOK_SECRET   = 'LettersAndNumbersOnly';
const WORKER_URL       = 'https://your-worker.your-subdomain.workers.dev';

// ----- Optional (leave blank to skip) -----
const CALENDAR_ID      = '';                          // calendar for the 📅 / ⏰ buttons; run listCalendars() to find it
const HOME_ADDRESS     = '';                          // where in-town commute times start, e.g. '123 Main St, Austin, TX'
const PLACES_API_KEY   = '';                          // Google Places key: ratings, official websites, exact addresses, Maps links
const HOUSEHOLD_NAMES  = '';                          // e.g. 'Alex and Sam', so the AI knows who it's helping
