/**
 * ZAFIRO AUTH + DATA SERVER v2.1
 * Deploy en Render como Web Service (Node.js)
 *
 * Variables de entorno en Render:
 *   BASE_URL           → https://zafiro-auth-server.onrender.com
 *   LS_ACCOUNT_ID      → 192029
 *   LS_CLIENT_ID       → tu client id
 *   LS_CLIENT_SECRET   → tu client secret
 *   LS_REFRESH_TOKEN   → tu refresh token
 *   SHOPIFY_SHOP       → zafiro-clothing.myshopify.com
 *   SHOPIFY_TOKEN      → shpca_...
 */

const https = require('https');
const http  = require('http');
const url   = require('url');
const PORT  = process.env.PORT || 3000;

// ── Credenciales ──────────────────────────────────────────────────
const BASE_URL         = process.env.BASE_URL || 'https://zafiro-auth-server.onrender.com';
const LS_ACCOUNT_ID    = process.env.LS_ACCOUNT_ID || '192029';
const LS_CLIENT_ID     = process.env.LS_CLIENT_ID || '';
const LS_CLIENT_SECRET = process.env.LS_CLIENT_SECRET || '';
let   LS_REFRESH_TOKEN = process.env.LS_REFRESH_TOKEN || '';
const SHOPIFY_SHOP     = process.env.SHOPIFY_SHOP || 'zafiro-clothing.myshopify.com';
const SHOPIFY_TOKEN    = process.env.SHOPIFY_TOKEN || '';

// ── Token cache ───────────────────────────────────────────────────
let lsAccessToken = '';
let lsTokenExpiry = 0;

// ── Helpers HTTP ──────────────────────────────────────────────────
function httpGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    https.request({ hostname, path, method: 'GET', headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject).end();
  });
}

function httpPost(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { 'Content-Length': buf.length, ...headers } },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Lightspeed: obtener/renovar access token ──────────────────────
// FIX: endpoint correcto para R-Series es /auth/oauth/access_token
async function getLSToken() {
  if (lsAccessToken && Date.now() < lsTokenExpiry - 60000) return lsAccessToken;

  console.log('[LS] Renovando access token...');
  const params = new URLSearchParams({
    client_id:     LS_CLIENT_ID,
    client_secret: LS_CLIENT_SECRET,
    refresh_token: LS_REFRESH_TOKEN,
    grant_type:    'refresh_token',
  });

  const r = await httpPost(
    'cloud.lightspeedapp.com',
    '/auth/oauth/access_token',          // ← CORRECTO para R-Series
    params.toString(),
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );

  const json = JSON.parse(r.body);
  if (!json.access_token) throw new Error('LS token refresh failed: ' + r.body);

  lsAccessToken = json.access_token;
  lsTokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
  if (json.refresh_token) LS_REFRESH_TOKEN = json.refresh_token;

  console.log('[LS] Token OK, expira en', json.expires_in, 's');
  return lsAccessToken;
}

// ── Lightspeed: fetch paginado ────────────────────────────────────
async function lsFetchAll(endpoint, params = {}) {
  const token  = await getLSToken();
  const base   = `/API/V3/Account/${LS_ACCOUNT_ID}`;
  let   offset = 0;
  const limit  = 100;
  const all    = [];

  while (true) {
    const qs   = new URLSearchParams({ ...params, limit, offset }).toString();
    const path = `${base}/${endpoint}.json?${qs}`;
    console.log(`[LS] GET ${endpoint} offset=${offset}`);

    const r = await httpGet('api.lightspeedapp.com', path, {
      Authorization: `Bearer ${token}`,
    });

    if (r.status === 429) {
      console.log('[LS] Rate limited, esperando 1s...');
      await sleep(1000);
      continue;
    }
    if (r.status !== 200) throw new Error(`LS ${endpoint} HTTP ${r.status}: ${r.body.slice(0, 300)}`);

    const json  = JSON.parse(r.body);
    const count = parseInt(json['@attributes']?.count || 0);
    const raw   = json[endpoint];
    if (!raw) break;

    const arr = Array.isArray(raw) ? raw : [raw];
    all.push(...arr);
    console.log(`[LS] ${endpoint}: ${all.length}/${count}`);

    if (all.length >= count || arr.length < limit) break;
    offset += limit;
    await sleep(300); // rate limit
  }

  return all;
}

