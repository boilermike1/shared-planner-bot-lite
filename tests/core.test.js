// Core flows: save, duplicate, calendar in the trip's time zone, double tap, reminder, correction that moves tabs,
// unreadable link, chit-chat, archive. Everything here is fictional.
const H = require('./harness.js'); const { api, tg, events, sheets, pages, resp, setGemini, addTrip, send, tap, lastSend, rowOf, setCell, ideaIds, idea, askIds } = H;
const assert = require('assert');
api.setup();
assert.deepEqual(H.order, ['Restaurants', 'Springfield', 'Trips', 'Life', 'Recipes', 'Shopping', 'Archive', 'Trip List']);
assert.deepEqual(H.triggers.map(t => t.getHandlerFunction()), ['archiveOld']);
addTrip('Maui', 'Maui, HI', 'Example Resort, 100 Beach Rd, Lahaina, HI', '2099-03-01', '2099-03-08', 'Pacific/Honolulu');

send('/id'); assert(lastSend().payload.text.includes('-100'));
send('/help'); assert(lastSend().payload.text.includes('Restaurants, Springfield, Trips') && lastSend().payload.text.includes('📅'));
api.processUpdate_({ update_id: 999, message: { message_id: 1, chat: { id: 555 }, text: 'hi', date: 0 } }); // stranger
assert(!tg.some(t => t.payload.chat_id === 555));

pages['https://vm.tiktok.com/ZMabc/'] = () => resp(301, '', { Location: 'https://www.tiktok.com/@islandeats/video/123?_t=8' });
pages['https://www.tiktok.com/oembed?url=' + encodeURIComponent('https://www.tiktok.com/@islandeats/video/123')] = resp(200, { title: 'Best poke on the island', author_name: 'islandeats' });
setGemini([{ category: 'Trip', trip: 'maui', type: 'Food & Drink', title: 'Example Poke Shack', where: 'Lahaina, HI', area: 'West Maui', summary: 'Poke bowls.', duration_minutes: 60, timezone: 'Pacific/Honolulu' }]);
send('https://vm.tiktok.com/ZMabc/ we need this', { auto: true });
const prompt = H.geminiCalls[H.geminiCalls.length - 1].contents[0].parts[0].text;
assert(prompt.startsWith('You help Alex and Sam, who live in Springfield, IL, keep a shared list'));
assert(prompt.includes('"Local": anything else to do in Springfield, IL'));
const id1 = ideaIds()[0], msg1 = idea(id1).msgId;
assert.equal(rowOf('Trips').Trip, 'Maui'); assert.equal(rowOf('Trips').Source, 'https://www.tiktok.com/@islandeats/video/123');

send('https://www.tiktok.com/@islandeats/video/123?lang=en', { auto: true });
assert(lastSend().payload.text.startsWith('👀 Already saved'));

tap('cal:' + id1, msg1);
setGemini([{ date: '2099-03-03', start_time: '11:30', end_time: null }]);
send('Mar 3 11:30am', { reply_to_message: { message_id: askIds()[0].msgId } });
assert.equal(events[0].s, '2099-03-03T21:30:00.000Z'); assert.equal(events[0].e, '2099-03-03T22:30:00.000Z'); // 11:30 HST, 60 min
assert.equal(rowOf('Trips').Status, 'Planned');
tap('cal:' + id1, msg1); assert.equal(events.length, 1);

setGemini([{ category: 'Trip', trip: 'Maui', type: 'Food & Drink', title: 'Example Poke Shack', where: 'Lahaina, HI', summary: 'x', timezone: 'Pacific/Honolulu', plan_by: { date: '2099-02-20', reason: 'check hours' } }]);
send('add a plan-by date', { reply_to_message: { message_id: msg1 } });
tap('rem:' + id1, msg1);
const remAsk = askIds().slice(-1)[0].msgId;
tap('remok:' + id1, remAsk); tap('remok:' + id1, remAsk);
assert.equal(events.length, 2); assert.equal(events[1].t, '📝 Plan: Example Poke Shack');

setCell('Trips', 'Example Poke Shack', 'Our Notes', 'Sam wants this!'); setCell('Trips', 'Example Poke Shack', 'Priority', 'Must');
setGemini([{ category: 'Local', title: 'Springfield Poke Co.', area: 'Downtown', type: 'Food & Drink', summary: 'Poke at home.', timezone: 'America/Chicago' }]);
send('actually there is one in town', { reply_to_message: { message_id: msg1 } });
const moved = rowOf('Springfield');
assert.equal(sheets.Trips.data.filter(Boolean).length, 1); assert.equal(moved['Our Notes'], 'Sam wants this!'); assert.equal(moved.Priority, 'Must');
assert(String(moved.Calendar).includes('HST')); assert.equal(idea(id1).tab, 'Local');
assert(lastSend().payload.text.includes('moved to Springfield'));

setGemini([{ is_idea: true, understood: false }]);
send('https://www.instagram.com/reel/XYZ/?igsh=abc', { auto: true });
assert(lastSend().payload.text.startsWith('🤔'));
const info = askIds().find(a => a.ask.kind === 'info');
setGemini([{ category: 'Local', type: 'Event', title: 'Winter Market', where: 'Town Square, Springfield, IL', summary: 'Holiday market.', timezone: 'America/Chicago', when: { date: '2099-12-04', start_time: '17:00', end_time: '19:00' } }]);
send('the holiday market downtown', { reply_to_message: { message_id: info.msgId } });
const id2 = ideaIds()[1]; tap('cal:' + id2, idea(id2).msgId);
assert.equal(events[2].s, '2099-12-04T23:00:00.000Z'); assert.equal(rowOf('Springfield', 2).Source, 'https://www.instagram.com/reel/XYZ');

const n = tg.filter(t => t.method === 'sendMessage').length;
setGemini([{ is_idea: false }]); send('lol yes');
assert.equal(tg.filter(t => t.method === 'sendMessage').length, n);

addTrip('Old Trip', 'Denver, CO', '', '2000-09-01', '2000-09-05', 'America/Denver');
const T = sheets.Trips, th = T.data[0];
const mk = (title, trip, status) => { const r = new Array(th.length).fill(''); r[th.indexOf('Title')] = title; r[th.indexOf('Trip')] = trip; r[th.indexOf('Status')] = status; T.data.push(r); };
mk('Red Rocks', 'Old Trip', 'Idea'); mk('Sunset cruise', 'Maui', 'Done'); mk('Tower view', 'Someday', 'Skip'); mk('Temple walk', 'Someday', 'Idea');
setCell('Springfield', 'Winter Market', 'Date', '2000-10-01');
api.archiveOld();
assert.deepEqual(sheets.Archive.data.slice(1).filter(Boolean).map(r => r[0]).sort(), ['Red Rocks', 'Tower view', 'Winter Market']);
assert.deepEqual(sheets.Trips.data.slice(1).filter(Boolean).map(r => r[0]), ['Sunset cruise', 'Temple walk']);
assert.deepEqual(H.log.filter(l => /rror/.test(l)), []);
console.log('core: ALL CHECKS PASSED');
