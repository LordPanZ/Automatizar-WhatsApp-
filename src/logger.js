import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino/file',
    options: { destination: 1 },
  },
});

// Baileys es muy hablador; su logger va aparte y en silencio salvo errores.
export const waLogger = pino({ level: process.env.WA_LOG_LEVEL || 'error' });
