import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  useMultiFileAuthState,
} from 'baileys';
import QRCode from 'qrcode';
import { AUTH_DIR, config } from './config.js';
import { logger, waLogger } from './logger.js';

const IGNORED_JIDS = new Set(['status@broadcast']);

/** Saca el texto de un mensaje de Baileys, sea cual sea el envoltorio. */
function extractContent(waMessage) {
  let content = waMessage.message;
  // Los mensajes efímeros y de "ver una vez" vienen anidados.
  for (let depth = 0; depth < 4 && content; depth += 1) {
    if (content.ephemeralMessage) content = content.ephemeralMessage.message;
    else if (content.viewOnceMessage) content = content.viewOnceMessage.message;
    else if (content.viewOnceMessageV2) content = content.viewOnceMessageV2.message;
    else if (content.viewOnceMessageV2Extension) content = content.viewOnceMessageV2Extension.message;
    else if (content.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;
    else break;
  }
  if (!content) return null;

  if (content.conversation) return { kind: 'text', body: content.conversation };
  if (content.extendedTextMessage?.text) return { kind: 'text', body: content.extendedTextMessage.text };
  if (content.imageMessage) {
    return { kind: 'image', body: content.imageMessage.caption || '[imagen]' };
  }
  if (content.videoMessage) {
    return { kind: 'video', body: content.videoMessage.caption || '[vídeo]' };
  }
  if (content.documentMessage) {
    const name = content.documentMessage.fileName || 'documento';
    return { kind: 'document', body: content.documentMessage.caption || `[documento: ${name}]` };
  }
  if (content.audioMessage) {
    return { kind: 'audio', body: content.audioMessage.ptt ? '[nota de voz]' : '[audio]' };
  }
  if (content.stickerMessage) return { kind: 'sticker', body: '[sticker]' };
  if (content.locationMessage) return { kind: 'location', body: '[ubicación]' };
  if (content.contactMessage) return { kind: 'contact', body: '[contacto compartido]' };

  // reactionMessage, protocolMessage, pollUpdateMessage, etc: nada que procesar.
  return null;
}

/**
 * Crea y mantiene la conexión con WhatsApp.
 * @param {(msg: object) => void} onMessage se llama con cada mensaje relevante.
 */
export async function createWhatsApp({ onMessage }) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const status = {
    connection: 'connecting',
    qrDataUrl: null,
    pairingCode: null,
    me: null,
    lastError: null,
  };

  const groupNameCache = new Map();
  const lastIncoming = new Map(); // chatJid -> WAMessage, para poder citar al responder
  let sock;
  let pairingRequested = false;

  async function groupName(jid) {
    if (groupNameCache.has(jid)) return groupNameCache.get(jid);
    try {
      const metadata = await sock.groupMetadata(jid);
      groupNameCache.set(jid, metadata.subject || jid);
      return metadata.subject || jid;
    } catch {
      groupNameCache.set(jid, jid);
      return jid;
    }
  }

  function connect() {
    sock = makeWASocket({
      version,
      auth: state,
      logger: waLogger,
      browser: Browsers.appropriate('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false, // no aparecer "en línea" solo por tener esto abierto
      shouldIgnoreJid: (jid) =>
        IGNORED_JIDS.has(jid) || isJidBroadcast(jid) || isJidNewsletter(jid),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        status.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        if (!config.pairingPhone) {
          const ascii = await QRCode.toString(qr, { type: 'terminal', small: true });
          logger.info('Escanea este QR desde WhatsApp > Dispositivos vinculados:');
          process.stdout.write(`\n${ascii}\n`);
        }
      }

      // Vinculación por código de 8 letras (más cómodo que el QR desde el móvil).
      if (
        config.pairingPhone &&
        !sock.authState.creds.registered &&
        !pairingRequested &&
        typeof sock.requestPairingCode === 'function'
      ) {
        pairingRequested = true;
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(config.pairingPhone);
            status.pairingCode = code;
            logger.info(
              `Código de vinculación: ${code}  —  WhatsApp > Ajustes > Dispositivos vinculados > Vincular con número de teléfono`,
            );
          } catch (error) {
            pairingRequested = false;
            logger.error({ err: error }, 'No se pudo pedir el código de vinculación');
          }
        }, 3000);
      }

      if (connection) status.connection = connection;

      if (connection === 'open') {
        status.qrDataUrl = null;
        status.pairingCode = null;
        status.lastError = null;
        status.me = sock.user?.id || null;
        logger.info({ me: status.me }, 'Conectado a WhatsApp');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        status.lastError = lastDisconnect?.error?.message || null;

        if (loggedOut) {
          logger.error(
            'Sesión cerrada desde el teléfono. Borra la carpeta auth/ y vuelve a vincular (npm run logout).',
          );
          return;
        }
        logger.warn({ statusCode }, 'Conexión caída, reintentando en 5s');
        setTimeout(connect, 5000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages: incoming, type }) => {
      if (type !== 'notify') return; // 'append' es histórico sincronizado, no mensajes nuevos

      for (const waMessage of incoming) {
        try {
          const chatJid = waMessage.key?.remoteJid;
          if (!chatJid || IGNORED_JIDS.has(chatJid) || isJidBroadcast(chatJid) || isJidNewsletter(chatJid)) {
            continue;
          }

          const content = extractContent(waMessage);
          if (!content) continue;

          const isGroup = isJidGroup(chatJid);
          const fromMe = Boolean(waMessage.key.fromMe);
          const name = isGroup ? await groupName(chatJid) : waMessage.pushName || chatJid.split('@')[0];

          if (!fromMe) lastIncoming.set(chatJid, waMessage);

          onMessage({
            id: waMessage.key.id,
            chatJid,
            chatName: name,
            isGroup,
            fromMe,
            senderJid: isGroup ? waMessage.key.participant || null : chatJid,
            senderName: waMessage.pushName || null,
            body: content.body,
            kind: content.kind,
            ts: Number(waMessage.messageTimestamp) * 1000 || Date.now(),
          });
        } catch (error) {
          logger.error({ err: error }, 'Error procesando un mensaje entrante');
        }
      }
    });
  }

  connect();

  return {
    get status() {
      return { ...status };
    },
    isConnected() {
      return status.connection === 'open';
    },
    /**
     * Envía un mensaje de texto. Simula que se está escribiendo para que el envío
     * no parezca un bot disparando al milisegundo.
     */
    async sendText(chatJid, text) {
      if (status.connection !== 'open') {
        throw new Error('WhatsApp no está conectado');
      }
      await sock.sendPresenceUpdate('composing', chatJid);
      const typingMs = Math.min(4000, 600 + text.length * 25);
      await new Promise((resolve) => setTimeout(resolve, typingMs));
      await sock.sendPresenceUpdate('paused', chatJid);

      const quoted = lastIncoming.get(chatJid);
      const result = await sock.sendMessage(chatJid, { text }, quoted ? { quoted } : undefined);
      return result?.key?.id || null;
    },
    async logout() {
      await sock?.logout();
    },
  };
}