// ── Shopify: fetch paginado ───────────────────────────────────────
async function shopifyFetch(path, allItems = [], pageInfo = null) {
  const fullPath = pageInfo
    ? `/admin/api/2024-01/${path}?limit=250&page_info=${pageInfo}`
    : `/admin/api/2024-01/${path}?limit=250`;

  const r = await httpGet(SHOPIFY_SHOP, fullPath, {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
  });

  if (r.status !== 200) throw new Error(`Shopify ${path} HTTP ${r.status}`);
  const json  = JSON.parse(r.body);
  const key   = Object.keys(json).find(k => Array.isArray(json[k]));
  const items = key ? json[key] : [];
  allItems.push(...items);

  const link = r.headers['link'] || '';
  const next = link.match(/page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  if (next && items.length > 0) return shopifyFetch(path, allItems, next[1]);
  return allItems;
}

// ── Normalizar → formato CSV del RCC ─────────────────────────────
const SHOP_MAP = {
  'Zafiro Mall Of San Juan':   'Zafiro Mall Of San Juan',
  'Zafiro Plaza Las Américas': 'Zafiro Plaza Las Américas',
  'Zafiro Plaza Del Caribe':   'Zafiro Plaza Del Caribe',
  'Zafiro Plaza Del Sol':      'Zafiro Plaza Del Sol',
  'Zafiro Viejo San Juan':     'Zafiro Viejo San Juan',
  'Zafiro Storage':            'Zafiro Storage',
  'Zafiro Sample Sale':        'Zafiro Sample Sale',
};

function normalizeSales(sales) {
  return sales.map(s => ({
    ID:        String(s.saleID || ''),
    Completed: (s.completed === 'true' || s.completed === true) ? 'Yes' : 'No',
    Cancelled: 'No',
    Voided:    (s.voided === 'true' || s.voided === true) ? 'Yes' : 'No',
    Total:     `$${parseFloat(s.calcTotal || 0).toFixed(2)}`,
    Date:      (s.timeStamp || '').slice(0, 16).replace('T', ' '),
    Register:  s.Register?.name || '',
    Shop:      SHOP_MAP[s.Shop?.name || ''] || s.Shop?.name || '',
    Employee:  [s.Employee?.firstName, s.Employee?.lastName].filter(Boolean).join(' '),
    Customer:  s.Customer ? `${s.Customer.firstName || ''} ${s.Customer.lastName || ''}`.trim() : '',
    Source:    'API',
  }));
}

function normalizeLines(lines) {
  return lines.map(l => {
    const qty = parseFloat(l.unitQuantity || 0);
    const price = parseFloat(l.unitPrice || 0);
    const sub   = parseFloat(l.calcSubtotal || qty * price || 0);
    return {
      ID:          String(l.saleID || ''),
      Date:        (l.timeStamp || '').slice(0, 10),
      Description: (l.Item?.description || '').trim(),
      Qty:         String(qty),
      Retail:      `$${price.toFixed(2)}`,
      Subtotal:    `$${sub.toFixed(2)}`,
      Discount:    `$${parseFloat(l.calcDiscount || 0).toFixed(2)}`,
      Tax:         l.taxClassID ? '11.50%' : '0%',
      Total:       `$${parseFloat(l.calcTotal || sub).toFixed(2)}`,
      Customer:    '',
      Source:      '',
      'Work Order Internal Note': '',
    };
  });
}

function normalizeInventory(items) {
  return items.map(item => {
    // FIX: R-Series uses 'Manufacturer' not 'Brand', and ItemShops structure
    const brand = item.Manufacturer?.name || '';
    const cat   = item.Category?.name || '';

    const row = {
      'System ID':   String(item.itemID || ''),
      'Item':        item.description || '',
      'Brand':       brand,
      'Category':    cat,
      'Subcategory 1': '',
      'Subcategory 2': '',
      'Price':       `$${parseFloat(item.Prices?.ItemPrice?.amount || 0).toFixed(2)}`,
      ' Zafiro Mall Of San Juan ':     '0',
      ' Zafiro Plaza Del Caribe ':     '0',
      ' Zafiro Plaza Del Sol ':        '0',
      ' Zafiro Plaza Las Américas  ':  '0',
      ' Zafiro Sample Sale  ':         '0',
      ' Zafiro Storage ':              '0',
      ' Zafiro Viejo San Juan ':       '0',
    };

    // ItemShops viene como ItemShop (singular) dentro de ItemShops
    const shops = item.ItemShops?.ItemShop;
    if (shops) {
      const arr = Array.isArray(shops) ? shops : [shops];
      arr.forEach(is => {
        const name = is.Shop?.name || '';
        const qty  = String(parseInt(is.qoh || 0));
        if (name === 'Zafiro Mall Of San Juan')   row[' Zafiro Mall Of San Juan ']    = qty;
        if (name === 'Zafiro Plaza Del Caribe')   row[' Zafiro Plaza Del Caribe ']    = qty;
        if (name === 'Zafiro Plaza Del Sol')       row[' Zafiro Plaza Del Sol ']       = qty;
        if (name === 'Zafiro Plaza Las Américas')  row[' Zafiro Plaza Las Américas  '] = qty;
        if (name === 'Zafiro Sample Sale')         row[' Zafiro Sample Sale  ']        = qty;
        if (name === 'Zafiro Storage')             row[' Zafiro Storage ']             = qty;
        if (name === 'Zafiro Viejo San Juan')      row[' Zafiro Viejo San Juan ']      = qty;
      });
    }
    return row;
  });
}

// ── Cache ─────────────────────────────────────────────────────────
const cache = {};
const getCached = (key, ttl) => { const h = cache[key]; return h && Date.now()-h.ts < ttl ? h.data : null; };
const setCache  = (key, data) => { cache[key] = { ts: Date.now(), data }; };
const sleep     = ms => new Promise(r => setTimeout(r, ms));

// ── HTTP SERVER ───────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const { pathname, query } = (() => { const p = new URL(req.url, 'http://x'); return { pathname: p.pathname, query: Object.fromEntries(p.searchParams) }; })();

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const JSON_OUT = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const HTML_OUT = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); };
  const REDIRECT = loc => { res.writeHead(302, { Location: loc }); res.end(); };

  try {

    // HOME
    if (pathname === '/') {
      return HTML_OUT(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><title>Zafiro Server</title>
<style>body{font-family:'Segoe UI',sans-serif;background:#0d0d1a;color:#F2EDE6;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}
.box{text-align:center;max-width:480px;}h1{color:#C9A96E;}p{color:#7070A0;font-size:13px;}
.btn{display:inline-block;margin:8px;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;}
.ls{background:rgba(201,169,110,0.15);border:1px solid rgba(201,169,110,0.4);color:#C9A96E;}
.ok{background:rgba(74,222,128,0.12);border:1px solid rgba(74,222,128,0.3);color:#4ade80;font-size:12px;padding:8px 16px;}</style></head>
<body><div class="box"><h1>🏪 Zafiro Auth Server</h1><p>Servidor de autenticación y datos para Zafiro Retail OS</p>
<a href="/lightspeed/start" class="btn ls">⚡ Conectar Lightspeed</a><br/><br/>
<a href="/api/health" class="btn ok">✅ Health Check</a></div></body></html>`);
    }

    // HEALTH
    if (pathname === '/api/health') {
      return JSON_OUT({
        status:      'ok',
        version:     '2.1',
        lightspeed:  LS_CLIENT_ID && LS_REFRESH_TOKEN ? 'configured' : 'missing credentials',
        shopify:     SHOPIFY_TOKEN ? 'configured' : 'missing token',
        account_id:  LS_ACCOUNT_ID,
        server_time: new Date().toISOString(),
      });
    }

    // LIGHTSPEED OAUTH START
    if (pathname === '/lightspeed/start') {
      const p = new URLSearchParams({
        response_type: 'code',
        client_id:     LS_CLIENT_ID,
        scope:         'employee:register employee:inventory employee:reports',
        state:         'zafiro2026',
      });
      return REDIRECT(`https://cloud.lightspeedapp.com/auth/oauth/authorize?${p}`);
    }

    // LIGHTSPEED OAUTH CALLBACK
    // FIX: endpoint correcto /auth/oauth/access_token
    if (pathname === '/lightspeed/callback') {
      const { code, error } = query;
      if (error || !code) return HTML_OUT(`<h2>Error: ${error || 'No code'}</h2>`);

      const p = new URLSearchParams({
        client_id:     LS_CLIENT_ID,
        client_secret: LS_CLIENT_SECRET,
        code,
        grant_type:    'authorization_code',
      });

      const r = await httpPost(
        'cloud.lightspeedapp.com',
        '/auth/oauth/access_token',     // ← CORRECTO
        p.toString(),
        { 'Content-Type': 'application/x-www-form-urlencoded' }
      );

      const data = JSON.parse(r.body);
      if (!data.access_token) return HTML_OUT(`<h2>Error: ${r.body}</h2>`);

      lsAccessToken = data.access_token;
      lsTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
      if (data.refresh_token) LS_REFRESH_TOKEN = data.refresh_token;

      return HTML_OUT(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Token OK</title>
<style>body{font-family:monospace;background:#0d0d1a;color:#F2EDE6;padding:40px;}
.token{background:#1a1a2e;padding:16px;border-radius:8px;word-break:break-all;border:1px solid rgba(201,169,110,0.3);color:#C9A96E;margin:8px 0;}
.btn{background:rgba(201,169,110,0.15);border:1px solid rgba(201,169,110,0.4);color:#C9A96E;padding:6px 14px;border-radius:6px;cursor:pointer;}</style></head>
<body>
<h2 style="color:#C9A96E;">✅ Lightspeed conectado</h2>
<p style="color:#7070A0;">Copia el Refresh Token y agrégalo en Render como <strong>LS_REFRESH_TOKEN</strong>:</p>
<div class="token" id="rt">${data.refresh_token || '(no incluido)'}</div>
<button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('rt').textContent).then(()=>this.textContent='✅ Copiado')">Copiar Refresh Token</button>
<p style="color:#7070A0;margin-top:24px;font-size:12px;">El Access Token expira en ${data.expires_in}s. El Refresh Token no expira.</p>
<a href="/" style="color:#60a5fa;">← Inicio</a>
</body></html>`);
    }

    // API SYNC
    if (pathname === '/api/sync') {
      if (!LS_REFRESH_TOKEN) return JSON_OUT({ ok: false, error: 'LS_REFRESH_TOKEN no configurado' }, 503);

      const { from, to } = query;
      if (!from || !to) return JSON_OUT({ ok: false, error: 'Faltan parámetros from y to' }, 400);

      const cacheKey = `sync_${from}_${to}`;
      const cached   = getCached(cacheKey, 15 * 60 * 1000);
      if (cached) { console.log('[sync] Cache hit'); return JSON_OUT(cached); }

      console.log(`[sync] Iniciando ${from} → ${to}`);
      const errors = [];

      // Transacciones
      // FIX: load_relations correctos para R-Series Sale
      let transactions = [];
      try {
        const raw = await lsFetchAll('Sale', {
          load_relations: JSON.stringify(['Shop', 'Employee', 'Customer', 'Register']),
          'timeStamp][>=': `${from} 00:00:00`,
          'timeStamp][<=': `${to} 23:59:59`,
        });
        transactions = normalizeSales(raw);
        console.log(`[sync] Transacciones: ${transactions.length}`);
      } catch (e) {
        console.error('[sync] Transactions error:', e.message);
        errors.push({ source: 'transactions', error: e.message });
      }

      // Lines
      // FIX: solo 'Item' es relación válida en SaleLine (no Customer)
      let lines = [];
      try {
        const raw = await lsFetchAll('SaleLine', {
          load_relations: JSON.stringify(['Item']),
          'timeStamp][>=': `${from} 00:00:00`,
          'timeStamp][<=': `${to} 23:59:59`,
        });
        lines = normalizeLines(raw);
        console.log(`[sync] Lines: ${lines.length}`);
      } catch (e) {
        console.error('[sync] Lines error:', e.message);
        errors.push({ source: 'lines', error: e.message });
      }

      // Inventario
      // FIX: relaciones válidas para Item: Category, Manufacturer, ItemShops (no Brand/Prices/ItemMatrix)
      let inventory = [];
      try {
        const raw = await lsFetchAll('Item', {
          load_relations: JSON.stringify(['Category', 'Manufacturer', 'ItemShops']),
          archived: 'false',
        });
        inventory = normalizeInventory(raw);
        console.log(`[sync] Inventory: ${inventory.length}`);
      } catch (e) {
        console.error('[sync] Inventory error:', e.message);
        errors.push({ source: 'inventory', error: e.message });
      }

      const result = {
        ok: true,
        ts: new Date().toISOString(),
        from, to,
        counts: { transactions: transactions.length, lines: lines.length, inventory: inventory.length },
        transactions, lines, inventory,
        errors: errors.length ? errors : undefined,
      };

      if (!errors.length) setCache(cacheKey, result);
      return JSON_OUT(result);
    }

    // SHOPIFY PRODUCTS
    if (pathname === '/api/shopify/products/all') {
      const cached = getCached('shopify_products', 30 * 60 * 1000);
      if (cached) return JSON_OUT(cached);
      const products = await shopifyFetch('products.json');
      const photoMap = {}, items = [];
      products.forEach(p => {
        const img = p.images?.[0]?.src || '';
        (p.variants || []).forEach(v => {
          if (v.sku) photoMap[v.sku] = img;
          items.push({ id: v.id, sku: v.sku, title: `${p.title} - ${v.title}`, vendor: p.vendor, price: v.price, image: img });
        });
      });
      const result = { success: true, count: items.length, photoMap, items };
      setCache('shopify_products', result);
      return JSON_OUT(result);
    }

    // SHOPIFY ORDERS
    if (pathname === '/api/shopify/orders') {
      const since = new Date(Date.now() - (parseInt(query.days) || 30) * 86400000).toISOString();
      const orders = await shopifyFetch(`orders.json?status=any&created_at_min=${since}`);
      return JSON_OUT({ success: true, count: orders.length, orders });
    }

    // 404
    return JSON_OUT({ error: 'Not found', path: pathname }, 404);

  } catch (err) {
    console.error('[server] Error:', err.message);
    return JSON_OUT({ ok: false, error: err.message }, 500);
  }

}).listen(PORT, () => {
  console.log(`🏪 Zafiro Auth Server v2.1 en puerto ${PORT}`);
  console.log(`   Lightspeed: ${LS_CLIENT_ID ? '✅' : '❌'} | Shopify: ${SHOPIFY_TOKEN ? '✅' : '❌'} | Account: ${LS_ACCOUNT_ID}`);
});
