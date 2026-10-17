// Recipes + Shopping tabs, screenshot reply, groceries, archive rules
const H = require('./harness.js'); const { api, sheets, pages, resp, setGemini, geminiCalls, send, lastSend, rowOf, linkOf, setCell, ideaIds, idea } = H;
const assert = require('assert');
api.setup();

pages['https://recipes.example/grilled-chicken'] = resp(200, `<html><head><title>Grilled Chicken</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Recipe"],"name":"Honey Grilled Chicken","recipeIngredient":["2 lb chicken thighs","3 tbsp honey"],"totalTime":"PT1H35M","recipeYield":["4"]}]}</script></head></html>`);
setGemini([{ category: 'Recipe', title: 'Honey Grilled Chicken', cuisine: 'American', main_ingredient: 'Chicken', method: 'Grill', effort: 'Weeknight', total_time: '1 hr 35 min', servings: '4', summary: 'Sticky thighs.', ingredients: ['2 lb chicken thighs', '3 tbsp honey'], tips: ['Marinate 1 hr'] }]);
send('https://recipes.example/grilled-chicken', { auto: true });
const rm = lastSend(); const rr = rowOf('Recipes');
assert.equal(rr.Weight, 3); assert.equal(rr['Times Made'], 0); assert.equal(rr.Status, 'Active'); assert.equal(rr.Seasons, ''); assert.equal(rr.Effort, 'Weeknight');
assert.equal(rr.Ingredients, '2 lb chicken thighs\n3 tbsp honey');
assert.equal(linkOf('Recipes', 'Title'), 'https://recipes.example/grilled-chicken');
assert.deepEqual(rm.payload.reply_markup.inline_keyboard, [[{ text: '📖 Open recipe', url: 'https://recipes.example/grilled-chicken' }]]);

pages['https://www.tiktok.com/oembed?url=' + encodeURIComponent('https://www.tiktok.com/@cook/video/5')] = resp(200, { title: 'Crispy rice salad', author_name: 'cook' });
setGemini([{ category: 'Recipe', title: 'Crispy rice salad', summary: 'Crunchy.', ingredients: [] }]);
send('https://www.tiktok.com/@cook/video/5', { auto: true });
assert(lastSend().payload.text.includes("couldn't find the ingredients"));
const tik = idea(ideaIds().slice(-1)[0]);
setCell('Recipes', 'Crispy rice salad', 'Weight', 5); setCell('Recipes', 'Crispy rice salad', 'Seasons', 'Summer');
setGemini([{ category: 'Recipe', title: 'Crispy rice salad', summary: 'Crunchy.', ingredients: ['2 cups cooked rice', '1 cucumber'] }]);
send('', { photo: [{ file_id: 'a' }, { file_id: 'b' }, { file_id: 'c' }], reply_to_message: { message_id: tik.msgId } });
assert.equal(geminiCalls[geminiCalls.length - 1].contents[0].parts.length, 2);
const r2 = rowOf('Recipes', 2);
assert.equal(r2.Ingredients, '2 cups cooked rice\n1 cucumber'); assert.equal(r2.Weight, 5); assert.equal(r2.Seasons, 'Summer');

pages['https://www.amazon.com/dp/EXAMPLE'] = resp(503, '');
setGemini([{ category: 'Shopping', shop_type: 'Gift', title: 'Example Smart Speaker', for_whom: 'Sam', occasion: 'Birthday', summary: 'Small speaker.', est_cost: '~$50', where_to_buy: 'Amazon, Target', best_time_to_buy: 'Usually cheapest on Prime Day and Black Friday', website: 'https://www.amazon.com/dp/EXAMPLE', plan_by: { date: '2099-07-10', reason: 'Prime Day' } }]);
send('speaker for sam');
const gm = lastSend(); const g = rowOf('Shopping');
assert.equal(g.Type, 'Gift'); assert.equal(g.Status, 'To Buy'); assert.equal(g['Best Time to Buy'], 'Usually cheapest on Prime Day and Black Friday');
assert.equal(linkOf('Shopping', 'Title'), 'https://www.amazon.com/dp/EXAMPLE');
assert(gm.payload.text.includes('⏰ Buy by') && gm.payload.text.includes('🏷 Usually'));
setGemini([{ category: 'Shopping', title: 'New shower curtain', summary: 'Ours is moldy.' }]);
send('need a new shower curtain'); assert.equal(rowOf('Shopping', 2).Type, 'Household');

const sizes = () => JSON.stringify(Object.keys(sheets).map(k => sheets[k].data.length));
const before = sizes();
setGemini([{ category: 'Grocery', title: 'Milk' }]); send('we are out of milk');
assert(lastSend().payload.text.startsWith('🛒')); assert.equal(sizes(), before);

setCell('Shopping', 'Example Smart Speaker', 'Status', 'Bought'); setCell('Recipes', 'Honey Grilled Chicken', 'Status', 'Retired');
api.archiveOld();
assert.equal(sheets.Recipes.data.filter(Boolean).length, 3); assert.equal(sheets.Shopping.data.filter(Boolean).length, 2);
assert.equal(rowOf('Archive').Title, 'Example Smart Speaker'); assert.equal(rowOf('Archive').From, 'Shopping');
assert.deepEqual(H.log.filter(l => /rror/.test(l)), []);
console.log('recipes: ALL CHECKS PASSED');
