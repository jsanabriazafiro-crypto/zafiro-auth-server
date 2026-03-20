/**
 * ZAFIRO AUTH + DATA SERVER
 * ─────────────────────────────────────────────────────────────────
 * Deploy en Render como Web Service (Node.js)
 *
 * Variables de entorno en Render (ya las tienes):
 *   BASE_URL           → https://zafiro-auth-server.onrender.com
 *   LS_ACCOUNT_ID      → 192029
 *   LS_CLIENT_ID       → tu client id
 *   LS_CLIENT_SECRET   → tu client secret
 *   LS_REFRESH_TOKEN   → tu refresh token (se actualiza automáticamente)
 *   SHOPIFY_SHOP       → zafiro-clothing.myshopify.com
 *   SHOPIFY_TOKEN      → shpca_...
 *
 * Endpoints:
 *   GET  /                          → página de inicio con botones OAuth
 *   GET  /shopify/start             → inicia OAuth Shopify
 *   GET  /shopify/callback          → callback OAuth Shopify
 *   GET  /lightspeed/start          → inicia OAuth Lightspeed
 *   GET  /lightspeed/callback       → callback OAuth Lightspeed
 *   GET  /api/health                → status del servidor
 *   GET  /api/sync?from=&to=        → datos para ZafiroRCC (tx + lines + inv)
 *   GET  /api/shopify/products/all  → productos Shopify con fotos
 *   GET  /api/shopify/orders        → órdenes Shopify
 *   GET  /api/shopify/disputes      → disputas de pago
 */

const https  = require('https');
const http   = require('http');
const url    = require('url');
const PORT   = process.env.PORT || 3000;

// ── Credenciales (leídas de env vars) ────────────────────────────
const BASE_URL          = process.env.BASE_URL || 'https://zafiro-auth-server.onrender.com';
const LS_ACCOUNT_ID     = process.env.LS_ACCOUNT_ID || '192029';
const LS_CLIENT_ID      = process.env.LS_CLIENT_ID || '';
const LS_CLIENT_SECRET  = process.env.LS_CLIENT_SECRET || '';
let   LS_REFRESH_TOKEN  = process.env.LS_REFRESH_TOKEN || '';
const SHOPIFY_SHOP      = process.env.SHOPIFY_SHOP || 'zafiro-clothing.myshopify.com';
const SHOPIFY_TOKEN     = process.env.SHOPIFY_TOKEN || '';

// Scopes de solo lectura para Lightspeed
const LS_SCOPES = 'employee:register+employee:inventory+employee:reports';

// ── Token cache Lightspeed ────────────────────────────────────────
let lsAccessToken  = process.env.LS_TOKEN || '';
let lsTokenExpiry  = 0;

// ── Helpers HTTP ─────────────────────────────────────────────────
function httpGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method: 'GET', headers };
    https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject).end();
  });
}

