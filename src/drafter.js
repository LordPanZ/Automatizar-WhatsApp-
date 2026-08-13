import { config, loadRules } from './config.js';
import { getClient, isRefusal, textOf } from './anthropic.js';
import { logger } from './logger.js';

const SYSTEM_PROMPT = `Escribes borradores de respuesta de WhatsApp en nombre del usuario, para mensajes de trabajo.

Cómo debe ser el borrador:
- En el mismo idioma en que te escriben.
- Con el registro del chat: si se tutean, tutea; si se tratan de usted, mantenlo.
- Longitud de WhatsApp, no de email: normalmente una o tres frases. Sin asunto, sin "Estimado", sin despedidas largas.
- Responde lo que se pregunta. Si hay varias preguntas, contéstalas todas.
- Nada de markdown, ni viñetas, ni encabezados. Texto plano tal y como se enviaría.

Lo que NO debes hacer:
- No inventes datos que el usuario no te ha dado: precios, fechas, cantidades, nombres, disponibilidad o compromisos concretos.
- Si hace falta un dato que no tienes, deja un hueco entre corchetes, por ejemplo [precio] o [fecha], para que el usuario lo rellene.
- No prometas nada en firme que dependa de información que no aparece en la conversación.
- No añadas explicaciones ni comentarios sobre el borrador. Devuelve solo el texto del mensaje.

Devuelve únicamente el texto del mensaje a enviar.`;

/**
 * Genera un borrador de respuesta para una conversación de trabajo.
 * @returns {Promise<string|null>} el texto del borrador, o null si falla.
 */
export async function generateDraft({ chatName, isGroup, transcript, instruction }) {
  const rules = loadRules();

  const parts = [
    `Chat: ${chatName || 'desconocido'}${isGroup ? ' (grupo de trabajo)' : ''}`,
  ];
  if (rules.contextNote) parts.push(`Contexto del trabajo del usuario: ${rules.contextNote}`);
  if (rules.toneNote) parts.push(`Tono deseado: ${rules.toneNote}`);
  parts.push(
    `Idioma por defecto si no queda claro: ${config.defaultLanguage}`,
    '',
    'Conversación (el mensaje más reciente al final):',
    '---',
    transcript,
    '---',
  );
  if (instruction) {
    parts.push('', `Instrucción concreta del usuario para este borrador: ${instruction}`);
  }
  parts.push('', 'Escribe el borrador de respuesta.');

  try {
    const response = await getClient().messages.create({
      model: config.drafterModel,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: parts.join('\n') }],
    });

    if (isRefusal(response)) {
      logger.warn({ chatName }, 'El redactor rechazó la petición');
      return null;
    }

    let draft = textOf(response);
    if (!draft) return null;

    if (config.signature) {
      draft = `${draft}\n${config.signature}`;
    }
    return draft;
  } catch (error) {
    logger.error({ err: error, chatName }, 'Fallo al generar el borrador');
    return null;
  }
}
