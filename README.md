<p align="center">
  <img src="assets/logo.png" alt="Planner Bot Lite logo: a smiling robot holding a calendar, with a clock" width="240">
</p>

# Shared Planner Bot (lite)

A Telegram bot for a household's shared plans: trips, things to do in town, restaurants to try, recipes and a shopping list.

Send it a TikTok or Instagram link, any web link, a screenshot, or just a sentence ("try the new taco place downtown"). It works out what the idea is, looks up the practical details with Google Search (address, hours and closed days, prices, how far ahead to book), and files it on the right tab of a Google Sheet. Tap a button to put it on a shared Google Calendar.

## Features

- **Files ideas automatically** into Restaurants, your city's tab (e.g. "Austin"), Trips, Life, Recipes and Shopping. Groceries are politely skipped.
- **Trips:** list upcoming trips (dates, hotel, time zone) and ideas for that destination are filed under the trip. Everything else is "Someday".
- **Practical details:** when to go (including closed days), cost, how to book and when bookings open, a book-by date, and tips.
- **Links that open:** the title links to the official website, plus a booking link ("Reserve on Resy") and a Google Maps link. Links are checked before they're saved.
- **Commute times** from Google Maps, from home or from your hotel on a trip.
- **Google ratings** (optional Places API key), only when Google's listing clearly matches the place.
- **Recipes:** ingredient lists read from recipe pages; a permanent recipe book with Seasons, Weight and Last Made for meal planning.
- **Shopping:** household items and gift ideas, with when that product usually goes on sale.
- **Calendar buttons** (optional): add an event at the right local time (including on trips abroad), or an all-day "Plan:" reminder.
- **Fix by replying:** reply to any saved idea ("it's the one downtown", or a screenshot) and the sheet updates, moving the row to another tab if needed.
- **Nightly archive** moves finished items to an Archive tab.

```
Telegram  →  Cloudflare Worker  →  Google Apps Script  →  Gemini + Google Search
                                          ↓
                         Google Sheet  +  Google Calendar (optional)
```

- [`worker/worker.js`](worker/worker.js): receives Telegram messages, replies instantly, and passes them on.
- [`apps-script/Code.gs`](apps-script/Code.gs): reads links, asks Gemini, writes the Sheet and Calendar.
- [`apps-script/Config.example.gs`](apps-script/Config.example.gs): the settings template.
- [`SETUP.md`](SETUP.md): step-by-step setup, no coding required.
- [`tests/`](tests): runs Code.gs in Node against fake Telegram, Gemini, Sheets and Calendar.

## Get started

Follow the [Setup Guide](SETUP.md). It takes 45–60 minutes. Telegram, Google Sheets and Cloudflare are free; Gemini has a free tier, with a paid tier recommended for Google Search lookups.

## Recipes tab: notes for a meal planner

If you have a meal planner (an AI assistant, a script, or a person) choose meals from the **Recipes** tab, here's how to read it. Read columns by their header names; the order can change.

| Column | Meaning |
|---|---|
| **Status** | *Active* can be picked. *Retired* stays in the book but should never be picked. |
| **Weight** | 1–5, set by the household (new recipes start at 3). Pick in proportion to it: a 5 should come up about five times as often as a 1. |
| **Seasons** | Blank means any time of year; otherwise a comma list such as "Summer" or "Spring, Summer". Out of season, reduce the weight rather than ruling the recipe out. |
| **Last Made** / **Times Made** | Avoid anything made in the last few weeks. |
| **Effort** | *Weeknight* (about 45 minutes or less hands-on) or *Weekend*. |
| **Method**, **Active Time**, **Total Time**, **Servings** | For fitting recipes to busy nights and leftovers. Total Time includes marinating or resting. |
| **Ingredients** | One per line, with amounts, e.g. "2 lb chicken thighs". Names aren't standardized, so match them loosely. |
| **Our Rating**, **Our Notes** | The household's opinion and tweaks. |

## Running the tests

With [Node.js](https://nodejs.org) installed:

```bash
for f in tests/*.test.js; do node "$f"; done
```

Each suite prints `ALL CHECKS PASSED`. No accounts or keys are needed: everything external is faked.

## License

[MIT](LICENSE)
