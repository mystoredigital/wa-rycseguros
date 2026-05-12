import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_ROOT, TenantStore, migrateLegacyIfNeeded } from './state.js';
import { WhatsAppSession } from './whatsapp.js';

class TenantRegistry extends EventEmitter {
  constructor() {
    super();
    this.tenants = new Map();
    this.sessions = new Map();
  }

  async bootstrap() {
    await fs.mkdir(DATA_ROOT, { recursive: true });
    await migrateLegacyIfNeeded();

    // Asegurar tenant _local siempre
    if (!fsSync.existsSync(path.join(DATA_ROOT, '_local'))) {
      await fs.mkdir(path.join(DATA_ROOT, '_local'), { recursive: true });
    }

    const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      await this.load(e.name);
    }
  }

  async load(tenantId) {
    if (this.tenants.has(tenantId)) return this.tenants.get(tenantId);
    const store = new TenantStore(tenantId);
    await store.load();
    this.tenants.set(tenantId, store);
    this._wireEvents(store);

    const session = new WhatsAppSession(store);
    this.sessions.set(tenantId, session);
    session.start().catch((e) => console.error(`[tenant ${tenantId}] start fallo:`, e.message));

    this.emit('tenant:added', { tenantId, tenant: store });
    return store;
  }

  async create(tenantId, meta = {}) {
    if (this.tenants.has(tenantId)) return this.tenants.get(tenantId);
    const store = new TenantStore(tenantId, meta);
    await store.load();
    await store.persistMeta();
    this.tenants.set(tenantId, store);
    this._wireEvents(store);

    const session = new WhatsAppSession(store);
    this.sessions.set(tenantId, session);
    session.start().catch((e) => console.error(`[tenant ${tenantId}] start fallo:`, e.message));

    this.emit('tenant:added', { tenantId, tenant: store });
    return store;
  }

  get(tenantId) {
    return this.tenants.get(tenantId);
  }

  session(tenantId) {
    return this.sessions.get(tenantId);
  }

  list() {
    return Array.from(this.tenants.values()).map((t) => t.snapshot());
  }

  _wireEvents(store) {
    for (const ev of ['message', 'mode', 'config', 'connection']) {
      store.on(ev, (payload) => this.emit(ev, payload));
    }
  }
}

export const tenants = new TenantRegistry();
