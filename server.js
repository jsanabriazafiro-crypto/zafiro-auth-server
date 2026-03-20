const https = require('https');
const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 3000;

// ── Credenciales ─────────────────────────────────────────────────────────────
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID     || '';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const SHOPIFY_SHOP          = process.env.SHOPIFY_SHOP          || '';
const SHOPIFY_SCOPES        = 'read_analytics,read_assigned_fulfillment_orders,read_customer_events,read_customers,read_fulfillments,read_inventory,read_orders,read_product_listings,read_products,read_reports,read_shopify_payments_disputes,unauthenticated_read_product_tags';

const QB_CLIENT_ID     = process.env.QB_CLIENT_ID     || '';
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET || '';

const LS_CLIENT_ID     = process.env.LS_CLIENT_ID     || '';
const LS_CLIENT_SECRET = process.env.LS_CLIENT_SECRET || '';
const SHOPIFY_TOKEN    = process.env.SHOPIFY_TOKEN    || '';

// ── Helper: GET from Shopify API ──────────────────────────────────────────────
function shopifyGet(endpoint) {
  return new Promise((resolve, reject) => {
    const token = SHOPIFY_TOKEN;
    const shop  = SHOPIFY_SHOP;
    if (!token || !shop) { reject(new Error('Token o shop no configurado')); return; }
    const req = https.request({
      hostname: shop,
      path: `/admin/api/2026-01${endpoint}`,
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({raw: d}); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Helper: POST request ─────────────────────────────────────────────────────
function postJSON(hostname, path, body, headers={}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({raw: d}); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── HTML helpers ─────────────────────────────────────────────────────────────
const page = (title, body) => `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Zafiro Auth</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#f2ede6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
  .card{background:#fff;border-radius:12px;padding:36px;max-width:560px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  h1{font-family:Georgia,serif;color:#1a1714;margin:0 0 6px;font-size:22px}
  .sub{color:#7a7470;font-size:13px;margin-bottom:24px}
  .token-box{background:#f2ede6;border:1px solid #ddd6cb;border-radius:8px;padding:14px;font-family:monospace;font-size:12px;word-break:break-all;position:relative;margin:16px 0}
  .copy-btn{position:absolute;top:8px;right:8px;font-size:10px;padding:4px 8px;border-radius:4px;border:1px solid #ddd6cb;background:#fff;cursor:pointer}
  .copy-btn:hover{border-color:#b89a5e;color:#b89a5e}
  .btn{display:inline-block;background:#b89a5e;color:#fff;padding:12px 24px;border-radius:7px;text-decoration:none;font-size:13px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;margin-top:8px}
  .btn:hover{background:#9a7f48}
  .btn.outline{background:#fff;color:#4a4540;border:1px solid #ddd6cb}
  .btn.outline:hover{border-color:#b89a5e;color:#b89a5e}
  .success{background:#e8f5e9;border:1px solid #c8e6c9;border-radius:8px;padding:12px 16px;color:#2e7d32;font-size:13px;margin-bottom:16px}
  .error{background:#fce4ec;border:1px solid #f8bbd0;border-radius:8px;padding:12px 16px;color:#c62828;font-size:13px;margin-bottom:16px}
  .info{background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:12px 16px;color:#f57f17;font-size:12px;margin-bottom:16px;line-height:1.5}
  .steps{list-style:none;padding:0;margin:16px 0}
  .steps li{padding:8px 0;border-bottom:1px solid #f2ede6;font-size:13px;color:#4a4540}
  .steps li:last-child{border-bottom:none}
  .steps li span{color:#b89a5e;font-weight:600;margin-right:8px}
  .logo{font-family:Georgia,serif;font-size:14px;letter-spacing:.12em;color:#b89a5e;font-weight:600;margin-bottom:20px}
  .divider{border:none;border-top:1px solid #e8e2d9;margin:20px 0}
  .platform-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:16px}
  .platform-btn{padding:12px;border-radius:8px;border:1.5px solid #ddd6cb;text-align:center;text-decoration:none;color:#4a4540;font-size:12px;font-weight:500;transition:.15s}
  .platform-btn:hover{border-color:#b89a5e;color:#b89a5e}
  .platform-btn.done{border-color:#4caf50;color:#2e7d32;background:#e8f5e9}
</style>
</head>
<body><div class="card">
<div class="logo">ZAFIRO</div>
${body}
</div>
<script>
function copyText(txt){navigator.clipboard.writeText(txt).then(()=>{event.target.textContent='¡Copiado!';setTimeout(()=>event.target.textContent='Copiar',2000)});}
</script>
</body></html>`;

// ── ROUTES ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;
  const query  = parsed.query;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  // ── HOME ──────────────────────────────────────────────────────────────────
  if (path === '/' || path === '') {
    const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
    res.end(page('Inicio', `
      <h1>Zafiro Auth Server</h1>
      <p class="sub">Obtén tus tokens de API para Shopify, QuickBooks y Lightspeed</p>
      <div class="platform-grid">
        <a href="/shopify/start" class="platform-btn">🛍 Shopify</a>
        <a href="/quickbooks/start" class="platform-btn">📊 QuickBooks</a>
        <a href="/lightspeed/start" class="platform-btn">⚡ Lightspeed</a>
      </div>
    `));
    return;
  }

  // ── SHOPIFY START ─────────────────────────────────────────────────────────
  if (path === '/shopify/start') {
    const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
    const authUrl = `https://${SHOPIFY_SHOP}/admin/oauth/authorize`
      + `?client_id=${SHOPIFY_CLIENT_ID}`
      + `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}`
      + `&redirect_uri=${encodeURIComponent(BASE + '/shopify/callback')}`
      + `&state=zafiro2026`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ── SHOPIFY CALLBACK ──────────────────────────────────────────────────────
  if (path === '/shopify/callback') {
    const code = query.code;
    if (!code) {
      res.end(page('Error', `<div class="error">No se recibió el código de autorización.</div><a href="/shopify/start" class="btn">Intentar de nuevo</a>`));
      return;
    }
    try {
      const data = await postJSON(SHOPIFY_SHOP, '/admin/oauth/access_token', {
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code
      });
      if (data.access_token) {
        res.end(page('✅ Shopify Conectado', `
          <div class="success">🎉 ¡Token de Shopify obtenido exitosamente!</div>
          <p style="font-size:13px;color:#4a4540;margin-bottom:8px"><strong>Tu Access Token permanente:</strong></p>
          <div class="token-box">
            <button class="copy-btn" onclick="copyText('${data.access_token}')">Copiar</button>
            ${data.access_token}
          </div>
          <div class="info">⚠️ Guarda este token en un lugar seguro. No expira pero solo se muestra una vez aquí.</div>
          <a href="/" class="btn outline">← Volver al inicio</a>
        `));
      } else {
        res.end(page('Error', `<div class="error">Error: ${JSON.stringify(data)}</div><a href="/shopify/start" class="btn">Intentar de nuevo</a>`));
      }
    } catch(err) {
      res.end(page('Error', `<div class="error">Error: ${err.message}</div>`));
    }
    return;
  }

  // ── QUICKBOOKS START ──────────────────────────────────────────────────────
  if (path === '/quickbooks/start') {
    if (!QB_CLIENT_ID) {
      res.end(page('QuickBooks', `
        <h1>QuickBooks</h1>
        <div class="info">Aún no has configurado las credenciales de QuickBooks.<br>Agrégalas como variables de entorno en Render:<br><strong>QB_CLIENT_ID</strong> y <strong>QB_CLIENT_SECRET</strong></div>
        <a href="/" class="btn outline">← Volver</a>
      `));
      return;
    }
    const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
    const authUrl = `https://appcenter.intuit.com/connect/oauth2`
      + `?client_id=${QB_CLIENT_ID}`
      + `&response_type=code`
      + `&scope=com.intuit.quickbooks.accounting`
      + `&redirect_uri=${encodeURIComponent(BASE + '/quickbooks/callback')}`
      + `&state=zafiro2026`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ── QUICKBOOKS CALLBACK ───────────────────────────────────────────────────
  if (path === '/quickbooks/callback') {
    const code    = query.code;
    const realmId = query.realmId;
    if (!code) {
      res.end(page('Error QB', `<div class="error">No se recibió el código.</div>`));
      return;
    }
    res.end(page('✅ QuickBooks', `
      <div class="success">🎉 Código de QuickBooks recibido</div>
      <p style="font-size:13px;color:#4a4540">Código: <code>${code}</code></p>
      <p style="font-size:13px;color:#4a4540">Realm ID: <code>${realmId}</code></p>
      <div class="info">Guarda estos valores — los necesitas para intercambiar por el Access Token de QuickBooks.</div>
      <a href="/" class="btn outline">← Volver</a>
    `));
    return;
  }

  // ── LIGHTSPEED START ──────────────────────────────────────────────────────
  if (path === '/lightspeed/start') {
    if (!LS_CLIENT_ID) {
      res.end(page('Lightspeed', `
        <h1>Lightspeed</h1>
        <div class="info">Aún no tienes las credenciales de Lightspeed.<br>Cuando Lightspeed te apruebe, agrega:<br><strong>LS_CLIENT_ID</strong> y <strong>LS_CLIENT_SECRET</strong> en Render.</div>
        <a href="/" class="btn outline">← Volver</a>
      `));
      return;
    }
    const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
    const authUrl = `https://cloud.lightspeedapp.com/oauth/authorize.php`
      + `?response_type=code`
      + `&client_id=${LS_CLIENT_ID}`
      + `&scope=employee:inventory_read+employee:sales_read+employee:orders_read`
      + `&redirect_uri=${encodeURIComponent(BASE + '/lightspeed/callback')}`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ── LIGHTSPEED CALLBACK ───────────────────────────────────────────────────
  if (path === '/lightspeed/callback') {
    const code = query.code;
    if (!code) {
      res.end(page('Error LS', `<div class="error">No se recibió el código.</div>`));
      return;
    }
    res.end(page('✅ Lightspeed', `
      <div class="success">🎉 Código de Lightspeed recibido</div>
      <p style="font-size:13px;color:#4a4540">Código: <code>${code}</code></p>
      <div class="info">Guarda este código para intercambiarlo por el Access Token.</div>
      <a href="/" class="btn outline">← Volver</a>
    `));
    return;
  }

  // ── SHOPIFY PROXY ─────────────────────────────────────────────────────────
  // GET /api/shopify/products → jala todos los productos con fotos
  if (path === '/api/shopify/products') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    try {
      let allProducts = [];
      let pageInfo = null;
      let hasMore = true;
      while (hasMore) {
        let endpoint = '/products.json?limit=250&fields=id,title,handle,variants,images,image';
        if (pageInfo) endpoint += `&page_info=${pageInfo}`;
        const data = await shopifyGet(endpoint);
        if (data.products) {
          allProducts = allProducts.concat(data.products);
          // Check for next page via Link header (simplified - get all at once)
          hasMore = false; // Shopify returns max 250, paginate if needed
        } else {
          hasMore = false;
        }
      }
      res.end(JSON.stringify({ success: true, products: allProducts, count: allProducts.length }));
    } catch(err) {
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // GET /api/shopify/products/all → paginated, gets ALL products
  if (path === '/api/shopify/products/all') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    try {
      // First get count
      const countData = await shopifyGet('/products/count.json');
      const total = countData.count || 0;
      let allProducts = [];
      let sinceId = 0;
      while (allProducts.length < total) {
        let endpoint = `/products.json?limit=250&fields=id,title,handle,variants,images,image&since_id=${sinceId}`;
        const data = await shopifyGet(endpoint);
        if (!data.products || data.products.length === 0) break;
        allProducts = allProducts.concat(data.products);
        sinceId = data.products[data.products.length - 1].id;
        if (data.products.length < 250) break;
      }
      // Build photo map: SKU → image URL
      const photoMap = {};
      allProducts.forEach(p => {
        const mainImg = p.image ? p.image.src : (p.images && p.images[0] ? p.images[0].src : null);
        if (p.variants) {
          p.variants.forEach(v => {
            if (v.sku) {
              // Find variant image if exists
              const varImg = v.image_id && p.images
                ? (p.images.find(i => i.id === v.image_id) || {}).src
                : null;
              photoMap[v.sku] = varImg || mainImg;
            }
          });
        }
        // Also index by product ID
        if (mainImg) photoMap[String(p.id)] = mainImg;
      });
      res.end(JSON.stringify({ 
        success: true, 
        count: allProducts.length,
        total,
        photoMap 
      }));
    } catch(err) {
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // GET /api/shopify/orders → recent orders
  if (path === '/api/shopify/orders') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    try {
      const data = await shopifyGet('/orders.json?limit=250&status=any&fields=id,name,created_at,total_price,line_items,financial_status,fulfillment_status');
      res.end(JSON.stringify({ success: true, orders: data.orders || [], count: (data.orders||[]).length }));
    } catch(err) {
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // GET /api/shopify/inventory → inventory levels
  if (path === '/api/shopify/inventory') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    try {
      const data = await shopifyGet('/inventory_levels.json?limit=250');
      res.end(JSON.stringify({ success: true, inventory: data.inventory_levels || [] }));
    } catch(err) {
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204);
    res.end();
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  res.writeHead(404);
  res.end(page('404', `<h1>Página no encontrada</h1><a href="/" class="btn outline">← Inicio</a>`));
});

server.listen(PORT, () => console.log(`✅ Zafiro Auth Server corriendo en puerto ${PORT}`));
