import { config } from './config.js';
import { chats, classifications, drafts, messages } from './db.js';
import { applyRules, classifyWithAI } from './classifier.js';
import { generateDraft } from './drafter.js';
import { logger } from './logger.js';

const MIN_CONFIDENCE = 0.6;

/** Construye el transcript que se le pasa a la IA. */
export function buildTranscript(chatJid, limit = config.contextMessages) {
  return messages
    .recent(chatJid, limit)
    .map((row) => {
      const who = row.from_me ? 'YO' : row.sender_name || 'ELLOS';
      return `${who}: ${row.body}`;
    })
    .join('\n');
}

export function createPipeline() {
  const timers = new Map(); // chatJid -> timeout pendiente de analizar
  const analyzing = new Set(); // chats que ya se están analizando ahora mismo

  async function analyze(chatJid) {
    if (analyzing.has(chatJid)) return;
    analyzing.add(chatJid);
    try {
      const chat = chats.get(chatJid);
      if (!chat) return;

      const pending = messages.unanswered(chatJid);
      if (pending.length === 0) {
        // Ya has respondido tú mientras esperábamos: no hay nada que redactar.
        return;
      }

      const isGroup = Boolean(chat.is_group);
      const preview = pending.map((m) => m.body).join(' | ').slice(0, 300);

      const ruleResult = applyRules({
        jid: chatJid,
        name: chat.name,
        isGroup,
        categoryOverride: chat.category,
      });

      let label = ruleResult.label;
      let source = ruleResult.source;
      let reason = ruleResult.reason;
      let confidence = ruleResult.decided ? 1 : null;
      let needsReply = true;

      if (!ruleResult.decided) {
        const ai = await classifyWithAI({
          chatName: chat.name,
          isGroup,
          transcript: buildTranscript(chatJid),
        });
        if (!ai) {
          logger.warn({ chatJid }, 'Sin clasificación: no se genera borrador');
          return;
        }
        label = ai.label;
        source = 'ai';
        reason = ai.reason;
        confidence = ai.confidence;
        needsReply = ai.needsReply;
      }

      classifications.log({
        chatJid,
        chatName: chat.name,
        label,
        source,
        confidence,
        reason,
        preview,
      });

      if (label !== 'work') {
        logger.info({ chatJid, chat: chat.name, label, source }, 'No es trabajo: sin borrador');
        return;
      }
      if (source === 'ai' && confidence !== null && confidence < MIN_CONFIDENCE) {
        logger.info(
          { chatJid, chat: chat.name, confidence },
          'Es trabajo pero con poca confianza: sin borrador',
        );
        return;
      }
      if (!needsReply) {
        logger.info({ chatJid, chat: chat.name }, 'Mensaje de trabajo que no pide respuesta: sin borrador');
        return;
      }

      const draftText = await generateDraft({
        chatName: chat.name,
        isGroup,
        transcript: buildTranscript(chatJid),
      });
      if (!draftText) {
        logger.warn({ chatJid }, 'No se pudo redactar el borrador');
        return;
      }

      const id = drafts.upsertPending({
        chatJid,
        chatName: chat.name,
        isGroup: isGroup ? 1 : 0,
        triggerMsgId: pending[pending.length - 1].id,
        incomingText: pending.map((m) => m.body).join('\n'),
        draftText,
        reason,
        confidence,
      });
      logger.info({ draftId: id, chat: chat.name }, 'Borrador listo para revisar');
    } catch (error) {
      logger.error({ err: error, chatJid }, 'Error analizando la conversación');
    } finally {
      analyzing.delete(chatJid);
    }
  }

  /** Punto de entrada: se llama con cada mensaje que llega de WhatsApp. */
  function handleMessage(msg) {
    chats.upsert({ jid: msg.chatJid, name: msg.chatName, isGroup: msg.isGroup });
    messages.insert({
      id: msg.id,
      chatJid: msg.chatJid,
      senderJid: msg.senderJid,
      senderName: msg.senderName,
      fromMe: msg.fromMe,
      body: msg.body,
      kind: msg.kind,
      ts: msg.ts,
    });

    if (msg.fromMe) {
      // Has contestado tú: el borrador pendiente sobra y cualquier análisis en cola también.
      const timer = timers.get(msg.chatJid);
      if (timer) {
        clearTimeout(timer);
        timers.delete(msg.chatJid);
      }
      const discarded = drafts.discardPendingForChat(msg.chatJid);
      if (discarded > 0) {
        logger.info({ chat: msg.chatName }, 'Respondiste a mano: borrador pendiente descartado');
      }
      return;
    }

    // Debounce: si llegan cinco mensajes seguidos, analizamos una sola vez al final.
    const existing = timers.get(msg.chatJid);
    if (existing) clearTimeout(existing);
    timers.set(
      msg.chatJid,
      setTimeout(() => {
        timers.delete(msg.chatJid);
        analyze(msg.chatJid);
      }, config.debounceMs),
    );
  }

  return { handleMessage, analyze };
}
