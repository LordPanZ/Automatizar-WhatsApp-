import fs from 'node:fs';
import { AUTH_DIR } from './config.js';

// Borra las credenciales locales para poder vincular otra vez desde cero.
// No cierra la sesión en el teléfono: hazlo también desde
// WhatsApp > Ajustes > Dispositivos vinculados si quieres revocarla allí.
fs.rmSync(AUTH_DIR, { recursive: true, force: true });
fs.mkdirSync(AUTH_DIR, { recursive: true });
console.log('Credenciales borradas. Arranca con "npm start" y vuelve a vincular.');
