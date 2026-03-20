// En tu server.js / index.js principal:
require('./zafiro-sync').mount(app);
```

---

**Paso 2 — Obtener el `LS_REFRESH_TOKEN` (una sola vez)**

Una vez el servidor esté desplegado en Render, visita en tu browser:
```
https://zafiro-auth-server.onrender.com/api/oauth/start
