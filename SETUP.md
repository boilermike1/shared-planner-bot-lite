# Setup Guide

This guide walks you through setting up your own Shared Planner Bot. **You don't need to know how to code.** You'll copy and paste a few files and click through some websites. Plan on 45–60 minutes.

> **Tip:** Websites move their buttons around. If something here doesn't match what you see, look for a button with a similar name. The steps stay the same.

---

## What you'll end up with

A private Telegram bot for your household. Send it a TikTok or Instagram link, a web link, a screenshot, or a sentence ("try the new taco place downtown"). It works out what the idea is, looks up the practical details, and files it in a Google Sheet. Tap a button to put the idea on a shared Google Calendar.

## What each service does

| Service | What it does | Cost |
|---|---|---|
| **Telegram** | The chat app where you talk to the bot | Free |
| **Google Gemini** | The AI that reads your messages and writes the notes | Free tier available; paid tier recommended (Step 4) |
| **Google Sheets + Apps Script** | Stores your ideas and runs the bot's "brain" | Free |
| **Cloudflare Workers** | A small relay that receives messages from Telegram and hands them to Google | Free |
| **Google Calendar** *(optional)* | Where the 📅 and ⏰ buttons add events | Free |
| **Google Places API** *(optional)* | Google ratings, official websites, exact addresses and Maps links | Free monthly allowance; needs billing turned on (Step 6) |

## Keep a notepad open

You'll collect several codes along the way. Paste each one into a blank note as you get it.

| Item | Where you get it |
|---|---|
| Telegram bot token | Step 1 |
| Gemini API key | Step 4 |
| Places API key *(optional)* | Step 6 |
| Webhook secret | Step 7 (you make it up) |
| Apps Script web app URL | Step 9 |
| Cloudflare Worker URL | Step 10 |
| Chat IDs | Step 12 |

> 🔒 **Treat the token and keys like passwords.** Anyone who has them can control your bot or spend your AI credits. Don't post them online or share screenshots that show them. Delete the note when you're done.

---

## Step 1: Create the bot

