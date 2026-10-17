// Cloudflare Worker for Shared Planner Bot
//  - POST /  Telegram webhook: replies OK instantly, forwards the update to Apps Script
// Secrets (Worker > Settings > Variables and Secrets), never in this file:
//   APPS_SCRIPT_URL  your Apps Script deployment URL ending in /exec
//   WEBHOOK_SECRET   same value as WEBHOOK_SECRET in Config.gs

export default {
  async fetch(request, env, ctx) {
    // Browser visits / health checks
    if (request.method !== 'POST') return new Response('OK');

    // Only accept requests from Telegram carrying your secret
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    const body = await request.text();

    if (!env.APPS_SCRIPT_URL) {
      console.log('APPS_SCRIPT_URL is not set: check the name under Settings > Variables and Secrets');
      return new Response('OK');
    }

    // Forward to Apps Script in the background...
    ctx.waitUntil(
      fetch(`${env.APPS_SCRIPT_URL}?secret=${encodeURIComponent(env.WEBHOOK_SECRET)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        redirect: 'manual' // Apps Script answers with a 302 after running; no need to follow it
      }).then(res => {
        // A healthy run redirects to script.googleusercontent.com; a sign-in page means access isn't "Anyone"
        const loc = res.headers.get('Location') || '';
        if (res.status >= 400 || /accounts\.google\.com/.test(loc)) {
          console.log(`Apps Script didn't take the update: HTTP ${res.status} ${loc.slice(0, 100)}`);
        }
      }).catch(err => console.log('Forward to Apps Script failed: ' + String(err).split(env.WEBHOOK_SECRET).join('***'))) // never log the secret
    );

    // ...while telling Telegram "delivered" immediately, so it never retries
    return new Response('OK');
  }
};
