import { config, loadRules } from './config.js';
import { getClient, isRefusal, textOf } from './anthropic.js';
import { logger } from './logger.js';

const CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    label: {
      type: 'string',
      enum: ['work', 'personal', 'unclear'],
      description:
        'work = asunto laboral o profesional; personal = vida personal, familia, ocio; unclear = no hay forma razonable de decidirlo.',
    },
    confidence: {
      type: 'number',
      description: 'Confianza de 0 a 1 en la etiqueta elegida.',
    },
    reason: {
      type: 'string',
      description: 'Una frase corta, en español, explicando la decisión.',
    },
    needs_reply: {
      type: 'boolean',
      description:
        'true si el último mensaje espera una respuesta del usuario. false si es un "ok", "gracias", un aviso o algo que no requiere contestación.',
    },
  },
  required: ['label', 'confidence', 'reason', 'needs_reply'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `Eres un clasificador de mensajes de WhatsApp. Tu única tarea es decidir si la conversación trata un asunto de TRABAJO o de VIDA PERSONAL, y si el último mensaje espera respuesta.

Criterios:
- "work": clientes, proveedores, compañeros, jefes, presupuestos, facturas, plazos, reuniones, entregas, incidencias del trabajo, candidaturas, temas administrativos profesionales.
- "personal": familia, amigos, pareja, quedadas, ocio, deporte, salud, compras personales, cadenas y bromas.
- "unclear": mensajes ambiguos, saludos sueltos sin contexto, o cuando un contacto mezcla ambos mundos y no puedes decidir con lo que hay.

Reglas importantes:
- Ante la duda, responde "unclear". Es mucho peor marcar como trabajo algo personal que lo contrario.
- Un contacto puede ser un compañero de trabajo y estar hablando de cerveza: eso es "personal".
- Juzga por el CONTENIDO de los últimos mensajes, no solo por quién escribe.
- Devuelve únicamente el JSON pedido.`;

/**
 * Comprueba si un texto coincide con alguna entrada de una lista de reglas.
 * Compara contra el jid, el número y el nombre, sin distinguir mayúsculas.
 */
function matchesList(list, { jid, name }) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const number = (jid || '').split('@')[0];
  const haystack = [jid || '', number, name || ''].map((s) => s.toLowerCase());
  return list.some((raw) => {
    const needle = String(raw || '').trim().toLowerCase();
    if (!needle) return false;
    return haystack.some((h) => h.includes(needle));
  });
}

/**
 * Decide qué hacer con un chat aplicando primero las reglas fijas.
 * Devuelve { decided, label, source, reason } — si decided es false hay que preguntar a la IA.
 */
export function applyRules({ jid, name, isGroup, categoryOverride }) {
  const rules = loadRules();

  if (categoryOverride === 'work') {
    return { decided: true, label: 'work', source: 'override', reason: 'Marcado como trabajo desde el panel.' };
  }
  if (categoryOverride === 'personal') {
    return { decided: true, label: 'personal', source: 'override', reason: 'Marcado como personal desde el panel.' };
  }

  const ignoreList = isGroup ? rules.ignoreGroups : rules.ignoreContacts;
  if (matchesList(ignoreList, { jid, name })) {
    return { decided: true, label: 'ignored', source: 'rules', reason: 'En la lista de ignorados.' };
  }

  const workList = isGroup ? rules.workGroups : rules.workContacts;
  if (matchesList(workList, { jid, name })) {
    return { decided: true, label: 'work', source: 'rules', reason: 'En la lista de trabajo.' };
  }

  if (isGroup && rules.groupsDefault !== 'classify') {
    return {
      decided: true,
      label: 'ignored',
      source: 'group-default',
      reason: 'Grupo no listado y groupsDefault = ignore.',
    };
  }

  return { decided: false };
}

/**
 * Clasifica la conversación con Claude.
 * Devuelve { label, confidence, reason, needsReply } o null si la llamada falla.
 */
export async function classifyWithAI({ chatName, isGroup, transcript }) {
  const rules = loadRules();
  const contextNote = rules.contextNote
    ? `\n\nContexto que el usuario ha dado sobre su trabajo:\n${rules.contextNote}`
    : '';

  const userContent = `Chat: ${chatName || 'desconocido'}${isGroup ? ' (grupo)' : ''}${contextNote}

Últimos mensajes de la conversación (el más reciente al final):
---
${transcript}
---

Clasifica esta conversación.`;

  try {
    const response = await getClient().messages.create({
      model: config.classifierModel,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: CLASSIFICATION_SCHEMA },
      },
      messages: [{ role: 'user', content: userContent }],
    });

    if (isRefusal(response)) {
      logger.warn({ chatName }, 'El clasificador rechazó la petición; se trata como unclear');
      return { label: 'unclear', confidence: 0, reason: 'Petición rechazada por seguridad.', needsReply: false };
    }

    const parsed = JSON.parse(textOf(response));
    return {
      label: parsed.label,
      confidence: parsed.confidence,
      reason: parsed.reason,
      needsReply: parsed.needs_reply,
    };
  } catch (error) {
    logger.error({ err: error, chatName }, 'Fallo al clasificar el mensaje');
    return null;
  }
}
