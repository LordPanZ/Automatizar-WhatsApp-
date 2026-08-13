/* Panel de revisión de borradores. Sin dependencias externas. */
(() => {
  const TOKEN_KEY = 'wa-drafts-token';
  const POLL_MS = 5000;

  const $ = (id) => document.getElementById(id);
  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    view: 'pending',
    edited: new Set(), // ids con cambios sin guardar: no se pisan al refrescar
    busy: new Set(),
  };

  /* --- API ------------------------------------------------------------- */
  async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.token}`,
        ...(options.headers || {}),
      },
    });
    if (response.status === 401) {
      logout();
      throw new Error('Token incorrecto');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
    return data;
  }

  function toast(message, isError = false) {
    const el = $('toast');
    el.textContent = message;
    el.style.background = isError ? 'var(--danger)' : '';
    el.style.color = isError ? '#fff' : '';
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      el.hidden = true;
    }, 3000);
  }

  /* --- Acceso ---------------------------------------------------------- */
  function showLogin(message) {
    $('login').hidden = false;
    $('app').hidden = true;
    const error = $('login-error');
    error.hidden = !message;
    error.textContent = message || '';
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    state.token = '';
    showLogin();
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    state.token = $('token-input').value.trim();
    try {
      await api('/status');
      localStorage.setItem(TOKEN_KEY, state.token);
      $('login').hidden = true;
      $('app').hidden = false;
      refresh();
    } catch (error) {
      showLogin(error.message);
    }
  });

  $('logout').addEventListener('click', logout);

  /* --- Pestañas -------------------------------------------------------- */
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.view = tab.dataset.view;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('view-pending').hidden = state.view !== 'pending';
      $('view-history').hidden = state.view !== 'history';
      $('view-settings').hidden = state.view !== 'settings';
      refresh();
    });
  });

  /* --- Estado de la conexión ------------------------------------------- */
  function renderStatus(status) {
    const pill = $('status-pill');
    pill.className = 'pill';
    if (status.connected) {
      pill.textContent = 'Conectado';
      pill.classList.add('ok');
    } else if (status.pairingCode || status.qrDataUrl) {
      pill.textContent = 'Sin vincular';
      pill.classList.add('warn');
    } else {
      pill.textContent = status.connection || 'Desconectado';
      pill.classList.add('bad');
    }

    const count = $('pending-count');
    count.textContent = status.pendingDrafts;
    count.dataset.zero = String(status.pendingDrafts === 0);

    const panel = $('link-panel');
    panel.hidden = status.connected || (!status.pairingCode && !status.qrDataUrl);
    $('pairing-code-box').hidden = !status.pairingCode;
    $('pairing-code').textContent = status.pairingCode || '';
    $('qr-box').hidden = !status.qrDataUrl || Boolean(status.pairingCode);
    if (status.qrDataUrl) $('qr-image').src = status.qrDataUrl;
  }

  /* --- Borradores pendientes ------------------------------------------- */
  function draftCard(draft) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = draft.id;

    const confidence =
      draft.confidence !== null && draft.confidence < 1
        ? ` · ${Math.round(draft.confidence * 100)}%`
        : '';

    card.innerHTML = `
      <div class="card-head">
        <span class="chat-name"></span>
        <span class="pill">${draft.is_group ? 'Grupo' : 'Chat'}${confidence}</span>
      </div>
      <p class="hint reason"></p>
      <blockquote class="incoming"></blockquote>
      <textarea rows="5" class="draft-text"></textarea>
      <input class="instruction" type="text" placeholder="Instrucción para regenerar (opcional)" />
      <div class="actions">
        <button class="btn primary" data-action="send">Enviar</button>
        <button class="btn" data-action="regenerate">Regenerar</button>
        <button class="btn danger" data-action="discard">Descartar</button>
      </div>
    `;

    card.querySelector('.chat-name').textContent = draft.chat_name || draft.chat_jid;
    card.querySelector('.reason').textContent = draft.reason || '';
    card.querySelector('.incoming').textContent = draft.incoming_text || '';
    card.querySelector('.draft-text').value = draft.draft_text || '';

    const textarea = card.querySelector('.draft-text');
    textarea.addEventListener('input', () => state.edited.add(draft.id));

    card.querySelectorAll('button[data-action]').forEach((button) => {
      button.addEventListener('click', () => handleAction(draft.id, button.dataset.action, card));
    });

    return card;
  }

  async function handleAction(id, action, card) {
    if (state.busy.has(id)) return;
    const buttons = card.querySelectorAll('button');
    const text = card.querySelector('.draft-text').value;

    if (action === 'send' && !text.trim()) {
      toast('El borrador está vacío', true);
      return;
    }
    if (action === 'discard' && !confirm('¿Descartar este borrador?')) return;

    state.busy.add(id);
    buttons.forEach((b) => {
      b.disabled = true;
    });

    try {
      if (action === 'send') {
        await api(`/drafts/${id}/send`, { method: 'POST', body: JSON.stringify({ text }) });
        state.edited.delete(id);
        toast('Enviado');
      } else if (action === 'discard') {
        await api(`/drafts/${id}/discard`, { method: 'POST' });
        state.edited.delete(id);
        toast('Descartado');
      } else if (action === 'regenerate') {
        const instruction = card.querySelector('.instruction').value.trim();
        const { draft } = await api(`/drafts/${id}/regenerate`, {
          method: 'POST',
          body: JSON.stringify({ instruction: instruction || null }),
        });
        card.querySelector('.draft-text').value = draft.draft_text;
        state.edited.delete(id);
        toast('Borrador regenerado');
      }
    } catch (error) {
      toast(error.message, true);
    } finally {
      state.busy.delete(id);
      buttons.forEach((b) => {
        b.disabled = false;
      });
      refresh();
    }
  }

  async function renderPending() {
    const { drafts } = await api('/drafts?status=pending');
    const container = $('drafts');
    $('empty-pending').hidden = drafts.length > 0;

    const seen = new Set();
    for (const draft of drafts) {
      seen.add(draft.id);
      const existing = container.querySelector(`.card[data-id="${draft.id}"]`);
      if (existing) {
        // No pisar lo que el usuario esté escribiendo ahora mismo.
        if (!state.edited.has(draft.id) && document.activeElement !== existing.querySelector('.draft-text')) {
          existing.querySelector('.draft-text').value = draft.draft_text || '';
          existing.querySelector('.incoming').textContent = draft.incoming_text || '';
        }
      } else {
        container.appendChild(draftCard(draft));
      }
    }
    container.querySelectorAll('.card').forEach((card) => {
      if (!seen.has(Number(card.dataset.id))) card.remove();
    });
  }

  /* --- Historial ------------------------------------------------------- */
  const STATUS_LABEL = { sent: 'Enviado', discarded: 'Descartado', error: 'Error', pending: 'Pendiente' };
  const LABEL_TEXT = { work: 'Trabajo', personal: 'Personal', unclear: 'Dudoso', ignored: 'Ignorado' };

  async function renderHistory() {
    const [{ drafts }, { entries }] = await Promise.all([api('/drafts?status=all'), api('/log')]);

    const history = $('history');
    history.innerHTML = '';
    if (drafts.length === 0) {
      history.innerHTML = '<p class="empty">Todavía no hay nada.</p>';
    }
    for (const draft of drafts) {
      const row = document.createElement('div');
      row.className = 'card';
      const when = new Date(draft.updated_at).toLocaleString('es-ES');
      row.innerHTML = `
        <div class="card-head">
          <span class="chat-name"></span>
          <span class="pill ${draft.status === 'sent' ? 'ok' : draft.status === 'error' ? 'bad' : ''}">
            ${STATUS_LABEL[draft.status] || draft.status}
          </span>
        </div>
        <p class="hint"></p>
        <blockquote class="incoming"></blockquote>
      `;
      row.querySelector('.chat-name').textContent = draft.chat_name || draft.chat_jid;
      row.querySelector('.hint').textContent = when;
      row.querySelector('.incoming').textContent = draft.draft_text || '';
      history.appendChild(row);
    }

    const log = $('log');
    log.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card';
    if (entries.length === 0) {
      card.innerHTML = '<p class="hint">Sin decisiones registradas todavía.</p>';
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="row-name"></span>
        <span class="pill ${entry.label === 'work' ? 'ok' : ''}"></span>
      `;
      row.querySelector('.row-name').textContent = `${entry.chat_name || entry.chat_jid} — ${entry.reason || ''}`;
      row.querySelector('.pill').textContent = LABEL_TEXT[entry.label] || entry.label;
      card.appendChild(row);
    }
    log.appendChild(card);
  }

  /* --- Ajustes --------------------------------------------------------- */
  const LIST_FIELDS = ['workContacts', 'workGroups', 'ignoreContacts', 'ignoreGroups'];

  async function renderSettings() {
    const { rules } = await api('/rules');
    for (const field of LIST_FIELDS) {
      if (document.activeElement !== $(field)) $(field).value = (rules[field] || []).join('\n');
    }
    if (document.activeElement !== $('contextNote')) $('contextNote').value = rules.contextNote || '';
    if (document.activeElement !== $('toneNote')) $('toneNote').value = rules.toneNote || '';
    $('groupsDefault').value = rules.groupsDefault || 'ignore';

    const { chats } = await api('/chats');
    const container = $('chats');
    container.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card';
    if (chats.length === 0) {
      card.innerHTML = '<p class="hint">Aún no ha llegado ningún mensaje.</p>';
    }
    for (const chat of chats) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="row-name"></span>
        <span class="row-actions">
          <button class="btn small" data-category="work">Trabajo</button>
          <button class="btn small" data-category="personal">Personal</button>
          <button class="btn small" data-category="">Auto</button>
        </span>
      `;
      const label = chat.category === 'work' ? ' · trabajo' : chat.category === 'personal' ? ' · personal' : '';
      row.querySelector('.row-name').textContent = `${chat.name || chat.jid}${chat.is_group ? ' (grupo)' : ''}${label}`;
      row.querySelectorAll('button').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            await api('/chats/category', {
              method: 'POST',
              body: JSON.stringify({ jid: chat.jid, category: button.dataset.category || null }),
            });
            toast('Chat actualizado');
            renderSettings();
          } catch (error) {
            toast(error.message, true);
          }
        });
      });
      card.appendChild(row);
    }
    container.appendChild(card);
  }

  $('rules-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const rules = { groupsDefault: $('groupsDefault').value };
    for (const field of LIST_FIELDS) {
      rules[field] = $(field)
        .value.split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    }
    rules.contextNote = $('contextNote').value.trim();
    rules.toneNote = $('toneNote').value.trim();
    try {
      await api('/rules', { method: 'PUT', body: JSON.stringify({ rules }) });
      $('rules-saved').hidden = false;
      setTimeout(() => {
        $('rules-saved').hidden = true;
      }, 2000);
    } catch (error) {
      toast(error.message, true);
    }
  });

  /* --- Ciclo de refresco ------------------------------------------------ */
  async function refresh() {
    if (!state.token) return;
    try {
      renderStatus(await api('/status'));
      if (state.view === 'pending') await renderPending();
      else if (state.view === 'history') await renderHistory();
      else await renderSettings();
    } catch (error) {
      if (error.message !== 'Token incorrecto') toast(error.message, true);
    }
  }

  if (state.token) {
    $('app').hidden = false;
    refresh();
  } else {
    showLogin();
  }
  setInterval(() => {
    if (state.token && !document.hidden) refresh();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
})();
