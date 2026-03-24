import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SHOP = 'https://thecannabar.com/shop/';

// ─── Load brand slugs (scraped from Dutchie) ───────────────
const brands = {};
try {
  const data = JSON.parse(readFileSync(join(__dirname, 'brands.json'), 'utf8'));
  for (const [name, slug] of Object.entries(data)) {
    brands[name.toLowerCase()] = { name, slug, url: `${SHOP}?dtche%5Bpath%5D=brands%2F${slug}` };
  }
  console.log(`${Object.keys(brands).length} brands loaded`);
} catch {}

// ─── Load deals (static fallback) ──────────────────────────
let deals = [];
try { deals = JSON.parse(readFileSync(join(__dirname, 'deals.json'), 'utf8')); } catch {}

// ─── Inventory (from verified live URLs + POS data) ─────────
let inventory = [];
try {
  inventory = JSON.parse(readFileSync(join(__dirname, 'inventory.json'), 'utf8'));
  console.log(`${inventory.length} verified products loaded`);
} catch {}

async function getInventory() {
  return inventory; // Static verified data — most accurate
}

// ─── Refresh deals from API ─────────────────────────────────
async function refreshDeals() {
  const key = process.env.DUTCHIE_API_KEY;
  if (!key) return;
  try {
    const auth = Buffer.from(`${key}:`).toString('base64');
    const res = await fetch('https://api.pos.dutchie.com/discounts', {
      headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    const live = data.filter(d => d.isActive).map(d => {
      let desc = d.discountName;
      if (d.discountType === 'Percent') desc += ` — ${Math.round(d.discountAmount * 100)}% off`;
      else if (d.discountType === 'Price To Amount') desc += ` — $${d.discountAmount}`;
      else if (d.discountType === 'Flat') desc += ` — $${d.discountAmount}`;
      // Build the actual specials URL using discountId from API
      const url = `${SHOP}?dtche%5Bpath%5D=specials%2Fsale%2F${d.discountId}`;
      return { text: desc, url, id: d.discountId };
    });
    if (live.length) deals = live;
  } catch {}
}

// ─── Get brand link ─────────────────────────────────────────
function brandLink(brandName) {
  // Exact match
  const info = brands[brandName.toLowerCase()];
  if (info) return `[${info.name}](${info.url})`;

  // Fuzzy: check if first word of brand name matches first word of any Dutchie brand
  const firstWord = brandName.toLowerCase().split(/\s+/)[0];
  if (firstWord.length >= 3) {
    for (const [key, val] of Object.entries(brands)) {
      if (key.startsWith(firstWord)) return `[${val.name}](${val.url})`;
    }
  }

  return brandName;
}

// ─── Smart search engine ────────────────────────────────────
const NOISE = new Set('do you have what whats some good best any the a an for me i want looking need like right now got your can get recommend show tell about with that are is of in to and or my really something things products stuff how many much does we carry should try amazing great awesome tasty smooth strong potent popular favorite nice cool cheap affordable expensive premium quality top tier highest lowest give'.split(' '));

const ATTR_FILTERS = {
  'live resin': /live.?resin/i,
  'live rosin': /live.?rosin/i,
  'disposable': /disposable|aio|all.?in.?one/i,
  'cartridge': /\bcart|cartridge|510\b/i,
  'infused': /infused/i,
  'gummies': /gumm|chew/i,
  'chocolate': /chocolate/i,
};

// Mood/vibe words → strain type mapping
const MOOD_TO_STRAIN = {
  indica: /sleep|relax|calm|chill|wind down|evening|night|mellow|couch|lazy|unwind|stress|heavy|body/i,
  sativa: /energy|focus|creative|morning|daytime|wake|uplift|active|alert|social|hike|workout|productivity|motivation/i,
  hybrid: /balanced|mix|both|versatile|anytime|middle/i,
};

// Categories that are actual cannabis (never show accessories as default)
const CANNABIS_CATS = ['Flower', 'Smalls', 'Infused Flower', 'Shake', 'Singles', 'Pre-Roll Packs', 'Infused Pre-Roll Packs', 'Cartridges', 'Disposables', 'Resin', 'Sugar', 'Wax', 'Shatter', 'Badder', 'Rosin', 'Diamonds', 'Sauce', 'Chews', 'Chocolate', 'Baked Goods', 'Beverages', 'Hard Candy', 'Food Enhancers', 'Capsules', 'Tinctures', 'Topicals'].map(c => c.toLowerCase());

function smartSearch(inv, query, intent) {
  const lower = query.toLowerCase();

  // 1. Brand query — match longest brand name first
  const sortedBrands = Object.keys(brands).sort((a, b) => b.length - a.length);
  const brandMatch = sortedBrands.find(b => lower.includes(b));
  if (brandMatch) {
    return inv.filter(p => p.brandName.toLowerCase() === brandMatch).slice(0, 10);
  }

  // 2. Category filter
  let pool = inv;
  if (intent.category && CAT_GROUPS[intent.category]) {
    const cats = CAT_GROUPS[intent.category].map(c => c.toLowerCase());
    const f = inv.filter(p => cats.includes(p.category.toLowerCase()));
    if (f.length > 0) pool = f;
  }

  // 3. Attribute filter (live resin, disposable, gummies, etc.)
  for (const [, regex] of Object.entries(ATTR_FILTERS)) {
    if (regex.test(lower)) {
      const f = pool.filter(p => regex.test(p.productName));
      if (f.length > 0) pool = f;
    }
  }

  // 4. Strain type — explicit (indica/sativa/hybrid) OR mood-based
  let strainDetected = false;
  for (const type of ['indica', 'sativa', 'hybrid']) {
    if (lower.includes(type)) {
      const f = pool.filter(p => (p.strainType || '').toLowerCase().includes(type));
      if (f.length > 0) { pool = f; strainDetected = true; }
    }
  }
  // If no explicit strain, check mood words
  if (!strainDetected) {
    for (const [strain, regex] of Object.entries(MOOD_TO_STRAIN)) {
      if (regex.test(lower)) {
        const f = pool.filter(p => (p.strainType || '').toLowerCase().includes(strain));
        if (f.length > 0) { pool = f; strainDetected = true; break; }
      }
    }
  }

  // 5. Price filter
  const pm = lower.match(/under\s*\$?(\d+)|below\s*\$?(\d+)|less\s*than\s*\$?(\d+)|\$?(\d+)\s*or\s*(?:less|under)/);
  if (pm) {
    const max = parseInt(pm[1]||pm[2]||pm[3]||pm[4]);
    const f = pool.filter(p => p.price > 0 && p.price <= max);
    if (f.length > 0) pool = f;
  }

  // 6. Specific keyword search — only for actual product/strain/brand names
  const DESCRIPTIVE = new Set('chill relax relaxing evening night morning day sleep wake energy calm mellow buzz high low light heavy mild strong smooth harsh taste flavor fruity sweet sour earthy woody citrus berry mint vanilla cream spicy herbal floral pine gas diesel kush strain strains type types effect effects feeling'.split(' '));

  const words = lower.replace(/[?!.,'"]/g, '').split(/\s+/)
    .filter(w => w.length > 2 && !NOISE.has(w) && !DESCRIPTIVE.has(w))
    .filter(w => !/indica|sativa|hybrid|vape|cart|edible|pre.?roll|flower|concentrate|topical|tincture|accessor|live|resin|rosin|disposable|aio|infused|gumm|chocolate|brand|under|below|less|than|bucks|dollars/.test(w));

  if (words.length > 0) {
    const scored = pool.map(p => {
      const hay = (p.productName + ' ' + p.brandName).toLowerCase();
      return { p, score: words.filter(w => hay.includes(w)).length };
    });
    const hits = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 10).map(s => s.p);
    if (hits.length > 0) return hits;
  }

  // 7. Return top CANNABIS products (never accessories as default)
  const cannabisOnly = pool.filter(p => CANNABIS_CATS.includes(p.category.toLowerCase()));
  const finalPool = cannabisOnly.length > 0 ? cannabisOnly : pool;
  return finalPool.sort((a, b) => (b.qty || 0) - (a.qty || 0)).slice(0, 10);
}

// ─── Intent detection ───────────────────────────────────────
function detectIntent(msg) {
  const l = msg.toLowerCase();
  return {
    wantsDeals: /deal|special|promo|discount|sale|offer|coupon/.test(l),
    wantsCount: /how many|count|number of|total/.test(l),
    wantsBrands: /brand|who .* carry|companies/.test(l),
    wantsFeatured: /popular|trending|best sell|top|recommend|suggest|what.s good|whats good|hot|featured|favorite|pick/.test(l),
    category: detectCat(l),
  };
}

function detectCat(l) {
  const map = {
    flower: /\bflower|bud|nug|oz|ounce|eighth|quarter|weed|herb/,
    'pre-rolls': /\bpre.?roll|joint|blunt/,
    vaporizers: /\bvape|cart|cartridge|pod|disposable|aio|510/,
    concentrates: /\bconcentrate|dab|wax|shatter|rosin|resin|badder|sugar|live resin|live rosin/,
    edibles: /\bedible|gumm|chocolate|chew|candy|cookie|brownie|drink|beverage/,
    tinctures: /\btincture|drop|sublingual|oil/,
    topicals: /\btopical|cream|balm|lotion|patch/,
    accessories: /\baccessor|batter|grinder|pipe|paper|wrap|tray|lighter|stash/,
  };
  for (const [cat, re] of Object.entries(map)) { if (re.test(l)) return cat; }
  return null;
}

// Map POS categories to the intent categories for filtering
const CAT_GROUPS = {
  flower: ['Flower', 'Smalls', 'Infused Flower', 'Shake'],
  'pre-rolls': ['Singles', 'Pre-Roll Packs', 'Infused Pre-Roll Packs'],
  vaporizers: ['Cartridges', 'Disposables'],
  concentrates: ['Resin', 'Sugar', 'Wax', 'Shatter', 'Badder', 'Rosin', 'Diamonds', 'Sauce'],
  edibles: ['Chews', 'Chocolate', 'Baked Goods', 'Beverages', 'Hard Candy', 'Food Enhancers', 'Capsules'],
  tinctures: ['Tinctures'],
  topicals: ['Topicals'],
  accessories: ['Devices', 'Accessories', 'Gear'],
};

// ─── Build context ──────────────────────────────────────────
async function buildContext(msg, req) {
  const intent = detectIntent(msg);
  const inv = await getInventory();
  await refreshDeals();

  // Smart search handles everything: brand, category, attributes, price, keywords
  const matched = smartSearch(inv, msg, intent);
  let ctx = '';

  // Deals — each deal links to its actual specials page using discountId from API
  if (intent.wantsDeals) {
    const specialsUrl = `${SHOP}?dtche%5Bpath%5D=specials`;

    ctx += '\nCURRENT DEALS — each is a markdown link. Output EXACTLY as written:\n';
    for (const d of deals) {
      const text = typeof d === 'string' ? d : d.text;
      const url = typeof d === 'string' ? specialsUrl : d.url;
      ctx += `- [${text}](${url})\n`;
    }
    ctx += `\n[View All Specials](${specialsUrl})\n`;
    ctx += `\nDo NOT show any product cards for deals. ONLY the deal links + View All Specials. Nothing else.\n`;
    matched.length = 0;
  }

  // Counts
  if (intent.wantsCount) {
    const countSet = intent.category ? filtered : inv;
    const brandSet = new Set(countSet.map(p => p.brandName).filter(Boolean));
    const label = intent.category || 'total';
    ctx += `\nCOUNT: ${countSet.length} ${label} products in stock from ${brandSet.size} brands.\n`;
  }

  // Brands
  if (intent.wantsBrands) {
    const brandSet = new Set((intent.category ? filtered : inv).map(p => p.brandName).filter(Boolean));
    const list = [...brandSet].sort();
    ctx += `\nBRANDS (${list.length}):\n`;
    for (const b of list) ctx += `- ${brandLink(b)}\n`;
  }

  // Products — build cards in CODE, store on req for appending after AI response
  const productList = matched;
  req._productCards = [];
  req._ctaLinks = [];

  if (productList.length > 0) {
    // Give AI context about what products were found so it can speak intelligently
    const strainTypes = [...new Set(productList.map(p => p.strainType).filter(Boolean))];
    const brandNames = [...new Set(productList.map(p => p.brandName).filter(Boolean))];
    const categories = [...new Set(productList.map(p => p.category).filter(Boolean))];
    const priceRange = productList.filter(p => p.price > 0);
    const minPrice = priceRange.length ? Math.min(...priceRange.map(p => p.price)) : 0;
    const maxPrice = priceRange.length ? Math.max(...priceRange.map(p => p.price)) : 0;

    ctx += `\nMATCHING PRODUCTS CONTEXT (use this to write your insightful response):`;
    ctx += `\n- ${productList.length} products found`;
    if (strainTypes.length) ctx += `\n- Strain types: ${strainTypes.join(', ')}`;
    if (brandNames.length) ctx += `\n- Brands: ${brandNames.join(', ')}`;
    if (categories.length) ctx += `\n- Categories: ${categories.join(', ')}`;
    if (minPrice && maxPrice) ctx += `\n- Price range: $${minPrice} - $${maxPrice}`;
    ctx += `\n- Product cards will appear automatically below your response. Do NOT list product names.\n`;
  }

  for (const p of productList) {
    const brandInfo = brands[p.brandName?.toLowerCase()];
    let brandUrl = '', brandName = p.brandName || '';
    if (brandInfo) { brandUrl = brandInfo.url; brandName = brandInfo.name; }
    else if (p.brandName) {
      const first = p.brandName.toLowerCase().split(/\s+/)[0];
      for (const [k, v] of Object.entries(brands)) {
        if (k.startsWith(first)) { brandUrl = v.url; brandName = v.name; break; }
      }
    }
    const price = p.price ? `$${p.price}` : '';
    const img = p.image || '';
    const strain = p.strainType || '';
    req._productCards.push(`{{PRODUCT|${p.productName}|${price}|${brandName}|${brandUrl}|${img}|${strain}}}`);
  }

  // CTA links — appended by code after AI response (skip if deals already has them)
  if (!intent.wantsDeals) {
    if (intent.category) {
      const lbl = intent.category.charAt(0).toUpperCase() + intent.category.slice(1);
      req._ctaLinks.push(`[Browse ${lbl}](${SHOP}?dtche%5Bcategory%5D=${intent.category})`);
    }
    req._ctaLinks.push(`[View Full Menu](${SHOP})`);
  }

  return ctx;
}

// ─── System prompt ──────────────────────────────────────────
const SYSTEM = `You are an expert AI budtender at The Canna Bar (58 Main St, Matawan NJ). In-store pickup only.

YOUR JOB: Give genuinely helpful, tailored cannabis guidance based on what the customer asks. You know about strains, effects, product types, and brands. Use the product DATA below to give specific, knowledgeable answers.

HOW TO RESPOND:
- Skip the welcome. Jump straight into answering their question with real insight.
- If they ask about a vibe (sleep, energy, chill): explain why the products shown match — mention strain types, what indica/sativa/hybrid generally means for that vibe.
- If they ask about a product type (vapes, edibles, flower): explain the differences, what to expect, why certain brands stand out.
- If they ask about a brand: share what makes that brand known, what types of products they offer.
- If they ask about deals: list each deal exactly as the markdown link provided, nothing more.
- Be conversational and knowledgeable — like a real budtender at the counter who knows their stuff.
- 2-4 sentences of real insight, then product cards appear automatically below.
- Do NOT list product names in your text — the cards handle that.
- Do NOT say "Welcome to The Canna Bar" or any generic greeting.

COMPLIANCE:
- NEVER make medical claims (no "helps with sleep", "treats anxiety"). Instead say things like "Indica strains are known for their relaxing, body-focused effects" or "Many customers reach for sativas when they want an uplifting experience."
- NEVER mention delivery. In-store pickup only.
- Deals: output the markdown links EXACTLY as provided in DATA. Do not rephrase.
- Do NOT output {{PRODUCT|...}} tokens — cards are added by the system.
- ONLY use URLs from DATA.
- Do NOT mention stock quantities.`;

// ─── Sessions & Chat ────────────────────────────────────────
const sessions = new Map();

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'API key missing' });

    const sid = sessionId || crypto.randomUUID();
    if (!sessions.has(sid)) sessions.set(sid, []);
    const history = sessions.get(sid);

    const ctx = await buildContext(message, req);
    history.push({ role: 'user', parts: [{ text: message }] });

    const model = genAI.getGenerativeModel({
      model: 'gemini-3.1-flash-lite-preview',
      systemInstruction: SYSTEM + `\n\n--- DATA ---\n${ctx}\n--- END DATA ---`,
    });

    const chat = model.startChat({
      history: history.slice(-20, -1),
      generationConfig: { maxOutputTokens: 4000, temperature: 0.5, thinkingConfig: { thinkingBudget: 0 } },
    });

    let aiText = (await chat.sendMessage(message)).response.text();

    // Strip any {{PRODUCT|...}} and CTA links the AI might have output
    aiText = aiText.replace(/\{\{PRODUCT\|[^}]*\}\}/g, '');
    aiText = aiText.replace(/\[View Full Menu\]\([^)]*\)/g, '');
    aiText = aiText.replace(/\[View All Specials\]\([^)]*\)/g, '');
    aiText = aiText.replace(/\[Browse \w+\]\([^)]*\)/g, '');
    aiText = aiText.trim();

    // CODE appends product cards — AI never touches them
    let cards = '';
    if (req._productCards && req._productCards.length > 0) {
      cards = '\n' + req._productCards.join('\n');
    }

    // CODE appends CTA links
    let ctaLinks = '';
    if (req._ctaLinks && req._ctaLinks.length > 0) {
      ctaLinks = '\n' + req._ctaLinks.join('\n');
    }

    const reply = aiText + cards + ctaLinks;
    history.push({ role: 'model', parts: [{ text: reply }] });
    res.json({ reply, sessionId: sid });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('/api/health', async (req, res) => {
  const inv = await getInventory();
  res.json({ status: 'ok', products: inv.length, brands: Object.keys(brands).length, deals: deals.length });
});

app.listen(PORT, () => {
  console.log(`\n🌿 The Canna Bar Chatbot — http://localhost:${PORT}`);
  console.log(`   ${Object.keys(brands).length} brands | ${deals.length} deals | Inventory: live from API\n`);
});
