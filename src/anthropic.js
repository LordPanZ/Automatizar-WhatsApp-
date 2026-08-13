import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

let client;

export function getClient() {
  if (!client) {
    if (!config.anthropicApiKey) {
      throw new Error('Falta ANTHROPIC_API_KEY en el .env');
    }
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

/** Devuelve el texto concatenado de los bloques de texto de una respuesta. */
export function textOf(response) {
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Comprueba si la respuesta fue rechazada por los clasificadores de seguridad.
 * En ese caso `content` puede venir vacío y leer content[0] reventaría.
 */
export function isRefusal(response) {
  return response.stop_reason === 'refusal';
}
