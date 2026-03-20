/**
 * ZAFIRO AUTH + DATA SERVER v2.2
 * Fixes: cursor pagination, valid Sale relations, correct field mapping
 */
const https = require('https');
const http  = require('http');
const PORT  = process.env.PORT || 3000;

const BASE_URL         = process.env.BASE_URL || 'https://zafiro-auth-server.onrender.com';
const LS_ACCOUNT_ID    = process.env.LS_ACCOUNT_ID || '192029';
const LS_CLIENT_ID     = process.env.LS_CLIENT_ID || '';
const LS_CLIENT_SECRET = process.env.LS_CLIENT_SECRET || '';
let   LS_REFRESH_TOKEN = process.env.LS_REFRESH_TOKEN || '';
const SHOPIFY_SHOP     = process.env.SHOPIFY_SHOP || 'zafiro-clothing.myshopify.com';
const SHOPIFY_TOKEN    = process.env.SHOPIFY_TOKEN || '';

let lsAccessToken = '';
let lsTokenExpiry = 0;

// ── HTTP helpers ──────────────────────────────────────────────────
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
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); }
    );
    req.on('error', reject); req.write(body); req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Lightspeed token ──────────────────────────────────────────────
async function getLSToken() {
  if (lsAccessToken && Date.now() < lsTokenExpiry - 60000) return lsAccessToken;
  console.log('[LS] Renovando token...');
  const params = new URLSearchParams({
    client_id: LS_CLIENT_ID, client_secret: LS_CLIENT_SECRET,
    refresh_token: LS_REFRESH_TOKEN, grant_type: 'refresh_token',
  });
  const r = await httpPost('cloud.lightspeedapp.com', '/auth/oauth/token',
    params.toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
  const j = JSON.parse(r.body);
  if (!j.access_token) throw new Error('Token refresh failed: ' + r.body);
  lsAccessToken = j.access_token;
  lsTokenExpiry = Date.now() + (j.expires_in || 3600) * 1000;
  if (j.refresh_token) LS_REFRESH_TOKEN = j.refresh_token;
  console.log('[LS] Token OK, expira en', j.expires_in, 's');
  return lsAccessToken;
}

// ── Lightspeed fetch con cursor pagination ────────────────────────
// V3 API ya no soporta offset — usa after/next cursor
async function lsFetchAll(endpoint, params = {}, onProgress = null) {
  const token = await getLSToken();
  const base  = `/API/V3/Account/${LS_ACCOUNT_ID}`;
  const all   = [];
  let   afterCursor = null;
  let   pageCount   = 0;

  while (true) {
    const p = { ...params, limit: 100 };
    if (afterCursor) p.after = afterCursor;

    const qs   = new URLSearchParams(p).toString();
    const path = `${base}/${endpoint}.json?${qs}`;
    console.log(`[LS] GET ${endpoint} page=${pageCount + 1}`);

    if (pageCount > 0) await sleep(300);

    const r = await httpGet('api.lightspeedapp.com', path, {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    });

    if (r.status === 429) { console.log('[LS] Rate limited, esperando...'); await sleep(1500); continue; }
    if (r.status !== 200) throw new Error(`LS ${endpoint} HTTP ${r.status}: ${r.body.slice(0, 300)}`);

    const json  = JSON.parse(r.body);
    const attrs = json['@attributes'] || {};
    const raw   = json[endpoint];

    if (!raw) break;
    const arr = Array.isArray(raw) ? raw : [raw];
    all.push(...arr);
    pageCount++;

    const total = parseInt(attrs.count || 0);
    console.log(`[LS] ${endpoint}: ${all.length}/${total || '?'}`);
    if (onProgress) onProgress(all.length, total || 0);

    // Cursor pagination — usar 'after' token si existe
    if (attrs.next) {
      // attrs.next es una URL completa — extraer el cursor 'after'
      try {
        const nextUrl = new URL(attrs.next.startsWith('http') ? attrs.next : 'https://api.lightspeedapp.com' + attrs.next);
        afterCursor = nextUrl.searchParams.get('after');
      } catch(e) {
        afterCursor = null;
      }
    } else {
      afterCursor = null;
    }

    if (!afterCursor || arr.length < 100 || (total && all.length >= total)) break;
  }

  return all;
}

// ── Shopify fetch ─────────────────────────────────────────────────
async function shopifyFetch(path, allItems = [], pageInfo = null) {
  const fullPath = pageInfo
    ? `/admin/api/2024-01/${path}?limit=250&page_info=${pageInfo}`
    : `/admin/api/2024-01/${path}?limit=250`;
  const r = await httpGet(SHOPIFY_SHOP, fullPath, { 'X-Shopify-Access-Token': SHOPIFY_TOKEN });
  if (r.status !== 200) throw new Error(`Shopify HTTP ${r.status}`);
  const json  = JSON.parse(r.body);
  const key   = Object.keys(json).find(k => Array.isArray(json[k]));
  const items = key ? json[key] : [];
  allItems.push(...items);
  const link = r.headers['link'] || '';
  const next = link.match(/page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  if (next && items.length > 0) return shopifyFetch(path, allItems, next[1]);
  return allItems;
}

// ── Normalizers ───────────────────────────────────────────────────
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
  return sales.map(s => {
    // Shop/Register info comes directly on Sale object (not as loaded relation)
    // shopName and registerName are flat fields in the Sale response
    const shopName = s.shopName || s.Shop?.name || '';
    const empName  = s.Employee
      ? `${s.Employee.firstName || ''} ${s.Employee.lastName || ''}`.trim()
      : (s.employeeID ? `Employee#${s.employeeID}` : '');
    return {
      ID:        String(s.saleID || ''),
      Completed: (s.completed === 'true' || s.completed === true) ? 'Yes' : 'No',
      Cancelled: 'No',
      Voided:    (s.voided === 'true' || s.voided === true) ? 'Yes' : 'No',
      Total:     `$${parseFloat(s.calcTotal || 0).toFixed(2)}`,
      Date:      (s.timeStamp || '').slice(0, 16).replace('T', ' '),
      Register:  s.registerName || s.Register?.name || '',
      Shop:      SHOP_MAP[shopName] || shopName,
      Employee:  empName,
      Customer:  s.Customer
        ? `${s.Customer.firstName || ''} ${s.Customer.lastName || ''}`.trim()
        : '',
      Source: 'API',
    };
  });
}

function normalizeLines(lines) {
  return lines.map(l => {
    const qty   = parseFloat(l.unitQuantity || 0);
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
    const row = {
      'System ID':   String(item.itemID || ''),
      'Item':        item.description || '',
      'Brand':       item.Manufacturer?.name || '',
      'Category':    item.Category?.name || '',
      'Subcategory 1': '',
      'Subcategory 2': '',
      'Price':       `$${parseFloat(item.Prices?.ItemPrice?.amount || 0).toFixed(2)}`,
      ' Zafiro Mall Of San Juan ':    '0',
      ' Zafiro Plaza Del Caribe ':    '0',
      ' Zafiro Plaza Del Sol ':       '0',
      ' Zafiro Plaza Las Américas  ': '0',
      ' Zafiro Sample Sale  ':        '0',
      ' Zafiro Storage ':             '0',
      ' Zafiro Viejo San Juan ':      '0',
    };
    const shops = item.ItemShops?.ItemShop;
    if (shops) {
      (Array.isArray(shops) ? shops : [shops]).forEach(is => {
        const n = is.Shop?.name || '';
        const q = String(parseInt(is.qoh || 0));
        if (n === 'Zafiro Mall Of San Juan')   row[' Zafiro Mall Of San Juan ']    = q;
        if (n === 'Zafiro Plaza Del Caribe')   row[' Zafiro Plaza Del Caribe ']    = q;
        if (n === 'Zafiro Plaza Del Sol')       row[' Zafiro Plaza Del Sol ']       = q;
        if (n === 'Zafiro Plaza Las Américas')  row[' Zafiro Plaza Las Américas  '] = q;
        if (n === 'Zafiro Sample Sale')         row[' Zafiro Sample Sale  ']        = q;
        if (n === 'Zafiro Storage')             row[' Zafiro Storage ']             = q;
        if (n === 'Zafiro Viejo San Juan')      row[' Zafiro Viejo San Juan ']      = q;
      });
    }
    return row;
  });
}

// ── Cache ─────────────────────────────────────────────────────────
const cache = {};
const getCached = (k, ttl) => { const h = cache[k]; return h && Date.now()-h.ts < ttl ? h.data : null; };
const setCache  = (k, d)   => { cache[k] = { ts: Date.now(), data: d }; };

// ── Background sync state ─────────────────────────────────────────
const syncState = {
  running: false,
  progress: 0,
  message: '',
  result: null,
  error: null,
  startedAt: null,
  key: null,
};

async function runSyncBackground(from, to) {
  if (syncState.running) return; // already running
  syncState.running  = true;
  syncState.progress = 0;
  syncState.result   = null;
  syncState.error    = null;
  syncState.startedAt = new Date().toISOString();
  syncState.key = `${from}_${to}`;

  try {
    const errors = [];

    // Transacciones
    syncState.message = 'Descargando transacciones...';
    syncState.progress = 10;
    let transactions = [];
    try {
      const raw = await lsFetchAll('Sale', {
        load_relations: JSON.stringify(['Employee', 'Customer']),
        'timeStamp][>=': `${from} 00:00:00`,
        'timeStamp][<=': `${to} 23:59:59`,
        completed: 'true',
      }, (n, total) => {
        syncState.message = `Transacciones: ${n}${total ? '/'+total : ''}...`;
        syncState.progress = Math.min(10 + Math.round(n / (total||65000) * 30), 40);
      });
      transactions = normalizeSales(raw);
      console.log(`[sync] Transactions: ${transactions.length}`);
    } catch(e) {
      console.error('[sync] Transactions error:', e.message);
      errors.push({ source:'transactions', error:e.message });
    }

    // Lines
    syncState.message = 'Descargando líneas de venta...';
    syncState.progress = 45;
    let lines = [];
    try {
      const raw = await lsFetchAll('SaleLine', {
        load_relations: JSON.stringify(['Item']),
        'timeStamp][>=': `${from} 00:00:00`,
        'timeStamp][<=': `${to} 23:59:59`,
      }, (n, total) => {
        syncState.message = `Lines: ${n}${total ? '/'+total : ''}...`;
        syncState.progress = Math.min(45 + Math.round(n / (total||80000) * 20), 65);
      });
      lines = normalizeLines(raw);
      console.log(`[sync] Lines: ${lines.length}`);
    } catch(e) {
      console.error('[sync] Lines error:', e.message);
      errors.push({ source:'lines', error:e.message });
    }

    // Inventario
    syncState.message = 'Descargando inventario...';
    syncState.progress = 70;
    let inventory = [];
    try {
      const raw = await lsFetchAll('Item', {
        load_relations: JSON.stringify(['Category', 'Manufacturer', 'ItemShops']),
        archived: 'false',
      }, (n, total) => {
        syncState.message = `Inventario: ${n}${total ? '/'+total : ''}...`;
        syncState.progress = Math.min(70 + Math.round(n / (total||45000) * 25), 95);
      });
      inventory = normalizeInventory(raw);
      console.log(`[sync] Inventory: ${inventory.length}`);
    } catch(e) {
      console.error('[sync] Inventory error:', e.message);
      errors.push({ source:'inventory', error:e.message });
    }

    const result = { ok:true, ts:new Date().toISOString(), from, to,
      counts:{ transactions:transactions.length, lines:lines.length, inventory:inventory.length },
      transactions, lines, inventory,
      errors: errors.length ? errors : undefined };

    if (!errors.length) setCache(syncState.key, result);
    syncState.result   = result;
    syncState.progress = 100;
    syncState.message  = `✅ Completado — ${transactions.length} tx, ${lines.length} lines, ${inventory.length} items`;

  } catch(e) {
    console.error('[sync] Fatal error:', e.message);
    syncState.error   = e.message;
    syncState.message = '❌ Error: ' + e.message;
  } finally {
    syncState.running = false;
  }
}

// ── Server ────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = u.pathname;
  const query = Object.fromEntries(u.searchParams);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const J = (d, s=200) => { res.writeHead(s, {'Content-Type':'application/json'}); res.end(JSON.stringify(d)); };
  const H = (b, s=200) => { res.writeHead(s, {'Content-Type':'text/html;charset=utf-8'}); res.end(b); };
  const R = l => { res.writeHead(302, {Location:l}); res.end(); };

  try {
    // HOME
    if (pathname === '/') {
      return H(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Zafiro Server</title>
<style>body{font-family:sans-serif;background:#0d0d1a;color:#F2EDE6;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}
.box{text-align:center;}.btn{display:inline-block;margin:8px;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;}
.ls{background:rgba(201,169,110,.15);border:1px solid rgba(201,169,110,.4);color:#C9A96E;}
.ok{background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.3);color:#4ade80;font-size:12px;}</style></head>
<body><div class="box"><h1 style="color:#C9A96E">🏪 Zafiro Auth Server v2.2</h1>
<a href="/lightspeed/start" class="btn ls">⚡ Conectar Lightspeed</a><br/><br/>
<a href="/api/health" class="btn ok">✅ Health Check</a></div></body></html>`);
    }

    // HEALTH
    if (pathname === '/api/health') {
      return J({ status:'ok', version:'2.2',
        lightspeed: LS_CLIENT_ID && LS_REFRESH_TOKEN ? 'configured' : 'missing credentials',
        shopify: SHOPIFY_TOKEN ? 'configured' : 'missing token',
        account_id: LS_ACCOUNT_ID, server_time: new Date().toISOString() });
    }

    // LIGHTSPEED OAUTH
    if (pathname === '/lightspeed/start') {
      const p = new URLSearchParams({ response_type:'code', client_id:LS_CLIENT_ID,
        scope:'employee:register employee:inventory employee:reports', state:'zafiro2026' });
      return R(`https://cloud.lightspeedapp.com/auth/oauth/authorize?${p}`);
    }

    if (pathname === '/lightspeed/callback') {
      const { code, error } = query;
      if (error || !code) return H(`<h2>Error: ${error || 'No code'}</h2>`);
      const p = new URLSearchParams({ client_id:LS_CLIENT_ID, client_secret:LS_CLIENT_SECRET,
        code, grant_type:'authorization_code' });
      const r = await httpPost('cloud.lightspeedapp.com', '/auth/oauth/token',
        p.toString(), { 'Content-Type':'application/x-www-form-urlencoded' });
      const d = JSON.parse(r.body);
      if (!d.access_token) return H(`<h2>Error: ${r.body}</h2>`);
      lsAccessToken = d.access_token;
      lsTokenExpiry = Date.now() + (d.expires_in||3600)*1000;
      if (d.refresh_token) LS_REFRESH_TOKEN = d.refresh_token;
      return H(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>
body{font-family:monospace;background:#0d0d1a;color:#F2EDE6;padding:40px;}
.t{background:#1a1a2e;padding:16px;border-radius:8px;word-break:break-all;border:1px solid rgba(201,169,110,.3);color:#C9A96E;margin:8px 0;}
.b{background:rgba(201,169,110,.15);border:1px solid rgba(201,169,110,.4);color:#C9A96E;padding:6px 14px;border-radius:6px;cursor:pointer;}</style></head>
<body><h2 style="color:#C9A96E">✅ Lightspeed conectado</h2>
<p style="color:#7070A0">Copia y agrega en Render como <strong>LS_REFRESH_TOKEN</strong>:</p>
<div class="t" id="rt">${d.refresh_token||'(no incluido)'}</div>
<button class="b" onclick="navigator.clipboard.writeText(document.getElementById('rt').textContent).then(()=>this.textContent='✅ Copiado')">Copiar</button>
<p style="color:#7070A0;font-size:12px;margin-top:16px;">Expira en ${d.expires_in}s. El Refresh Token no expira si se usa cada 30 días.</p>
<a href="/" style="color:#60a5fa">← Inicio</a></body></html>`);
    }

    // SYNC — inicia en background, responde inmediatamente
    if (pathname === '/api/sync') {
      if (!LS_REFRESH_TOKEN) return J({ ok:false, error:'LS_REFRESH_TOKEN no configurado' }, 503);
      const { from, to } = query;
      if (!from || !to) return J({ ok:false, error:'Faltan from y to' }, 400);

      // Check cache first
      const ck = `${from}_${to}`;
      const cached = getCached(ck, 15*60*1000);
      if (cached) { console.log('[sync] Cache hit'); return J(cached); }

      // If sync already running for same range, return status
      if (syncState.running && syncState.key === ck) {
        return J({ ok:'syncing', progress:syncState.progress, message:syncState.message });
      }

      // Start background sync and return immediately
      console.log(`[sync] Iniciando background sync ${from} → ${to}`);
      runSyncBackground(from, to); // fire and forget
      return J({ ok:'syncing', progress:0, message:'Iniciando sync...' });
    }

    // SYNC STATUS — polling endpoint
    if (pathname === '/api/sync/status') {
      const { from, to } = query;
      const ck = from && to ? `${from}_${to}` : syncState.key;

      // Check cache
      if (ck) {
        const cached = getCached(ck, 15*60*1000);
        if (cached) return J(cached); // done, return full data
      }

      // Return current state
      if (syncState.error) return J({ ok:false, error:syncState.error });
      if (syncState.result) return J(syncState.result); // completed
      return J({ ok:'syncing', progress:syncState.progress, message:syncState.message, running:syncState.running });
    }

    // SHOPIFY PRODUCTS
    if (pathname === '/api/shopify/products/all') {
      const cached = getCached('shopify_products', 30*60*1000);
      if (cached) return J(cached);
      const products = await shopifyFetch('products.json');
      const photoMap = {}, items = [];
      products.forEach(p => {
        const img = p.images?.[0]?.src || '';
        (p.variants||[]).forEach(v => {
          if (v.sku) photoMap[v.sku] = img;
          items.push({ id:v.id, sku:v.sku, title:`${p.title} - ${v.title}`, vendor:p.vendor, price:v.price, image:img });
        });
      });
      const result = { success:true, count:items.length, photoMap, items };
      setCache('shopify_products', result);
      return J(result);
    }

    // SHOPIFY ORDERS
    if (pathname === '/api/shopify/orders') {
      const since = new Date(Date.now()-(parseInt(query.days)||30)*86400000).toISOString();
      const orders = await shopifyFetch(`orders.json?status=any&created_at_min=${since}`);
      return J({ success:true, count:orders.length, orders });
    }

    return J({ error:'Not found', path:pathname }, 404);

  } catch(err) {
    console.error('[server] Error:', err.message);
    return J({ ok:false, error:err.message }, 500);
  }

}).listen(PORT, () => {
  console.log(`🏪 Zafiro Auth Server v2.2 en puerto ${PORT}`);
  console.log(`   LS: ${LS_CLIENT_ID?'✅':'❌'} | Shopify: ${SHOPIFY_TOKEN?'✅':'❌'} | Account: ${LS_ACCOUNT_ID}`);
});
