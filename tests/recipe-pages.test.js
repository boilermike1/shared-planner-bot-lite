// Reading recipes from different kinds of pages (made-up fixtures in each format)
const H = require('./harness.js'); const { api, pages, resp, setGemini, geminiCalls, send } = H;
const assert = require('assert');
const parse = api.recipeFromHtml_;

// 1. JSON-LD with lowercase "recipe" and no ingredients + ingredients tagged on the page (some custom recipe sites do this)
const tagged = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"recipe","name":"Test Soup","aggregateRating":{"ratingValue":"5"}}</script>
<h2 itemprop="name">Test Soup</h2><span itemprop="recipeYield" class="p-yield">4-6</span><span itemprop="totalTime">30 minutes</span>
<h4>Ingredients</h4><ul>
 <li itemprop="recipeIngredient ingredients" class="p-ingredient">2 tablespoons olive oil</li>
 <li itemprop="recipeIngredient ingredients" class="p-ingredient">1 lb sausage, <a href="/x">casing</a> removed</li>
 <li itemprop="recipeIngredient ingredients" class="p-ingredient">1/2 cup orzo &amp; more</li></ul>`;
let r = parse(tagged);
assert.equal(r.name, 'Test Soup'); assert.deepEqual(r.ingredients, ['2 tablespoons olive oil', '1 lb sausage, casing removed', '1/2 cup orzo & more']);
assert.equal(r.servings, '4-6'); assert.equal(r.totalTime, '30 minutes'); assert(!r.pageText);

// 2. Tagged page with <meta itemprop content="PT..."> times and no JSON-LD at all
r = parse(`<meta itemprop="totalTime" content="PT1H10M"><li itemprop="recipeIngredient">3 eggs</li><li itemprop="recipeIngredient">1 cup flour</li>`);
assert.deepEqual(r.ingredients, ['3 eggs', '1 cup flour']); assert.equal(r.totalTime, '1 hr 10 min');

// 3. Full JSON-LD still wins
r = parse(`<script type="application/ld+json">[{"@type":"Recipe","name":"Cake","recipeIngredient":["2 cups sugar"],"totalTime":"PT45M","recipeYield":"8"}]</script>`);
assert.deepEqual(r.ingredients, ['2 cups sugar']); assert.equal(r.totalTime, '45 min'); assert.equal(r.servings, '8');

// 4. No recipe data at all: the text under the Ingredients heading goes to Gemini
const plain = `<html><body><script>var x=1;</script><h1>Grandma's chili</h1><p>Story about chili...</p>
<h3><strong>Ingredients</strong></h3><ul><li>2 lb ground beef</li><li>1 can kidney beans</li></ul><h3>Steps</h3><p>Brown the beef.</p></body></html>`;
r = parse(plain);
assert.deepEqual(r.ingredients, []); assert(r.pageText.startsWith('Ingredients\n2 lb ground beef\n1 can kidney beans'), r.pageText);
assert(!r.pageText.includes('var x'));
pages['https://example.com/chili'] = resp(200, plain);
setGemini([{ category: 'Recipe', title: "Grandma's chili", summary: 'Chili.', ingredients: ['2 lb ground beef', '1 can kidney beans'] }]);
send('https://example.com/chili', { auto: true });
const prompt = geminiCalls[geminiCalls.length - 1].contents[0].parts[0].text;
assert(prompt.includes('recipe text from the page, starting at its Ingredients heading') && prompt.includes('2 lb ground beef'));
assert(!prompt.includes('structured recipe on the page'));

// 5. Nothing recipe-like
assert.equal(parse('<html><h1>About us</h1><p>Hello</p></html>'), null);
console.log('recipe-pages: ALL CHECKS PASSED');

// 6. Replying to a saved recipe re-reads its page
{
  const H2 = H; const before = H2.geminiCalls.length;
  const id = H2.ideaIds().slice(-1)[0];
  setGemini([{ category: 'Recipe', title: "Grandma's chili", summary: 'Chili.', ingredients: ['2 lb ground beef', '1 can kidney beans'] }]);
  send('add the ingredients', { reply_to_message: { message_id: H2.idea(id).msgId } });
  const p2 = H2.geminiCalls[H2.geminiCalls.length - 1].contents[0].parts[0].text;
  assert(H2.geminiCalls.length === before + 1 && p2.includes('Recipe text on https://example.com/chili') && p2.includes('1 can kidney beans'));
  console.log('recipe-pages (reply re-read): ALL CHECKS PASSED');
}
