import 'dotenv/config';
import { tenants } from './tenants.js';
import { startServer } from './server.js';

async function main() {
  await tenants.bootstrap();
  console.log('[boot] tenants cargados:', tenants.list().map((t) => t.tenantId).join(', '));
  startServer(Number(process.env.PORT) || 3000);
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
