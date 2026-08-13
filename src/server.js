import path from 'node:path';
import express from 'express';
import { ROOT, config, loadRules, saveRules } from './config.js';
import { chats, classifications, drafts } from './db.js';
import { buildTranscript } from './pipeline.js';
import { generateDraft } from './drafter.js';
import { logger } from './logger.js';

export function createServer({ whatsapp }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // El panel se sirve abierto (pide el token en pantalla); la API va protegida.
  app.use(express.static(path.join(ROOT, 'public')));

  app.use('/api', (req, res, next) => {
    const header = req.get('authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const token = bearer || req.query.token;
    if (!config.panelToken) {
      return res.status(500).json({ error: 'PANEL_TOKEN no está configurado en el .env' });
    }
    if (token !== config.panelToken) {
      return res.status(401).json({ error: 'Token incorrecto' });
    }
    return next();
  });

  app.get('/api/status', (req, res) => {
    const status = whatsapp.status;
    res.json({
      connection: status.connection,
      connected: status.connection === 'open',
      me: status.me,
      qrDataUrl: status.qrDataUrl,
      pairingCode: status.pairingCode,
      lastError: status.lastError,
      pendingDrafts: drafts.countPending(),
    });
  });

  app.get('/api/drafts', (req, res) => {
    const status = req.query.status || 'pending';
    res.json({ drafts: drafts.list({ status, limit: 100 }) });
  });

  app.patch('/api/drafts/:id', (req, res) => {
    const draft = drafts.get(Number(req.params.id));
    if (!draft) return res.status(404).json({ error: 'Borrador no encontrado' });
    const text = String(req.body?.text ?? '');
    drafts.updateText(draft.id, text);
    return res.json({ draft: drafts.get(draft.id) });
  });

  app.post('/api/drafts/:id/send', async (req, res) => {
    const draft = drafts.get(Number(req.params.id));
    if (!draft) return res.status(404).json({ error: 'Borrador no encontrado' });
    if (draft.status !== 'pending') {
      return res.status(409).json({ error: `El borrador ya está en estado "${draft.status}"` });
    }

    // Si el panel manda texto editado, se guarda antes de enviar.
    const text = typeof req.body?.text === 'string' ? req.body.text : draft.draft_text;
    if (!text.trim()) return res.status(400).json({ error: 'El borrador está vacío' });
    if (text !== draft.draft_text) drafts.updateText(draft.id, text);

    try {
      await whatsapp.sendText(draft.chat_jid, text);
      drafts.markSent(draft.id);
      logger.info({ draftId: draft.id, chat: draft.chat_name }, 'Borrador enviado');
      return res.json({ draft: drafts.get(draft.id) });
    } catch (error) {
      drafts.markError(draft.id, error.message);
      logger.error({ err: error, draftId: draft.id }, 'Fallo al enviar');
      return res.status(502).json({ error: error.message });
    }
  });

  app.post('/api/drafts/:id/discard', (req, res) => {
    const draft = drafts.get(Number(req.params.id));
    if (!draft) return res.status(404).json({ error: 'Borrador no encontrado' });
    drafts.markDiscarded(draft.id);
    return res.json({ draft: drafts.get(draft.id) });
  });

  app.post('/api/drafts/:id/regenerate', async (req, res) => {
    const draft = drafts.get(Number(req.params.id));
    if (!draft) return res.status(404).json({ error: 'Borrador no encontrado' });

    const text = await generateDraft({
      chatName: draft.chat_name,
      isGroup: Boolean(draft.is_group),
      transcript: buildTranscript(draft.chat_jid),
      instruction: req.body?.instruction || null,
    });
    if (!text) return res.status(502).json({ error: 'No se pudo regenerar el borrador' });

    drafts.updateText(draft.id, text);
    return res.json({ draft: drafts.get(draft.id) });
  });

  app.get('/api/chats', (req, res) => {
    res.json({ chats: chats.recent(100) });
  });

  app.post('/api/chats/category', (req, res) => {
    const { jid, category } = req.body || {};
    if (!jid) return res.status(400).json({ error: 'Falta el jid' });
    if (![null, 'work', 'personal'].includes(category ?? null)) {
      return res.status(400).json({ error: 'category debe ser "work", "personal" o null' });
    }
    chats.setCategory(jid, category ?? null);
    return res.json({ chat: chats.get(jid) });
  });

  app.get('/api/rules', (req, res) => {
    res.json({ rules: loadRules() });
  });

  app.put('/api/rules', (req, res) => {
    try {
      res.json({ rules: saveRules(req.body?.rules || {}) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/log', (req, res) => {
    res.json({ entries: classifications.recent(50) });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  return app;
}
