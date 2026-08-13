import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const AUTH_DIR = path.join(ROOT, 'auth');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const RULES_PATH = path.join(CONFIG_DIR, 'rules.json');
export const RULES_EXAMPLE_PATH = path.join(CONFIG_DIR, 'rules.example.json');

for (const dir of [DATA_DIR, AUTH_DIR, CONFIG_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  panelToken: process.env.PANEL_TOKEN || '',
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  pairingPhone: (process.env.PAIRING_PHONE || '').replace(/[^0-9]/g, ''),
  classifierModel: process.env.CLASSIFIER_MODEL || 'claude-opus-5',
  drafterModel: process.env.DRAFTER_MODEL || 'claude-opus-5',
  debounceMs: num(process.env.DEBOUNCE_SECONDS, 15) * 1000,
  contextMessages: num(process.env.CONTEXT_MESSAGES, 15),
  defaultLanguage: process.env.DEFAULT_LANGUAGE || 'es',
  signature: process.env.SIGNATURE || '',
};

const DEFAULT_RULES = {
  // Contactos SIEMPRE de trabajo: número (con prefijo, sin +) o parte del nombre.
  workContacts: [],
  // Grupos SIEMPRE de trabajo: parte del nombre del grupo o su jid completo.
  workGroups: [],
  // Contactos que se ignoran por completo (nunca se generan borradores).
  ignoreContacts: [],
  // Grupos que se ignoran por completo.
  ignoreGroups: [],
  // Qué hacer con grupos que no están en ninguna lista:
  //   "ignore"   -> no generar borradores (recomendado, menos ruido)
  //   "classify" -> dejar que la IA decida
  groupsDefault: 'ignore',
  // Instrucciones extra para el clasificador, en tus palabras.
  // Ej: "Mi trabajo es la reforma de viviendas; presupuestos y obras son trabajo."
  contextNote: '',
  // Instrucciones de estilo para los borradores.
  toneNote: 'Tono profesional pero cercano, directo, sin florituras. Frases cortas.',
};

/** Lee config/rules.json, creándolo desde los valores por defecto si no existe. */
export function loadRules() {
  if (!fs.existsSync(RULES_PATH)) {
    saveRules(DEFAULT_RULES);
    return { ...DEFAULT_RULES };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    return { ...DEFAULT_RULES, ...parsed };
  } catch {
    return { ...DEFAULT_RULES };
  }
}

export function saveRules(rules) {
  const merged = { ...DEFAULT_RULES, ...rules };
  fs.writeFileSync(RULES_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

export { DEFAULT_RULES };
