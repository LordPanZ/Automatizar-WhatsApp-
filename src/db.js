import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR } from './config.js';

const db = new Database(path.join(DATA_DIR, 'whatsapp.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS chats (
  jid         TEXT PRIMARY KEY,
  name        TEXT,
  is_group    INTEGER NOT NULL DEFAULT 0,
  category    TEXT,              -- 'work' | 'personal' | NULL  (override manual del panel)
  last_seen   INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  chat_jid    TEXT NOT NULL,
  sender_jid  TEXT,
  sender_name TEXT,
  from_me     INTEGER NOT NULL DEFAULT 0,
  body        TEXT,
  kind        TEXT,              -- 'text' | 'image' | 'audio' | ...
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages (chat_jid, ts DESC);

CREATE TABLE IF NOT EXISTS drafts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid      TEXT NOT NULL,
  chat_name     TEXT,
  is_group      INTEGER NOT NULL DEFAULT 0,
  trigger_msg_id TEXT,
  incoming_text TEXT,
  draft_text    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | discarded | error
  reason        TEXT,
  confidence    REAL,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  sent_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts (status, created_at DESC);

CREATE TABLE IF NOT EXISTS classifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid    TEXT NOT NULL,
  chat_name   TEXT,
  label       TEXT NOT NULL,     -- work | personal | unclear | ignored
  source      TEXT NOT NULL,     -- rules | override | ai | group-default
  confidence  REAL,
  reason      TEXT,
  preview     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_classifications_created ON classifications (created_at DESC);
`);

const now = () => Date.now();

export const chats = {
  upsert({ jid, name, isGroup }) {
    db.prepare(
      `INSERT INTO chats (jid, name, is_group, last_seen)
       VALUES (@jid, @name, @isGroup, @lastSeen)
       ON CONFLICT(jid) DO UPDATE SET
         name = COALESCE(NULLIF(excluded.name, ''), chats.name),
         is_group = excluded.is_group,
         last_seen = excluded.last_seen`,
    ).run({ jid, name: name || '', isGroup: isGroup ? 1 : 0, lastSeen: now() });
  },
  get(jid) {
    return db.prepare('SELECT * FROM chats WHERE jid = ?').get(jid);
  },
  setCategory(jid, category) {
    db.prepare('UPDATE chats SET category = ? WHERE jid = ?').run(category, jid);
  },
  recent(limit = 100) {
    return db
      .prepare('SELECT * FROM chats ORDER BY last_seen DESC LIMIT ?')
      .all(limit);
  },
};

export const messages = {
  insert(msg) {
    db.prepare(
      `INSERT OR IGNORE INTO messages
         (id, chat_jid, sender_jid, sender_name, from_me, body, kind, ts)
       VALUES (@id, @chatJid, @senderJid, @senderName, @fromMe, @body, @kind, @ts)`,
    ).run({
      id: msg.id,
      chatJid: msg.chatJid,
      senderJid: msg.senderJid || null,
      senderName: msg.senderName || null,
      fromMe: msg.fromMe ? 1 : 0,
      body: msg.body || '',
      kind: msg.kind || 'text',
      ts: msg.ts,
    });
  },
  /** Últimos mensajes del chat, en orden cronológico. */
  recent(chatJid, limit) {
    const rows = db
      .prepare('SELECT * FROM messages WHERE chat_jid = ? ORDER BY ts DESC, rowid DESC LIMIT ?')
      .all(chatJid, limit);
    return rows.reverse();
  },
  /** Mensajes entrantes posteriores a mi última respuesta: lo que queda sin contestar. */
  unanswered(chatJid, limit = 20) {
    const lastMine = db
      .prepare('SELECT ts FROM messages WHERE chat_jid = ? AND from_me = 1 ORDER BY ts DESC LIMIT 1')
      .get(chatJid);
    const since = lastMine?.ts ?? 0;
    return db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_jid = ? AND from_me = 0 AND ts > ?
         ORDER BY ts ASC LIMIT ?`,
      )
      .all(chatJid, since, limit);
  },
};

export const drafts = {
  /** Un borrador pendiente por chat: si ya hay uno, se actualiza en vez de duplicar. */
  upsertPending(draft) {
    const existing = db
      .prepare("SELECT id FROM drafts WHERE chat_jid = ? AND status = 'pending'")
      .get(draft.chatJid);
    if (existing) {
      db.prepare(
        `UPDATE drafts SET
           chat_name = @chatName, is_group = @isGroup, trigger_msg_id = @triggerMsgId,
           incoming_text = @incomingText, draft_text = @draftText,
           reason = @reason, confidence = @confidence, error = NULL, updated_at = @updatedAt
         WHERE id = @id`,
      ).run({ ...draft, id: existing.id, updatedAt: now() });
      return existing.id;
    }
    const info = db
      .prepare(
        `INSERT INTO drafts
           (chat_jid, chat_name, is_group, trigger_msg_id, incoming_text, draft_text,
            status, reason, confidence, created_at, updated_at)
         VALUES (@chatJid, @chatName, @isGroup, @triggerMsgId, @incomingText, @draftText,
                 'pending', @reason, @confidence, @createdAt, @updatedAt)`,
      )
      .run({ ...draft, createdAt: now(), updatedAt: now() });
    return info.lastInsertRowid;
  },
  get(id) {
    return db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  },
  pendingForChat(chatJid) {
    return db
      .prepare("SELECT * FROM drafts WHERE chat_jid = ? AND status = 'pending'")
      .get(chatJid);
  },
  list({ status = 'pending', limit = 100 } = {}) {
    if (status === 'all') {
      return db.prepare('SELECT * FROM drafts ORDER BY created_at DESC LIMIT ?').all(limit);
    }
    return db
      .prepare('SELECT * FROM drafts WHERE status = ? ORDER BY created_at DESC LIMIT ?')
      .all(status, limit);
  },
  updateText(id, text) {
    db.prepare('UPDATE drafts SET draft_text = ?, updated_at = ? WHERE id = ?').run(text, now(), id);
  },
  markSent(id) {
    db.prepare("UPDATE drafts SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?").run(
      now(),
      now(),
      id,
    );
  },
  markDiscarded(id) {
    db.prepare("UPDATE drafts SET status = 'discarded', updated_at = ? WHERE id = ?").run(now(), id);
  },
  markError(id, message) {
    db.prepare("UPDATE drafts SET status = 'error', error = ?, updated_at = ? WHERE id = ?").run(
      message,
      now(),
      id,
    );
  },
  /** Si respondes tú a mano, el borrador pendiente deja de tener sentido. */
  discardPendingForChat(chatJid) {
    const info = db
      .prepare("UPDATE drafts SET status = 'discarded', updated_at = ? WHERE chat_jid = ? AND status = 'pending'")
      .run(now(), chatJid);
    return info.changes;
  },
  countPending() {
    return db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending'").get().n;
  },
};

export const classifications = {
  log(entry) {
    db.prepare(
      `INSERT INTO classifications
         (chat_jid, chat_name, label, source, confidence, reason, preview, created_at)
       VALUES (@chatJid, @chatName, @label, @source, @confidence, @reason, @preview, @createdAt)`,
    ).run({
      chatJid: entry.chatJid,
      chatName: entry.chatName || null,
      label: entry.label,
      source: entry.source,
      confidence: entry.confidence ?? null,
      reason: entry.reason || null,
      preview: (entry.preview || '').slice(0, 300),
      createdAt: now(),
    });
  },
  recent(limit = 50) {
    return db
      .prepare('SELECT * FROM classifications ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  },
};

export default db;
