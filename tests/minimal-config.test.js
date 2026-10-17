// First install with only the required settings: no calendar, no home address, no Places key, no names
process.env.MINIMAL_CONFIG = '1';
const H = require('./harness.js'); const { api, setGemini, send, lastSend, rowOf, geminiCalls } = H;
const assert = require('assert');
api.setup();
['CALENDAR_ID is blank', 'HOME_ADDRESS is blank', 'PLACES_API_KEY is blank'].forEach(t => assert(H.log.some(l => l.includes(t)), t));
send('/help'); assert(!lastSend().payload.text.includes('📅'));
setGemini([{ category: 'Restaurant', title: "Joe's Pizza", specific_place: true, where: '200 Oak St, Springfield, IL', summary: 'Pizza.' }]);
send('joes pizza');
const m = lastSend();
assert.deepEqual(m.payload.reply_markup.inline_keyboard.flat().filter(b => b.callback_data), []); // no calendar buttons
assert.equal(rowOf('Restaurants').Commute, ''); assert.equal(rowOf('Restaurants')['Google Rating'], '');
assert(geminiCalls[0].contents[0].parts[0].text.startsWith('You help a household in Springfield, IL keep a shared list'));
assert.deepEqual(H.log.filter(l => /rror/.test(l)), []);
console.log('minimal-config: ALL CHECKS PASSED');