1. Install Telegram ([telegram.org](https://telegram.org)) and create an account if you don't have one.
2. Search for **@BotFather** and open the one with the **blue checkmark**. Tap **Start**.
3. Send `/newbot`.
4. Pick a **name** (what you'll see in your chat list, e.g. `Our Planner`) and a **username** (unique, ending in `bot`, e.g. `smith_planner_bot`).
5. BotFather replies with a long code like `1234567890:AAH...`. That's your **bot token**. Copy it into your notepad.

## Step 2: Let the bot read your group chat

By default, bots in a group only see commands. This bot needs to see every message, or it won't notice your ideas.

1. Still in BotFather, send `/setprivacy`, pick your bot, and choose **Disable**.
2. Do this **before** the next step. If the bot is already in a group, remove it and add it back afterwards, or the change won't apply.

> The bot ignores chit-chat like "lol" or "sounds good", so a group just for ideas works best.

## Step 3: Make the group

In Telegram, create a new group with the people you plan with, and add your bot. You can also message the bot one-on-one; Step 12 covers that.

## Step 4: Get a Gemini API key

1. Go to [aistudio.google.com](https://aistudio.google.com) and sign in with your Google account.
2. Click **Get API key → Create API key**. If it asks for a Google Cloud project, let it create one.
3. Copy the key (it starts with `AIza`) into your notepad.

**Free or paid?**

- **Free tier:** the bot works. Google Search lookups (hours, prices, booking rules, sale timing) may be limited or unavailable on the free tier, depending on Google's current terms. When search isn't available, the bot automatically answers without it, so the details are less precise. Google may also use free-tier data to improve its products.
- **Paid tier (recommended):** click **Set up billing** next to your key in AI Studio and add a payment method. You pay per use; check Google's current Gemini API pricing. A household's volume is usually small, but **set a budget alert** in Google Cloud Billing so there are no surprises.

You can start free and upgrade later.

## Step 5: Create the Google Sheet

1. Signed in to the Google account that should own the bot, go to [sheets.new](https://sheets.new). Name the sheet, e.g. `Our Planner`.
2. **File → Settings → Time zone:** pick your time zone and save.

Share the sheet with your household (**Share** button) so everyone can see and edit the ideas.

## Step 6 (optional): Google ratings and websites

The **Places API** gives the bot each place's Google rating, official website, exact address and Google Maps page. Without it, everything else still works, the **Google Rating** column stays blank, and websites come from the AI's search.

1. Go to [console.cloud.google.com](https://console.cloud.google.com). At the top left, pick the project your Gemini key belongs to. If you don't see it, open the project picker's **All** tab. AI Studio's projects are often named like "Default Gemini Project". You can also copy the project ID from AI Studio's **API keys** page.
2. The project needs **billing turned on** (it already is if you chose Gemini's paid tier).
3. **APIs & Services → Library**, search for **Places API (New)**, and click **Enable**.
4. **APIs & Services → Credentials → Create credentials → API key.** Under **API restrictions**, choose **Restrict key** and tick only **Places API (New)**. Leave **Application restrictions** set to **None** (Apps Script runs on Google's servers, so the other options would block your own bot). Save.
5. Copy the key into your notepad.

A household's volume should fit within Google's free monthly allowance, but set a budget alert under **Billing → Budgets & alerts** anyway.

## Step 7: Add the code

1. In your Sheet: **Extensions → Apps Script**. Give the project a name.
2. Click the gear (**Project Settings**) and set **Time zone** to your time zone.
3. Back in the editor, open `Code.gs`, delete what's there, and paste in [`apps-script/Code.gs`](apps-script/Code.gs).
4. Click **+ → Script** and name it `Config` (it becomes `Config.gs`). Paste in [`apps-script/Config.example.gs`](apps-script/Config.example.gs) and fill in the settings below.
5. Save (⌘S on Mac, Ctrl+S on Windows).

### Required settings

| Setting | What to put |
|---|---|
| `BOT_TOKEN` | Your bot token from Step 1 |
| `GEMINI_API_KEY` | Your Gemini key from Step 4 |
| `HOME_CITY` | Your city with state or country, e.g. `'Austin, TX'` or `'Lyon, France'`. The tab for things to do in town is named after the city part ("Austin"). Until it's set, that tab is called "Local". |
| `HOME_TIMEZONE` | Your time zone's IANA name, e.g. `'America/New_York'`, `'America/Los_Angeles'`, `'Europe/London'`. [Full list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). |
| `WEBHOOK_SECRET` | Make one up: about 30 letters and numbers. Only letters, numbers, `_` and `-` are allowed. Copy it to your notepad. |
| `ALLOWED_CHAT_IDS` | Leave blank for now (Step 12). |
| `WORKER_URL` | Leave as is for now (Step 11). |

### Optional settings (leave blank to skip)

| Setting | What it turns on |
|---|---|
| `CALENDAR_ID` | The 📅 **Add to calendar** and ⏰ **Plan reminder** buttons. Use a calendar your household shares. Find its ID by running **listCalendars** (Step 8), or in Google Calendar under **Settings → (your calendar) → Integrate calendar → Calendar ID**. Blank = no calendar buttons. |
| `HOME_ADDRESS` | **Commute** times for in-town ideas, from Google Maps (e.g. "🚶 6 min walk" or "🚗 15 min · 🚇 35 min"). Use a street address or nearest intersection. |
| `PLACES_API_KEY` | Google ratings, official websites, exact addresses and Maps links (Step 6). |
| `HOUSEHOLD_NAMES` | Who the bot is helping, e.g. `'Alex and Sam'`, so the AI writes naturally. Blank = "a household". |

## Step 8: Run setup

1. In the function dropdown at the top, choose **setup** and click **Run**.
2. Google asks for permission. Choose your account → **Advanced → Go to (your project) (unsafe)** → **Allow**. "Unsafe" only means Google hasn't reviewed your own script.
3. Check the log at the bottom. It lists each tab and tells you about each optional setting:
   - `Calendar OK: "..."` means the calendar buttons are ready. `Calendar NOT found` means: run **listCalendars**, copy the right ID into `CALENDAR_ID`, save, and run **setup** again.
   - Lines starting with a setting name (e.g. `PLACES_API_KEY is blank`) tell you what's turned off. That's fine if you meant to skip it.
4. Your Sheet now has these tabs: **Restaurants**, your city (e.g. **Austin**), **Trips**, **Life**, **Recipes**, **Shopping**, **Archive** and **Trip List**. You can delete the empty **Sheet1** tab.
5. Setup also schedules the nightly archive (around 3 AM).

Optional: run **testIdea** to see what Gemini writes for a sample idea without using Telegram.

## Step 9: Deploy the web app

1. **Deploy → New deployment** → gear icon → **Web app**.
2. **Execute as:** Me. **Who has access:** **Anyone**. ("Anyone with a Google account" won't work: the relay in the next step can't sign in.)
3. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`). Don't use a Library URL or one ending in `/dev`.

## Step 10: Create the Cloudflare Worker

The Worker receives messages from Telegram, answers right away, and passes them on to Apps Script. Telegram retries messages that don't get a quick answer, so pointing it straight at Apps Script causes duplicates.

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. **Workers & Pages → Create application → Start with Hello World!** (the start-from-scratch option, not a repository or another template). Name it, e.g. `planner-bot`, and click **Deploy**.
3. Click **Edit code**. Select everything (**⌘A** / **Ctrl+A**), delete it, paste in [`worker/worker.js`](worker/worker.js), and click **Deploy**. Make sure none of the sample code is left below yours; two `export default` blocks will break it.
4. Go to the Worker's **Settings → Variables and Secrets** and add:
   - `APPS_SCRIPT_URL`: the `/exec` URL from Step 9
   - `WEBHOOK_SECRET`: exactly the same value as in Config.gs

   Type the names by hand, in capitals with underscores. A typo here makes the Worker silently drop every message. If Cloudflare shows a banner about updating your "Wrangler configuration", ignore it; that's for people deploying from their own computer.
5. Copy the Worker's URL (like `https://planner-bot.your-subdomain.workers.dev`).

## Step 11: Connect Telegram to the Worker

1. In `Config.gs`, set `WORKER_URL` to the Worker URL and save.
2. Run **switchToWorker**. The log should show `"ok":true`.

## Step 12: Allow your chats

The bot answers only the chats you list, so strangers can't use it or spend your Gemini credits.

1. In your Telegram group, send `/id`. The bot replies with the group's ID, a negative number. (It answers `/id` even before you've allowed any chats.)
2. To message the bot one-on-one too, each person sends `/id` to the bot in a private chat.
3. Put the IDs in `ALLOWED_CHAT_IDS`, inside one pair of quotes, separated by commas. Keep the minus sign on the group ID:
   ```javascript
   const ALLOWED_CHAT_IDS = '-1001234567890, 987654321';
   ```
4. Save, then **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same.

## Step 13: Add your trips (optional)

Open the **Trip List** tab and add a row per upcoming trip:

| Trip | Destination | Base | Start | End | Time Zone | Notes |
|---|---|---|---|---|---|---|
| Lisbon | Lisbon, Portugal | Hotel name and street address | 2027-05-10 | 2027-05-17 | Europe/Lisbon | |

- **Base** is where you're staying. The bot uses it for commute times on that trip's ideas.
- **Time Zone** makes calendar events land at the right local time.
- Ideas for that destination are filed under the trip automatically. Ideas for places with no planned trip are filed as *Someday*.
- The bot only uses trips that haven't ended yet. Send `/trips` to see what it knows.

## Step 14: Try it

Send your group a TikTok link or a sentence like "dinner at Joe's Pizza". Within about 20–30 seconds the bot replies with the saved idea and its buttons.

---

## Everyday use

**Send anything:** a link, a screenshot, or a sentence. The bot files it on the right tab.

| Tab | What goes there |
|---|---|
| **Restaurants** | Places to eat and drink near home. New ones start as *Want to Try*; change them to *Go Back* or *Once Was Enough* after you go. |
| **Your city** (e.g. **Austin**) | Things to do in town and day trips. |
| **Trips** | Ideas for a trip in the Trip List, including restaurants there, plus *Someday* ideas. |
| **Life** | Home projects, habits, goals, plans for someone. |
| **Recipes** | A permanent recipe book. Never archived. |
| **Shopping** | Things to buy that aren't groceries: **Household** items and **Gift** ideas. |

**Groceries aren't saved.** The bot replies that it doesn't track them.

**What the bot fills in:**
- The **Title** links to the official website (or the recipe or product page).
- **Where** is the address, and **Map** opens it in Google Maps.
- **Commute** comes from Google Maps with typical traffic, from your `HOME_ADDRESS` for in-town ideas and from the trip's **Base** for trips.
- **Google Rating** (e.g. "4.6 (1,234)") is filled in only when Google's listing clearly matches the place, and only with a Places key.
- **When to Go** includes closed days, **Time Needed** gives activity lengths, and **Tips** covers things like parking, cash only or what to bring.
- **Booking** explains how to book (e.g. "Resy, opens 30 days ahead at 10 AM"), **Book Link** opens the booking page, and **Plan By** is the day to book or start planning.

**Yours to fill in (the bot never overwrites these):** **Priority** (Must / Nice / Maybe), **Our Rating** (1–5), **Our Notes**, and **Last Visited** on Restaurants.

**Recipes:** the bot fills in the method, times, servings and ingredient list. It reads ingredients from the recipe page when there is one. For TikTok or Instagram it uses the caption, and if it can't find the ingredients it asks you to reply with a screenshot. It never makes ingredients up. You set:
- **Seasons:** blank means any time of year; otherwise e.g. "Summer" or "Spring, Summer". For a dropdown, select the column and use **Data → Data validation → Dropdown**, then tick **Allow multiple selections**.
- **Weight:** 1–5, starts at 3. How often a meal planner should pick it (see the README).
- **Last Made**, **Times Made**, and **Status** (*Active*, or *Retired* to keep it without it being picked).

**Shopping:** the Title links to the product page. **Best Time to Buy** says when that product or brand usually has its best prices (e.g. Black Friday, Prime Day, or the brand's own sale). It's based on past years, so treat it as a guide. **Plan By** is the suggested day to buy. Status is To Buy / Bought / Skip.

**Buttons:**
- **🍽 Reserve on …** / **🎟 Book on …** opens the booking page. If the bot can't confirm the page works, you get **🔎 Find where to book** (a Google search) instead. The bot can't make bookings itself; OpenTable, Resy and Tock only allow that for approved partners.
- **📍 Map** opens Google Maps.
- **📅 Add to calendar** (needs `CALENDAR_ID`): added right away if the idea has a date. Otherwise the bot asks when; reply with something like "Sat 7pm" or "May 12 morning".
- **⏰ Plan reminder** (needs `CALENDAR_ID`): adds an all-day "📝 Plan: …" item. When booking ahead matters, the bot suggests a date you can accept with one tap.

**Fix anything:** reply to the bot's saved message, e.g. "this is for our Lisbon trip" or "it's the one downtown". You can reply with a screenshot too. The sheet updates, and if the idea now belongs on another tab, the row moves there with your notes and rating.

**Duplicates:** sending a link that's already saved gets "Already saved" instead of a second row.

**Status and archive:** your city's tab, Trips and Life use Idea / Planned / Done / Skip; adding a calendar event changes Idea to Planned. Every night, finished rows move to the **Archive** tab, with a **From** column saying where they came from:
- **Trips:** every row for a trip whose end date has passed. *Someday* rows once they're Done or Skip.
- **Your city:** Done or Skip, or a dated event whose date has passed.
- **Life:** Done or Skip.
- **Restaurants:** only *Once Was Enough*. *Go Back* stays, since that's your return list.
- **Shopping:** Bought or Skip, so past gifts stay on record.
- **Recipes:** never.

To bring a row back, cut and paste it into its tab. To archive right away, run **archiveOld** in the editor.

**Your own columns and tabs:** the bot finds columns by their header names, so you can reorder columns or add your own. Just don't rename the bot's headers. You can add your own tabs too. Don't rename the bot's tabs, and don't give your own tabs the same names.

---

## Updating to a newer version

1. Paste the new `Code.gs` and save. Compare your `Config.gs` with the new `Config.example.gs` and add any new settings.
2. Run **setup** again. It's safe to rerun: it adds new columns to your existing tabs and leaves your data alone.
3. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.** Saving alone doesn't change the live bot. The same goes for any change to `Config.gs`.

## Settings at the top of Code.gs

You rarely need these, but they're there:

| Setting | Default | What it does |
|---|---|---|
| `GEMINI_MODEL` | a Gemini Flash model | Which Gemini model to use |
| `USE_GOOGLE_SEARCH` | `true` | Look up details with Google Search. Set `false` if your Gemini tier doesn't include search. |
| `DEFAULT_EVENT_MIN` | `120` | Event length when nothing else says how long |
| `WALK_MAX_MIN` | `20` | Commutes this short show as a walk instead of drive + transit |
| `KEEP_IDEAS` | `100` | How many recent ideas keep working buttons and replies (older ones live only in the sheet) |
| `ASK_TTL_DAYS` | `3` | How long an unanswered "when?" question stays open |

## Troubleshooting

Work through these in order.

1. **Run checkWebhook** in Apps Script and read the log:
   - `"url":""`: Telegram isn't pointed at your Worker. Check `WORKER_URL`, then run **switchToWorker**.
   - `last_error_message` mentions **403 Forbidden**: the `WEBHOOK_SECRET` in Cloudflare doesn't exactly match Config.gs. Re-enter it in Cloudflare, then run **switchToWorker**.
   - **switchToWorker** said `"ok":false` about the secret token: it may only contain letters, numbers, `_` and `-`.
2. **Open Executions** in Apps Script (left sidebar, the list icon with a clock), send a message, and refresh:
   - **No `doPost` row:** the Worker isn't reaching Apps Script. Open the Worker's **Logs** (or **Observability**) tab. "APPS_SCRIPT_URL is not set" means the variable's name is off. "Apps Script didn't take the update" with a sign-in page means the deployment's access isn't **Anyone**.
   - **A `doPost` row with an error:** click it to read the error.
   - **A `doPost` row, no error, no reply:** the secret in the *deployed* Config.gs doesn't match. Do **Manage deployments → Edit → New version → Deploy**, then run **switchToWorker**.
3. **Group-specific problems:**
   - **The bot answers in a private chat but not the group:** privacy mode is still on. Redo Step 2, then remove the bot from the group and add it back.
   - **The bot went quiet in a group that used to work:** Telegram sometimes upgrades a group, which gives it a new ID starting with `-100`. Send `/id` again and update `ALLOWED_CHAT_IDS`.
4. **"I couldn't tell what's in that post":** Instagram often hides captions from bots. Reply with a few words and the bot saves it.
5. **A recipe saved without ingredients:** reply to the saved message with "add the ingredients" (the bot re-reads the page) or with a screenshot of the recipe.
6. **If you ever leak your webhook secret** (in a screenshot, say), make a new one and put it in Config.gs and Cloudflare. Deploy a new version, then run **switchToWorker**.
