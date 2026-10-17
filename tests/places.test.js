// Website-linked title, Map, Commute, Google Rating, booking fallback, links kept when archived
const H = require('./harness.js'); const { api, sheets, pages, resp, setGemini, directions, addTrip, send, lastSend, rowOf, linkOf } = H;
const assert = require('assert');
api.setup();
addTrip('Maui', 'Maui, HI', 'Example Resort, 100 Beach Rd, Lahaina, HI', '2099-03-01', '2099-03-08', 'Pacific/Honolulu');

pages['https://places.googleapis.com/v1/places:searchText'] = opts => {
  const q = JSON.parse(opts.payload).textQuery;
  if (q.startsWith("Joe's Pizza")) return resp(200, { places: [{ displayName: { text: "Joe's Pizza" }, formattedAddress: '200 Oak St, Springfield, IL 62701, USA', websiteUri: 'https://joespizza.example/', googleMapsUri: 'https://maps.google.com/?cid=1', rating: 4.6, userRatingCount: 1234 }] });
  if (q.startsWith('Surf lesson')) return resp(200, { places: [{ displayName: { text: 'Bay Surf School' }, rating: 4.9 }] });
  return resp(200, {});
};
directions['123 Main St, Springfield, IL|200 Oak St, Springfield, IL 62701, USA|walking'] = 6;
pages['https://resy.com/cities/springfield/joes'] = resp(403, '');
setGemini([{ category: 'Restaurant', title: "Joe's Pizza", specific_place: true, where: '200 Oak St, Springfield, IL', area: 'Downtown', summary: 'Thin crust.', tips: ['Cash only'], book_url: 'https://resy.com/cities/springfield/joes', book_platform: 'Resy', cuisine: 'Pizza' }]);
send('joes pizza');
const k = rowOf('Restaurants');
assert(lastSend().payload.text.includes(`<b><a href="https://joespizza.example/">Joe's Pizza</a></b>`));
assert.equal(k['Google Rating'], '4.6 (1,234)'); assert.equal(k.Commute, '🚶 6 min walk'); assert.equal(k['Book Link'], 'Resy');
assert.equal(linkOf('Restaurants', 'Title'), 'https://joespizza.example/'); assert.equal(linkOf('Restaurants', 'Map'), 'https://maps.google.com/?cid=1');
assert.equal(linkOf('Restaurants', 'Book Link'), 'https://resy.com/cities/springfield/joes');

const base = 'Example Resort, 100 Beach Rd, Lahaina, HI|Kaanapali Beach, HI|';
directions[base + 'walking'] = 45; directions[base + 'driving'] = 9; directions[base + 'transit'] = 22;
setGemini([{ category: 'Trip', trip: 'Maui', title: 'Surf lesson', specific_place: true, where: 'Kaanapali Beach, HI', website: 'https://broken.example', summary: 'Lesson.', book_url: 'https://madeup.example/book', timezone: 'Pacific/Honolulu' }]);
send('surf lesson');
const t = rowOf('Trips');
assert.equal(t['Google Rating'], ''); assert.equal(t.Commute, '🚗 9 min · 🚇 22 min'); assert.equal(linkOf('Trips', 'Title'), undefined);
assert.equal(t['Book Link'], 'Search'); assert(linkOf('Trips', 'Book Link').startsWith('https://www.google.com/search?q=Surf%20lesson'));

sheets.Restaurants.data[1][sheets.Restaurants.data[0].indexOf('Status')] = 'Once Was Enough';
api.archiveOld();
assert.equal(linkOf('Archive', 'Title'), 'https://joespizza.example/'); assert.equal(linkOf('Archive', 'Map'), 'https://maps.google.com/?cid=1');

const f = api.namesOverlap_;
assert(!f('Surf lesson', 'Bay Surf School')); assert(f("Joe's", "Joe's Pizza")); assert(f('Café Lumière brunch', 'Café Lumière'));
console.log('places: ALL CHECKS PASSED');
