import puppeteer from 'puppeteer';
import { writeFileSync } from 'fs';

const DUTCHIE_URL = 'https://dutchie.com/embedded-menu/canna-bar';
const OUTPUT = './product-slugs.json';
const allSlugs = new Map();

async function scrape() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // Capture GraphQL responses
  const client = await page.createCDPSession();
  await client.send('Network.enable');

  client.on('Network.responseReceived', async (event) => {
    try {
      if (!event.response.url.includes('graphql')) return;
      const { body } = await client.send('Network.getResponseBody', { requestId: event.requestId });
      if (!body.includes('slug')) return;
      const json = JSON.parse(body);
      findSlugs(json);
    } catch {}
  });

  const categories = ['flower', 'pre-rolls', 'vaporizers', 'edibles', 'concentrates', 'tinctures', 'topicals', 'accessories'];

  for (const cat of categories) {
    const url = `${DUTCHIE_URL}/categories/${cat}`;
    console.log(`${cat}...`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(4000);
      // Scroll to load more
      for (let i = 0; i < 50; i++) {
        await page.evaluate(() => window.scrollBy(0, 600));
        await sleep(300);
      }
      await sleep(2000);
    } catch (e) {
      console.log(`  skip: ${e.message}`);
    }
    console.log(`  total slugs: ${allSlugs.size}`);
  }

  await browser.close();

  const slugMap = {};
  const skipSet = new Set(['flower','pre-rolls','vaporizers','edibles','concentrates','tinctures','topicals','accessories','gear','rove','grown-rogue','high-grass-farms','merchandise']);
  for (const [slug, name] of allSlugs) {
    if (slug.length > 5 && !skipSet.has(slug)) slugMap[slug] = name;
  }

  console.log(`\nProduct slugs found: ${Object.keys(slugMap).length}`);

  if (Object.keys(slugMap).length > 0) {
    writeFileSync(OUTPUT, JSON.stringify(slugMap, null, 2));
    console.log(`Saved to ${OUTPUT}`);
  } else {
    console.log('GraphQL interception found nothing. Generating from POS API...');
    await genFromPOS();
  }
}

async function genFromPOS() {
  const auth = Buffer.from('5de64a3033324bf5b91e8741ee5bc4c0:').toString('base64');
  const res = await fetch('https://api.pos.dutchie.com/products?isActive=true', {
    headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
  });
  const products = await res.json();
  const map = {};
  for (const p of products) {
    if (!p.isActive || !p.productName) continue;
    map[makeSlug(p.productName)] = p.productName;
  }
  console.log(`Generated ${Object.keys(map).length} slugs`);
  writeFileSync(OUTPUT, JSON.stringify(map, null, 2));
  console.log(`Saved to ${OUTPUT}`);
}

function makeSlug(n) {
  return n.replace(/(?<!\d)\.(\d)/g, '0.$1').toLowerCase()
    .replace(/['''"]/g, '').replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function findSlugs(o) {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { o.forEach(findSlugs); return; }
  if (o.slug && typeof o.slug === 'string') allSlugs.set(o.slug, o.name || '');
  Object.values(o).forEach(v => { if (v && typeof v === 'object') findSlugs(v); });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
scrape().catch(e => { console.error(e.message); process.exit(1); });
