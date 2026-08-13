import os from 'node:os';
import { config } from './config.js';
import { logger } from './logger.js';
import { createWhatsApp } from './whatsapp.js';
import { createPipeline } from './pipeline.js';
import { createServer } from './server.js';

function localAddresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

async function main() {
  if (!config.anthropicApiKey) {
    logger.error('Falta ANTHROPIC_API_KEY. Copia .env.example a .env y rellénalo.');
    process.exit(1);
  }
  if (!config.panelToken || config.panelToken.startsWith('cambia-esto')) {
    logger.error('Falta un PANEL_TOKEN propio en el .env. Sin él, cualquiera en tu red podría enviar mensajes.');
    process.exit(1);
  }

  const pipeline = createPipeline();
  const whatsapp = await createWhatsApp({ onMessage: pipeline.handleMessage });
  const app = createServer({ whatsapp });

  const server = app.listen(config.port, config.host, () => {
    logger.info(`Panel escuchando en http://localhost:${config.port}`);
    for (const address of localAddresses()) {
      logger.info(`Desde el móvil (misma WiFi): http://${address}:${config.port}`);
    }
  });

  const shutdown = () => {
    logger.info('Cerrando...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error({ err: error }, 'Error fatal al arrancar');
  process.exit(1);
});
