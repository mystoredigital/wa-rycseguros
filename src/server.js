import express from 'express';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import path from 'node:path';
import { tenants } from './tenants.js';
import { buildAuthorizeUrl, exchangeCode } from './ghl/oauth.js';

function basicAuth(req, res, next) {
  // No autenticar rutas públicas necesarias para el flujo GHL
  if (req.path.startsWith('/oauth/') || req.path.startsWith('/webhooks/')) return next();
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;
  if (!user || !pass) return next();
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
    if (u === user && p === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="MyStore Agent"');
  res.status(401).send('Auth required');
}

function getTenant(req) {
  const id = req.query.tenant || req.body?.tenant || '_local';
  const t = tenants.get(id);
  if (!t) throw Object.assign(new Error(`Tenant ${id} no existe`), { status: 404 });
  return t;
}

const GHL_SCOPES = [
  'conversations.readonly',
  'conversations.write',
  'conversations/message.readonly',
  'conversations/message.write',
  'contacts.readonly',
  'contacts.write',
  'locations.readonly',
];

export function startServer(port = 3000) {
  const app = express();
  app.use(basicAuth);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.resolve('./public')));

  app.get('/api/health', (_req, res) => res.json({ ok: true, tenants: tenants.list().length }));

  app.get('/api/tenants', (_req, res) => res.json({ tenants: tenants.list() }));

  app.get('/api/state', (req, res) => {
    try { res.json(getTenant(req).snapshot()); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/config', (req, res) => {
    try {
      const t = getTenant(req);
      const { systemPrompt } = req.body || {};
      if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) return res.status(400).json({ error: 'systemPrompt requerido' });
      t.setPrompt(systemPrompt);
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/mode', (req, res) => {
    try {
      const t = getTenant(req);
      const { jid, mode } = req.body || {};
      if (!jid || !['ai', 'human'].includes(mode)) return res.status(400).json({ error: 'jid y mode requeridos' });
      res.json({ ok: true, conversation: t.setMode(jid, mode) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/send', async (req, res) => {
    try {
      const t = getTenant(req);
      const { jid, text } = req.body || {};
      if (!jid || !text) return res.status(400).json({ error: 'jid y text requeridos' });
      const session = tenants.session(t.tenantId);
      await session.send(jid, text);
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // --- GHL OAuth ---
  app.get('/oauth/install', (_req, res) => {
    const clientId = process.env.GHL_CLIENT_ID;
    const redirectUri = process.env.GHL_REDIRECT_URI || `${process.env.OPENROUTER_SITE_URL || ''}/oauth/callback`;
    if (!clientId) return res.status(500).send('GHL_CLIENT_ID no configurado');
    res.redirect(buildAuthorizeUrl({ clientId, redirectUri, scopes: GHL_SCOPES }));
  });

  app.get('/oauth/callback', async (req, res) => {
    try {
      const { code, error, error_description } = req.query;
      if (error) return res.status(400).send(`GHL OAuth error: ${error} ${error_description || ''}`);
      if (!code) return res.status(400).send('Falta code en callback');

      const tokens = await exchangeCode({
        code: String(code),
        clientId: process.env.GHL_CLIENT_ID,
        clientSecret: process.env.GHL_CLIENT_SECRET,
        redirectUri: process.env.GHL_REDIRECT_URI || `${process.env.OPENROUTER_SITE_URL || ''}/oauth/callback`,
        userType: 'Location',
      });

      if (!tokens.locationId) {
        return res.status(500).send(`Tokens recibidos pero sin locationId. userType=${tokens.userType}`);
      }

      const tenantId = tokens.locationId;
      let tenant = tenants.get(tenantId);
      if (!tenant) tenant = await tenants.create(tenantId, { kind: 'ghl', companyId: tokens.companyId });
      tenant.setGhlTokens(tokens);
      console.log(`[oauth] tenant ${tenantId} instalado (company=${tokens.companyId})`);

      res.send(`
<!doctype html><html><head><title>Instalación exitosa</title>
<style>body{font-family:system-ui;background:#0f1419;color:#e7e9ea;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
.box{background:#16202a;padding:32px;border-radius:12px;max-width:420px}
.ok{color:#4caf50;font-size:48px}</style></head>
<body><div class="box">
<div class="ok">✓</div>
<h2>Conectado a GHL</h2>
<p>Location ID: <code>${tenantId}</code></p>
<p>Ya puedes cerrar esta ventana y abrir el dashboard para escanear el QR de WhatsApp.</p>
<p><a href="/?tenant=${encodeURIComponent(tenantId)}" style="color:#1d9bf0">Abrir dashboard →</a></p>
</div></body></html>`);
    } catch (e) {
      console.error('[oauth callback]', e);
      res.status(500).send(`Error: ${e.message}`);
    }
  });

  // --- GHL webhooks (stubs por ahora) ---
  app.post('/webhooks/ghl/outbound', (req, res) => {
    console.log('[webhook ghl outbound] payload:', JSON.stringify(req.body).slice(0, 500));
    // Phase 3: enrutar a Baileys del tenant correcto
    res.json({ ok: true, received: true, note: 'Phase 3 — not yet routed to WhatsApp' });
  });

  app.post('/webhooks/ghl', (req, res) => {
    console.log('[webhook ghl] type:', req.body?.type, 'location:', req.body?.locationId);
    res.json({ ok: true });
  });

  // --- Socket.io ---
  const httpServer = http.createServer(app);
  const io = new IOServer(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    socket.on('subscribe', (tenantId) => {
      socket.join(`tenant:${tenantId}`);
      const t = tenants.get(tenantId);
      if (t) socket.emit('state', t.snapshot());
    });
  });

  for (const ev of ['message', 'mode', 'config', 'connection']) {
    tenants.on(ev, (payload) => {
      io.to(`tenant:${payload.tenantId}`).emit(ev, payload);
    });
  }
  tenants.on('tenant:added', ({ tenantId }) => io.emit('tenant:added', { tenantId }));

  httpServer.listen(port, () => {
    console.log(`[server] http://localhost:${port}`);
  });
  return httpServer;
}