function httpPost(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(body);
    const opts = {
      hostname, path, method: 'POST',
      headers: { 'Content-Length': buf.length, ...headers }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Lightspeed: obtener/renovar access token ─────────────────────
async function getLSToken() {
  if (lsAccessToken && Date.now() < lsTokenExpiry - 60000) return lsAccessToken;

  const params = new URLSearchParams({
    client_id:     LS_CLIENT_ID,
    client_secret: LS_CLIENT_SECRET,
    refresh_token: LS_REFRESH_TOKEN,
    grant_type:    'refresh_token'
  });

  const r = await httpPost(
    'cloud.lightspeedapp.com',
'/auth/oauth/access_token',
    params.toString(),
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );

  const json = JSON.parse(r.body);
  if (!json.access_token) throw new Error('LS token refresh failed: ' + r.body);

  lsAccessToken = json.access_token;
  lsTokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
  if (json.refresh_token) LS_REFRESH_TOKEN = json.refresh_token;

  console.log('[LS] Token renovado, expira en', json.expires_in, 's');
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
    const qs = new URLSearchParams({ ...params, limit, offset }).toString();
    const path = `${base}/${endpoint}.json?${qs}`;
    console.log(`[LS] GET ${endpoint} offset=${offset}`);

    const r = await httpGet('api.lightspeedapp.com', path, {
      Authorization: `Bearer ${token}`
    });

    if (r.status === 429) {
      // Rate limited — wait 1 second and retry
      await new Promise(res => setTimeout(res, 1000));
      continue;
    }

    if (r.status !== 200) throw new Error(`LS ${endpoint} HTTP ${r.status}: ${r.body.slice(0, 200)}`);

    const json  = JSON.parse(r.body);
    const count = parseInt(json['@attributes']?.count || 0);
    const items = json[endpoint];

    if (!items) break;
    const arr = Array.isArray(items) ? items : [items];
    all.push(...arr);

    if (all.length >= count || arr.length < limit) break;
    offset += limit;

    // Rate limit: 1 req/sec for Lightspeed
    await new Promise(res => setTimeout(res, 200));
  }

  return all;
}

// ── Shopify: fetch con paginación ─────────────────────────────────
async function shopifyFetch(path, allItems = [], pageInfo = null) {
  const fullPath = pageInfo
    ? `/admin/api/2024-01/${path}?limit=250&page_info=${pageInfo}`
    : `/admin/api/2024-01/${path}?limit=250`;

  const r = await httpGet(SHOPIFY_SHOP, fullPath, {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    'Content-Type': 'application/json'
  });

  if (r.status !== 200) throw new Error(`Shopify ${path} HTTP ${r.status}`);
  const json = JSON.parse(r.body);

  // Get items from response
  const key   = Object.keys(json).find(k => Array.isArray(json[k]));
  const items = key ? json[key] : [];
  allItems.push(...items);

  // Check for next page
  const link = r.headers['link'] || '';
  const next = link.match(/page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  if (next && items.length > 0) {
    return shopifyFetch(path, allItems, next[1]);
  }

  return allItems;
}

// ── Normalizar datos Lightspeed → formato CSV del RCC ────────────

// Store name mapping: Lightspeed shop name → display name usado en RCC
const SHOP_MAP = {
  'Zafiro Mall Of San Juan':    'Zafiro Mall Of San Juan',
  'Zafiro Plaza Las Américas':  'Zafiro Plaza Las Américas',
  'Zafiro Plaza Del Caribe':    'Zafiro Plaza Del Caribe',
  'Zafiro Plaza Del Sol':       'Zafiro Plaza Del Sol',
  'Zafiro Viejo San Juan':      'Zafiro Viejo San Juan',
  'Zafiro Storage':             'Zafiro Storage',
  'Zafiro Sample Sale':         'Zafiro Sample Sale',
};

function normalizeSales(sales) {
  return sales.map(s => {
    const shopName = s.Shop?.name || s.shopName || '';
    const empName  = [s.Employee?.firstName, s.Employee?.lastName].filter(Boolean).join(' ');
    const total    = parseFloat(s.calcTotal || s.total || 0);

    return {
      ID:        String(s.saleID || s.id || ''),
      Completed: s.completed === 'true' || s.completed === true ? 'Yes' : 'No',
      Cancelled: s.voided    === 'true' || s.voided    === true ? 'Yes' : 'No',
      Voided:    s.voided    === 'true' || s.voided    === true ? 'Yes' : 'No',
      Total:     `$${total.toFixed(2)}`,
      Date:      (s.timeStamp || s.createTime || '').slice(0, 16).replace('T', ' '),
      Register:  s.Register?.name || '',
      Shop:      SHOP_MAP[shopName] || shopName,
      Employee:  empName,
      Customer:  s.Customer?.firstName
                   ? `${s.Customer.firstName} ${s.Customer.lastName || ''}`.trim()
                   : '',
      Source:    'API',
    };
  });
}

function normalizeLines(lines) {
  return lines.map(l => {
    const desc  = (l.Item?.description || l.description || '').trim();
    const qty   = parseFloat(l.unitQuantity || l.qty || 0);
    const price = parseFloat(l.unitPrice    || 0);
    const sub   = parseFloat(l.calcSubtotal || l.subtotal || qty * price || 0);
    const tax   = l.taxClassID ? '11.50%' : '0%';

    return {
      ID:          String(l.saleID     || l.sale_id  || ''),
      Date:        (l.timeStamp || l.createTime || '').slice(0, 10),
      Description: desc ? ` (${desc})` : '',   // RCC strips parens
      Qty:         String(qty),
      Retail:      `$${price.toFixed(2)}`,
      Subtotal:    `$${sub.toFixed(2)}`,
      Discount:    `$${parseFloat(l.calcDiscount || 0).toFixed(2)}`,
      Tax:         tax,
      Total:       `$${(sub * (tax !== '0%' ? 1.115 : 1)).toFixed(2)}`,
      Customer:    l.Customer?.firstName || '',
      Source:      '',
      'Work Order Internal Note': '',
    };
  });
}

function normalizeInventory(items) {
  // Column names must match INV_COL in RCC exactly (with spaces)
  return items.map(item => {
    const brand = item.Brand?.name      || item.brand || '';
    const cat   = item.Category?.name   || '';
    const sub1  = item.ItemMatrix?.description || item.description || '';

    // Build the row — inventory columns have leading/trailing spaces in RCC
    const row = {
      'System ID':         String(item.itemID || ''),
      'Item':              item.description || '',
      'Brand':             brand,
      'Category':          cat,
      'Subcategory 1':     item.customSku || sub1,
      'Subcategory 2':     '',
      'Price':             `$${parseFloat(item.Prices?.ItemPrice?.amount || 0).toFixed(2)}`,
      ' Zafiro Mall Of San Juan ':      '',
      ' Zafiro Plaza Del Caribe ':      '',
      ' Zafiro Plaza Del Sol ':         '',
      ' Zafiro Plaza Las Américas  ':   '',
      ' Zafiro Sample Sale  ':          '',
      ' Zafiro Storage ':               '',
      ' Zafiro Viejo San Juan ':        '',
    };

    // Fill in quantities per location from ItemShops
    const shops = item.ItemShops?.ItemShop;
    if (shops) {
      const shopArr = Array.isArray(shops) ? shops : [shops];
      shopArr.forEach(is => {
        const name = is.Shop?.name || '';
        const qty  = String(parseInt(is.qoh || 0));
        if (name === 'Zafiro Mall Of San Juan')   row[' Zafiro Mall Of San Juan '] = qty;
        if (name === 'Zafiro Plaza Del Caribe')   row[' Zafiro Plaza Del Caribe '] = qty;
        if (name === 'Zafiro Plaza Del Sol')       row[' Zafiro Plaza Del Sol '] = qty;
        if (name === 'Zafiro Plaza Las Américas')  row[' Zafiro Plaza Las Américas  '] = qty;
        if (name === 'Zafiro Sample Sale')         row[' Zafiro Sample Sale  '] = qty;
        if (name === 'Zafiro Storage')             row[' Zafiro Storage '] = qty;
        if (name === 'Zafiro Viejo San Juan')      row[' Zafiro Viejo San Juan '] = qty;
      });
    }

    return row;
  });
}

// ── Cache simple en memoria ───────────────────────────────────────
const cache = {};
function getCached(key, ttlMs) {
  const hit = cache[key];
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  return null;
}
function setCache(key, data) {
  cache[key] = { ts: Date.now(), data };
}

// ─────────────────────────────────────────────────────────────────
// HTTP SERVER
// ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const html = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  };

  const redirect = (location) => {
    res.writeHead(302, { Location: location });
    res.end();
  };

  try {

    // ── HOME PAGE ─────────────────────────────────────────────────
    if (pathname === '/') {
      return html(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <title>Zafiro Auth Server</title>
  <style>
    body{font-family:'Segoe UI',sans-serif;background:#0d0d1a;color:#F2EDE6;
         display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}
    .box{text-align:center;max-width:480px;}
    h1{font-size:22px;color:#C9A96E;margin-bottom:8px;}
    p{color:#7070A0;font-size:13px;margin-bottom:24px;}
    .btn{display:inline-block;margin:8px;padding:12px 28px;border-radius:10px;
         text-decoration:none;font-weight:600;font-size:14px;cursor:pointer;}
    .ls {background:rgba(201,169,110,0.15);border:1px solid rgba(201,169,110,0.4);color:#C9A96E;}
    .sh {background:rgba(96,165,250,0.12);border:1px solid rgba(96,165,250,0.3);color:#60a5fa;}
    .ok {background:rgba(74,222,128,0.12);border:1px solid rgba(74,222,128,0.3);color:#4ade80;font-size:12px;padding:8px 16px;}
  </style>
</head>
<body>
  <div class="box">
    <h1>🏪 Zafiro Auth Server</h1>
    <p>Servidor de autenticación y datos para Zafiro Retail OS</p>
    <a href="/lightspeed/start" class="btn ls">⚡ Lightspeed</a>
    <a href="/shopify/start"    class="btn sh">🛍 Shopify</a>
    <br/><br/>
    <a href="/api/health"       class="btn ok">✅ Health Check</a>
  </div>
</body>
</html>`);
    }

    // ── HEALTH CHECK ──────────────────────────────────────────────
    if (pathname === '/api/health') {
      const lsOk = !!LS_CLIENT_ID && !!LS_REFRESH_TOKEN;
      const shOk = !!SHOPIFY_TOKEN;
      return json({
        status:      'ok',
        version:     '2.0',
        lightspeed:  lsOk  ? 'configured' : 'missing credentials',
        shopify:     shOk  ? 'configured' : 'missing token',
        account_id:  LS_ACCOUNT_ID,
        server_time: new Date().toISOString(),
      });
    }

    // ────────────────────────────────────────────────────────────
    // LIGHTSPEED OAUTH
    // ────────────────────────────────────────────────────────────

    if (pathname === '/lightspeed/start') {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id:     LS_CLIENT_ID,
        scope:         'employee:register employee:inventory employee:reports',
        state:         'zafiro2026',
      });
      return redirect(`https://cloud.lightspeedapp.com/auth/oauth/authorize?${params}`);
    }

    if (pathname === '/lightspeed/callback') {
      const { code, error } = query;
      if (error || !code) {
        return html(`<h2>Error: ${error || 'No se recibió el código de autorización.'}</h2>`);
      }

      const params = new URLSearchParams({
        client_id:     LS_CLIENT_ID,
        client_secret: LS_CLIENT_SECRET,
        code,
        grant_type:    'authorization_code',
      });

      const r = await httpPost(
        'cloud.lightspeedapp.com',
        '/auth/oauth/token',
        params.toString(),
        { 'Content-Type': 'application/x-www-form-urlencoded' }
      );

      const data = JSON.parse(r.body);
      if (!data.access_token) {
        return html(`<h2>Error obteniendo token</h2><pre>${r.body}</pre>`);
      }

      lsAccessToken = data.access_token;
      lsTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
      if (data.refresh_token) LS_REFRESH_TOKEN = data.refresh_token;

      return html(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/><title>Lightspeed Token</title>
<style>body{font-family:monospace;background:#0d0d1a;color:#F2EDE6;padding:40px;}
.token{background:#1a1a2e;padding:16px;border-radius:8px;word-break:break-all;
       border:1px solid rgba(201,169,110,0.3);color:#C9A96E;margin:8px 0;}
.label{color:#7070A0;font-size:12px;margin-top:16px;}
.copy-btn{background:rgba(201,169,110,0.15);border:1px solid rgba(201,169,110,0.4);
          color:#C9A96E;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;}
</style></head>
<body>
<h2 style="color:#C9A96E;">🎉 ¡Token de Lightspeed obtenido exitosamente!</h2>

<div class="label">Access Token:</div>
<div class="token" id="at">${data.access_token}</div>
<button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('at').textContent)">Copiar</button>

<div class="label">Refresh Token (guárdalo también):</div>
<div class="token" id="rt">${data.refresh_token || '(no incluido)'}</div>
<button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('rt').textContent)">Copiar</button>

<p style="color:#7070A0;margin-top:24px;">
⚠️ Guarda ambos tokens. El Access Token expira en 1 hora — el Refresh Token se usa para renovarlo automáticamente.<br/>
Añade en Render: <code>LS_TOKEN</code> = Access Token &nbsp; <code>LS_REFRESH_TOKEN</code> = Refresh Token
</p>
<a href="/" style="color:#60a5fa;">← Volver al inicio</a>
</body>
</html>`);
    }

    // ────────────────────────────────────────────────────────────
    // SHOPIFY OAUTH
    // ────────────────────────────────────────────────────────────

    if (pathname === '/shopify/start') {
      const SCOPES = [
        'read_products','read_product_listings','read_inventory',
        'read_orders','read_fulfillments','read_assigned_fulfillment_orders',
        'read_customers','read_analytics','read_reports',
        'read_customer_events','read_shopify_payments_disputes',
        'unauthenticated_read_product_tags'
      ].join(',');

      const params = new URLSearchParams({
        client_id:    process.env.SHOPIFY_CLIENT_ID || '',
        scope:        SCOPES,
        redirect_uri: `${BASE_URL}/shopify/callback`,
        state:        'zafiro2026',
      });
      return redirect(`https://${SHOPIFY_SHOP}/admin/oauth/authorize?${params}`);
    }

    if (pathname === '/shopify/callback') {
      const { code, error } = query;
      if (error || !code) {
        return html(`<h2>Error: ${error || 'No se recibió el código.'}</h2>`);
      }

      const body = JSON.stringify({
        client_id:     process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code,
      });

      const r = await httpPost(
        SHOPIFY_SHOP,
        '/admin/oauth/access_token',
        body,
        { 'Content-Type': 'application/json' }
      );

      const data = JSON.parse(r.body);
      if (!data.access_token) {
        return html(`<h2>Error obteniendo token Shopify</h2><pre>${r.body}</pre>`);
      }

      return html(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/><title>Shopify Token</title>
<style>body{font-family:monospace;background:#0d0d1a;color:#F2EDE6;padding:40px;}
.token{background:#1a1a2e;padding:16px;border-radius:8px;word-break:break-all;
       border:1px solid rgba(96,165,250,0.3);color:#60a5fa;margin:8px 0;}
.copy-btn{background:rgba(96,165,250,0.12);border:1px solid rgba(96,165,250,0.3);
          color:#60a5fa;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12px;}
</style></head>
<body>
<h2 style="color:#60a5fa;">🎉 ¡Token de Shopify obtenido!</h2>
<div class="token" id="tok">${data.access_token}</div>
<button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('tok').textContent)">Copiar</button>
<p style="color:#7070A0;margin-top:24px;">Añade en Render: <code>SHOPIFY_TOKEN</code> = este token</p>
<a href="/" style="color:#60a5fa;">← Volver al inicio</a>
</body>
</html>`);
    }

    // ────────────────────────────────────────────────────────────
    // /api/sync — DATOS PARA ZAFIRO RCC
    // ────────────────────────────────────────────────────────────

    if (pathname === '/api/sync') {
      const { from, to } = query;
      if (!from || !to) {
        return json({ ok: false, error: 'Se requieren parámetros from y to (YYYY-MM-DD)' }, 400);
      }

      const cacheKey = `sync_${from}_${to}`;
      const cached   = getCached(cacheKey, 15 * 60 * 1000); // 15 min cache
      if (cached) {
        console.log(`[sync] Cache hit for ${from}→${to}`);
        return json(cached);
      }

      console.log(`[sync] Fetching ${from} → ${to}`);
      const errors = [];

      // ── Transacciones ─────────────────────────────────────────
      let transactions = [];
      try {
        const timeFilter = `>,${from} 00:00:00,<,${to} 23:59:59`;
        const raw = await lsFetchAll('Sale', {
          load_relations: JSON.stringify(['Shop', 'Employee', 'Customer']),
          timeStamp:      timeFilter,
        });
        transactions = normalizeSales(raw);
        console.log(`[sync] Transactions: ${transactions.length}`);
      } catch (e) {
        console.error('[sync] Transactions error:', e.message);
        errors.push({ source: 'transactions', error: e.message });
      }

      // ── Lines ─────────────────────────────────────────────────
      let lines = [];
      try {
        const timeFilter = `>,${from} 00:00:00,<,${to} 23:59:59`;
        const raw = await lsFetchAll('SaleLine', {
          load_relations: JSON.stringify(['Item', 'Customer']),
          timeStamp:      timeFilter,
        });
        lines = normalizeLines(raw);
        console.log(`[sync] Lines: ${lines.length}`);
      } catch (e) {
        console.error('[sync] Lines error:', e.message);
        errors.push({ source: 'lines', error: e.message });
      }

      // ── Inventario ────────────────────────────────────────────
      let inventory = [];
      try {
        const raw = await lsFetchAll('Item', {
          load_relations: JSON.stringify(['Brand', 'Category', 'ItemShops', 'Prices', 'ItemMatrix']),
          archived:       'false',
        });
        inventory = normalizeInventory(raw);
        console.log(`[sync] Inventory: ${inventory.length}`);
      } catch (e) {
        console.error('[sync] Inventory error:', e.message);
        errors.push({ source: 'inventory', error: e.message });
      }

      const result = {
        ok:           true,
        ts:           new Date().toISOString(),
        from,
        to,
        counts: {
          transactions: transactions.length,
          lines:        lines.length,
          inventory:    inventory.length,
        },
        transactions,
        lines,
        inventory,
        errors: errors.length ? errors : undefined,
      };

      if (errors.length === 0) setCache(cacheKey, result);

      return json(result);
    }

    // ────────────────────────────────────────────────────────────
    // /api/shopify/products/all — PRODUCTOS + FOTOS
    // ────────────────────────────────────────────────────────────

    if (pathname === '/api/shopify/products/all') {
      const cached = getCached('shopify_products', 30 * 60 * 1000); // 30 min
      if (cached) return json(cached);

      const products = await shopifyFetch('products.json');

      // Build photoMap: SKU → image URL
      const photoMap = {};
      const items    = [];
      products.forEach(p => {
        const img = p.images?.[0]?.src || '';
        (p.variants || []).forEach(v => {
          if (v.sku) photoMap[v.sku] = img;
          items.push({
            id:       v.id,
            sku:      v.sku,
            title:    `${p.title} - ${v.title}`,
            vendor:   p.vendor,
            type:     p.product_type,
            price:    v.price,
            inventory: v.inventory_quantity,
            image:    img,
          });
        });
      });

      const result = { success: true, count: items.length, total: items.length, photoMap, items };
      setCache('shopify_products', result);
      return json(result);
    }

    // ────────────────────────────────────────────────────────────
    // /api/shopify/orders — ÓRDENES RECIENTES
    // ────────────────────────────────────────────────────────────

    if (pathname === '/api/shopify/orders') {
      const { days = 30 } = query;
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const orders = await shopifyFetch(
        `orders.json?status=any&created_at_min=${since}`
      );
      return json({ success: true, count: orders.length, orders });
    }

    // ────────────────────────────────────────────────────────────
    // /api/shopify/disputes — DISPUTAS DE PAGO
    // ────────────────────────────────────────────────────────────

    if (pathname === '/api/shopify/disputes') {
      const r = await httpGet(SHOPIFY_SHOP,
        '/admin/api/2024-01/shopify_payments/disputes.json',
        { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
      );
      if (r.status !== 200) return json({ success: false, error: r.body }, r.status);
      const data = JSON.parse(r.body);
      return json({ success: true, disputes: data.disputes || [] });
    }

    // 404
    return json({ error: 'Not found', path: pathname }, 404);

  } catch (err) {
    console.error('[server] Error:', err.message);
    return json({ ok: false, error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`🏪 Zafiro Auth Server corriendo en puerto ${PORT}`);
  console.log(`   Lightspeed: ${LS_CLIENT_ID ? '✅ configurado' : '❌ falta LS_CLIENT_ID'}`);
  console.log(`   Shopify:    ${SHOPIFY_TOKEN ? '✅ configurado' : '❌ falta SHOPIFY_TOKEN'}`);
  console.log(`   Account ID: ${LS_ACCOUNT_ID}`);
});
