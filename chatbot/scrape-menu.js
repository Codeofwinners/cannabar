/**
 * Scrapes purchasable products from the Dutchie menu.
 * Only includes products that display a price (indicates in stock).
 */
import puppeteer from 'puppeteer';
import { writeFileSync } from 'fs';

const SHOP_BASE = 'https://thecannabar.com/shop/';
const OUTPUT = './in-stock-products.json';

const CATEGORIES = [
  'flower', 'pre-rolls', 'vaporizers', 'concentrates',
  'edibles', 'tinctures', 'topicals', 'accessories'
];

async function scrape() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

  const allProducts = new Map();

  for (const cat of CATEGORIES) {
    const url = `${SHOP_BASE}?dtche%5Bcategory%5D=${cat}`;
    console.log(`\n${cat}...`);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(10000); // extra wait for Dutchie iframe

      let dutchie = null;
      // Retry finding frame
      for (let attempt = 0; attempt < 3; attempt++) {
        dutchie = page.frames().find(f => f.url().includes('dutchie.com/embedded-menu'));
        if (dutchie) break;
        await sleep(3000);
      }
      if (!dutchie) { console.log('  No Dutchie frame'); continue; }

      // Scroll to load ALL products
      let prevCount = 0, staleRounds = 0;
      for (let i = 0; i < 200; i++) {
        try { await dutchie.evaluate(() => window.scrollBy(0, 800)); } catch { break; }
        await sleep(300);
        if (i % 15 === 14) {
          const count = await dutchie.evaluate(() =>
            document.querySelectorAll('a[href*="/product/"]').length
          ).catch(() => 0);
          if (count === prevCount && count > 0) { staleRounds++; if (staleRounds >= 2) break; }
          else staleRounds = 0;
          prevCount = count;
        }
      }
      await sleep(2000);

      // Extract products with price validation
      const products = await dutchie.evaluate(() => {
        const items = [];
        document.querySelectorAll('a[href*="/product/"]').forEach(a => {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\/product\/([^/?#]+)/);
          if (!m) return;

          const text = a.textContent || '';
          // Must have a price ($XX.XX) to be purchasable
          if (!text.match(/\$\d+/)) return;

          const slug = m[1];
          const img = a.querySelector('img[alt^="Image of "]');
          const name = img ? img.alt.replace('Image of ', '').replace(' product', '') : '';
          if (name) items.push({ slug, name });
        });
        return items;
      }).catch(() => []);

      for (const { slug, name } of products) {
        if (!allProducts.has(slug)) {
          allProducts.set(slug, { name, category: cat });
        }
      }

      console.log(`  ${products.length} products (total: ${allProducts.size})`);
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }

  await browser.close();

  const inStock = {};
  for (const [slug, { name, category }] of allProducts) {
    inStock[name] = { slug, category, url: `${SHOP_BASE}?dtche%5Bproduct%5D=${slug}` };
  }

  console.log(`\nTotal purchasable products: ${Object.keys(inStock).length}`);
  writeFileSync(OUTPUT, JSON.stringify(inStock, null, 2));
  console.log(`Saved to ${OUTPUT}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
scrape().catch(e => { console.error(e.message); process.exit(1); });
