import { api, session } from './api.js';
import { PollingManager } from './polling.js';
import { DraftStore, parseRecipients, replyMessage, forwardMessage } from './mail-store.js';
import { el, icon, toast, emptyState, dateTime, shortTime } from './mail-ui.js';

const $ = selector => document.querySelector(selector);
const titles = { inbox: 'Caixa de entrada', sent: 'Enviados', drafts: 'Rascunhos', trash: 'Lixeira', starred: 'Com estrela', archive: 'Arquivados', spam: 'Spam', snoozed: 'Adiados' };
const state = { user: null, config: null, folder: 'inbox', rows: new Map(), selected: new Set(), offset: 0,
  total: 0, query: '', cursor: null, message: null, thread: null, collapsed: new Set(), readerVersion: 0,
  people: [], directory: [], activity: null, teacherStatus: null,
  totals: {}, draft: null, files: [], missingFiles: [], forwarded: [], dialogMode: null, loadVersion: 0,
  failures: new Set(), expired: false, sound: sessionStorage.getItem('correio-lan:sound') === 'true' };
let drafts;
let polling;
let audio;
let draftTimer;
let searchTimer;
let booting = false;
let sending = false;

function updateCounts() {
  for (const node of document.querySelectorAll('[data-count]')) {
    const key = node.dataset.count;
    const count = key === 'drafts' ? drafts?.list().length ?? 0 : state.totals[key] ?? 0;
    node.textContent = count || '';
  }
}
function connection() {
  const disconnected = state.failures.size > 0;
  const node = $('#connection-status');
  node.classList.toggle('disconnected', disconnected);
  node.replaceChildren(el('i', 'status-dot'), document.createTextNode(disconnected ? ' Sem conexão com o servidor' : ' Conectado'));
}
function playSound() {
  if (!state.sound || !audio) return;
  const oscillator = audio.createOscillator(); const gain = audio.createGain();
  oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(660, audio.currentTime);
  oscillator.frequency.setValueAtTime(880, audio.currentTime + .1);
  gain.gain.setValueAtTime(.035, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .22);
  oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + .23);
}
function displayPeople(container = $('#people-list')) {
  const fragment = document.createDocumentFragment();
  const users = [...state.people].sort((a, b) => a.id === state.user.id ? -1 : b.id === state.user.id ? 1 : Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  for (const user of users) {
    const row = el('div', 'person'); const info = el('div', 'person-info');
    const name = el('strong', '', user.name);
    if (user.id === state.user.id) name.append(el('em', '', 'Você'));
    else if (user.role === 'teacher') name.append(el('em', '', 'Professor'));
    info.append(name, el('small', '', user.email));
    row.append(el('i', `status-dot${user.online ? '' : ' offline'}`), info); fragment.append(row);
  }
  if (users.filter(user => user.id !== state.user.id && user.online).length === 0) fragment.append(el('p', 'muted people-empty', 'Ninguém mais está online nesta sala.'));
  container.replaceChildren(fragment);
}
async function refreshPeople(signal) {
  const data = await api('/rooms/users', { signal });
  state.people = data.users; state.directory = data.directory;
  $('#online-count').textContent = `${data.onlineCount} online`;
  $('#room-label').textContent = `${state.user.room} · ${data.onlineCount} online`;
  displayPeople();
  if (state.dialogMode === 'people' && $('#utility-dialog').open) displayPeople($('#dialog-content'));
}
function rowNode(message, draft = false) {
  const row = el('div', `mail-row${!message.read && !draft ? ' unread' : ''}${message.starred ? ' starred' : ''}`);
  const selectionId = message.threadId ?? message.id;
  row.dataset.messageId = message.id;
  const check = document.createElement('input'); check.type = 'checkbox';
  check.setAttribute('aria-label', `Selecionar ${message.subject || 'rascunho'}`); check.checked = state.selected.has(selectionId);
  check.addEventListener('change', () => { if (check.checked) state.selected.add(selectionId); else state.selected.delete(selectionId); updateSelection(); });
  row.append(check);
  if (!draft) {
    const star = el('button', 'icon-button row-star'); star.append(icon('imgEmailRowStar.svg'));
    star.setAttribute('aria-label', message.starred ? 'Remover estrela' : 'Adicionar estrela'); star.setAttribute('aria-pressed', String(message.starred));
    star.addEventListener('click', () => perform(() => mutate(message.id, 'star', { starred: !message.starred }, true)));
    row.append(star);
  }
  const button = el('button', 'mail-row-main');
  const sender = el('span', 'row-sender', draft ? 'Rascunho' : message.threadCount > 1 ? message.participants.join(', ')
    : state.folder === 'sent' ? `Para: ${message.to.join(', ') || 'destinatário oculto'}` : message.fromName);
  if (message.threadCount > 1) sender.append(el('span', 'thread-count', ` (${message.threadCount})`));
  button.append(sender);
  const content = el('span', 'row-content');
  content.append(el('span', 'row-subject', message.subject || '(Sem assunto)'), el('span', 'row-preview', ` — ${message.preview || message.body || ''}`));
  button.append(content);
  button.addEventListener('click', () => draft ? openCompose(message) : perform(() => openMessage(message.id)));
  row.append(button);
  if (message.hasAttachments || (message.attachments?.length || message.savedFileNames?.length) > 0) { const attachment = el('span', 'row-attachment', '📎'); attachment.setAttribute('aria-label', 'Com anexos'); row.append(attachment); }
  const time = el('time', 'row-time', shortTime(message.timestamp || message.updatedAt));
  time.dateTime = new Date(message.timestamp || message.updatedAt).toISOString(); row.append(time);
  return row;
}
function renderList() {
  const container = $('#message-list');
  const rows = state.folder === 'drafts' ? drafts.list().filter(draft => !state.query || `${draft.subject} ${draft.body}`.toLowerCase().includes(state.query.toLowerCase()))
    : [...state.rows.values()];
  if (state.folder !== 'drafts') rows.sort((a, b) => b.timestamp - a.timestamp);
  if (!rows.length) {
    const title = state.query ? 'Nenhuma mensagem encontrada.' : state.folder === 'inbox' ? 'Nenhuma mensagem recebida.'
      : state.folder === 'sent' ? 'Você ainda não enviou mensagens.' : state.folder === 'drafts' ? 'Nenhum rascunho salvo.' : 'Esta pasta está vazia.';
    emptyState(container, title, state.query ? 'Tente outro nome, assunto ou palavra.' : 'Escreva para alguém da sua sala e comece a conversa.', { label: 'Escrever mensagem', run: () => openCompose() });
  } else container.replaceChildren(...rows.map(message => rowNode(message, state.folder === 'drafts')));
  $('#folder-title').textContent = titles[state.folder];
  $('#list-caption').textContent = state.query ? `Resultados para “${state.query}”` : 'Sua turma, a uma mensagem de distância.';
  const total = state.folder === 'drafts' ? rows.length : state.total;
  $('#pagination-label').textContent = total ? `${state.offset + 1}–${Math.min(state.offset + rows.length, total)} de ${total}` : state.folder === 'drafts' ? '0 rascunhos' : '0 conversas';
  $('#previous-page').disabled = state.offset === 0 || state.folder === 'drafts';
  $('#next-page').disabled = state.offset + 50 >= total || state.folder === 'drafts';
  updateSelection(); updateCounts();
}
function updateSelection() {
  $('#bulk-trash').disabled = !state.selected.size || state.folder === 'trash';
  $('#select-all').checked = state.rows.size > 0 && state.selected.size === state.rows.size;
}
async function loadFolder({ reset = false } = {}) {
  const version = ++state.loadVersion;
  if (reset) { state.offset = 0; state.selected.clear(); }
  if (state.folder === 'drafts') { state.rows = new Map(drafts.list().map(item => [item.id, item])); renderList(); return; }
  const params = new URLSearchParams({ offset: String(state.offset), limit: '50', view: 'threads' });
  if (state.query) params.set('q', state.query);
  const data = await api(`/messages/${state.folder}?${params}`);
  if (version !== state.loadVersion) return;
  state.rows = new Map(data.messages.map(message => [message.threadId, message]));
  state.selected = new Set([...state.selected].filter(id => state.rows.has(id)));
  state.total = data.total; state.totals = data.totals;
  if (state.cursor === null) state.cursor = data.cursor;
  renderList();
}
function showList() {
  $('#reader').hidden = true; $('#mail-list-view').hidden = false;
  state.message = null; state.thread = null; state.readerVersion++; document.body.classList.remove('reading-expanded');
  $('#folder-title').focus?.();
}
async function changeFolder(folder) {
  state.folder = folder; state.query = ''; $('#search-input').value = '';
  for (const button of document.querySelectorAll('[data-folder]')) {
    const selected = button.dataset.folder === folder; button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  document.title = `Correio LAN — ${titles[folder]}`;
  document.body.classList.remove('mobile-nav-open'); showList();
  await loadFolder({ reset: true });
}
async function syncMessages(signal) {
  if (state.cursor === null) return;
  const data = await api(`/messages/sync?cursor=${state.cursor}&view=threads`, { signal });
  state.totals = data.totals;
  const notified = new Set();
  for (const event of data.events) {
    const message = event.message;
    if (event.kind === 'created' && message?.inbox && !notified.has(message.id)) {
      notified.add(message.id); toast('Nova mensagem', `${message.fromName} · ${message.subject}`); playSound();
    }
  }
  if (state.thread && (data.reset || data.events.some(event => event.message?.threadId === state.thread.id || state.thread.messages.some(message => message.id === event.messageId)))) {
    const deleted = new Set(data.events.filter(event => !event.message).map(event => event.messageId));
    const anchor = data.events.findLast(event => event.message?.threadId === state.thread.id)?.message.id
      ?? state.thread.messages.filter(message => !deleted.has(message.id)).at(-1)?.id;
    if (anchor) await refreshConversation(anchor, signal); else showList();
  }
  if (data.reset || data.events.length) await loadFolder();
  // Avança apenas após aplicar os eventos/refazer a página; uma falha permite tentar novamente.
  state.cursor = data.cursor; updateCounts();
}
async function openMessage(id) {
  const version = ++state.readerVersion;
  let data = await api(`/messages/${encodeURIComponent(id)}/thread`);
  if (version !== state.readerVersion) return;
  if (data.messages.some(message => !message.read && message.inbox && !message.trash)) data = await api(`/messages/${id}/thread/read`, { method: 'PATCH', body: { read: true } });
  if (version !== state.readerVersion) return;
  if (state.thread?.id !== data.id) state.collapsed.clear();
  setConversation(data); await loadFolder();
  if (version !== state.readerVersion) return;
  renderMessage(); $('#mail-list-view').hidden = true; $('#reader').hidden = false;
  $('#reader-subject').tabIndex = -1; $('#reader-subject').focus(); polling?.trigger('messages');
}
function setConversation(data) { state.thread = data; state.message = data.messages.at(-1); }
async function refreshConversation(id, signal) {
  const version = state.readerVersion;
  try {
    let data = await api(`/messages/${id}/thread`, { signal });
    if (version !== state.readerVersion || !state.thread) return;
    if (data.messages.some(message => message.inbox && !message.trash && !message.read)) data = await api(`/messages/${id}/thread/read`, { method: 'PATCH', body: { read: true }, signal });
    if (version !== state.readerVersion || !state.thread) return;
    setConversation(data); renderMessage();
  } catch (error) { if (error.status === 404 && version === state.readerVersion) showList(); else throw error; }
}
function renderMessage() {
  if (!state.thread) return;
  $('#reader-subject').textContent = state.thread.subject;
  $('#reader-count').textContent = `${state.thread.messages.length} ${state.thread.messages.length === 1 ? 'mensagem' : 'mensagens'}`;
  $('#reader-folder').textContent = titles[state.folder];
  $('#restore-button').hidden = !state.thread.messages.some(message => message.trash);
  $('#delete-button').hidden = !state.thread.messages.every(message => message.trash);
  $('#conversation-messages').replaceChildren(...state.thread.messages.map(conversationMessageNode));
}
function conversationMessageNode(message) {
  const article = el('article', 'thread-message'); article.dataset.messageId = message.id;
  const meta = el('div', 'reader-meta');
  const toggle = el('button', 'thread-toggle'); toggle.type = 'button';
  toggle.setAttribute('aria-label', `Recolher mensagem de ${message.fromName}`);
  const sender = el('span', 'reader-sender');
  sender.append(el('strong', '', message.from === state.user.email ? `${message.fromName} (você)` : message.fromName), el('span', 'muted thread-email', ` <${message.from}>`));
  const preview = el('span', 'thread-preview muted', message.preview);
  const time = el('time', '', dateTime(message.timestamp)); time.dateTime = new Date(message.timestamp).toISOString();
  toggle.append(icon('imgAvatar.svg', 40), sender, preview, time);
  const star = el('button', `icon-button${message.starred ? ' starred' : ''}`); star.append(icon('imgEmailRowStar.svg'));
  star.setAttribute('aria-label', `Alternar estrela da mensagem de ${message.fromName}`); star.setAttribute('aria-pressed', String(message.starred));
  star.addEventListener('click', () => perform(() => mutate(message.id, 'star', { starred: !message.starred })));
  const reply = el('button', 'icon-button'); reply.append(icon('imgIconReply1.svg'));
  reply.setAttribute('aria-label', `Responder à mensagem de ${message.fromName}`);
  reply.addEventListener('click', () => openCompose(replyMessage(message, state.user.email)));
  meta.append(toggle, star, reply);
  const content = el('div', 'reader-content thread-content');
  const details = el('details', 'thread-addresses'); const summary = el('summary', '', `para ${message.to.includes(state.user.email) ? 'mim' : message.to.join(', ') || 'destinatário oculto'}`);
  const addresses = el('dl');
  for (const [label, value] of [['De', `${message.fromName} <${message.from}>`], ['Para', message.to.join(', ') || '—'], ['Cc', message.cc.join(', ') || '—'], ['Data', dateTime(message.timestamp)]]) addresses.append(el('dt', '', label), el('dd', '', value));
  details.append(summary, addresses); content.append(details);
  if (message.receivedAsBcc) content.append(el('p', 'bcc-notice', 'Você recebeu esta mensagem como CCO.'));
  if (message.trash) content.append(el('span', 'badge', 'Lixeira'));
  content.append(el('div', 'message-body', message.body), attachmentNodes(message));
  function collapse() {
    const collapsed = state.collapsed.has(message.id); content.hidden = collapsed; article.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed)); toggle.setAttribute('aria-label', `${collapsed ? 'Expandir' : 'Recolher'} mensagem de ${message.fromName}`);
  }
  toggle.addEventListener('click', () => { if (state.collapsed.has(message.id)) state.collapsed.delete(message.id); else state.collapsed.add(message.id); collapse(); });
  article.append(meta, content); collapse(); return article;
}
function attachmentNodes(message) {
  const container = el('div', 'attachment-list');
  container.append(...message.attachments.map(file => {
    const button = el('button', 'attachment-download'); const label = el('span', '', file.name);
    label.append(el('small', '', `${(file.size / 1024).toFixed(0)} KB · Baixar`)); button.append(icon('imgIconAttachFileStateInitial.svg', 24), label);
    button.addEventListener('click', () => perform(async () => {
      button.disabled = true;
      try {
        const blob = await api(`/messages/${message.id}/attachments/${file.id}`, { download: true });
        const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = file.name;
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      } finally { button.disabled = false; }
    })); return button;
  })); return container;
}
async function mutate(id, action, body = {}, wholeThread = false) {
  const data = await api(`/messages/${id}/${wholeThread ? 'thread/' : ''}${action}`, { method: 'PATCH', body });
  if (state.thread && (wholeThread ? state.thread.id === data.id : state.thread.messages.some(message => message.id === id))) {
    if (wholeThread) setConversation(data);
    else setConversation({ ...state.thread, messages: state.thread.messages.map(message => message.id === id ? data : message) });
    renderMessage();
  }
  await loadFolder(); polling?.trigger('messages'); return data;
}
async function readerAction(action) {
  const message = state.message;
  if (action === 'back') { showList(); return; }
  if (action === 'activity') { showActivity(); return; }
  if (!message) return;
  if (action === 'reply' || action === 'reply-all') { openCompose(replyMessage(message, state.user.email, action === 'reply-all')); return; }
  if (action === 'forward') { openCompose(forwardMessage(message)); return; }
  if (action === 'star') { await mutate(message.id, 'star', { starred: !state.thread.messages.some(item => item.starred) }, true); return; }
  if (action === 'print') { window.print(); return; }
  if (action === 'expand') { document.body.classList.toggle('reading-expanded'); return; }
  if (action === 'more') { showMessageActions(); return; }
  if (action === 'delete') {
    if (!window.confirm('Excluir definitivamente suas cópias de todas as mensagens desta conversa?')) return;
    await api(`/messages/${message.id}/thread`, { method: 'DELETE' }); showList(); await loadFolder(); polling.trigger('messages'); toast('Conversa excluída'); return;
  }
  if (action === 'trash' || action === 'restore') {
    await mutate(message.id, action, {}, true); showList(); toast(action === 'trash' ? 'Conversa movida para a lixeira' : 'Conversa restaurada');
  } else if (action === 'unread') { await mutate(message.id, 'read', { read: false }, true); showList(); }
  else if (['archive', 'spam', 'snoozed', 'inbox'].includes(action)) {
    await mutate(message.id, 'location', { location: action }, true); showList(); toast(action === 'snoozed' ? 'Conversa adiada por uma hora' : 'Conversa movida');
  }
}
function perform(action) { return Promise.resolve().then(action).catch(error => { if (!state.expired) toast('Não foi possível concluir', error.message, { error: true }); }); }

function draftValue() {
  const base = state.draft;
  return { id: base.id, sendKey: base.sendKey, to: parseRecipients($('#compose-to').value), cc: parseRecipients($('#compose-cc').value),
    bcc: parseRecipients($('#compose-bcc').value), subject: $('#compose-subject').value, body: $('#compose-body').value,
    savedFileNames: [...state.missingFiles, ...state.files.map(file => file.name)],
    inReplyTo: base.inReplyTo, forwardMessageId: base.forwardMessageId, forwardedAttachments: state.forwarded };
}
function hasDraftContent(value) { return value.subject || value.body || value.to.length || value.cc.length || value.bcc.length || value.savedFileNames.length || value.forwardedAttachments.length; }
function persistDraft() {
  if (!state.draft || sending) return;
  const value = draftValue();
  if (hasDraftContent(value)) { drafts.save(value); $('#draft-status').textContent = 'Rascunho salvo nesta aba'; }
  else drafts.remove(value.id);
  updateCounts();
}
function safePersistDraft() { try { persistDraft(); } catch { $('#draft-status').textContent = 'Não foi possível salvar: espaço do navegador insuficiente. Copie seu texto.'; } }
function openCompose(value = {}) {
  if (sending) return;
  if (state.draft) safePersistDraft();
  state.draft = { ...value, id: value.id || crypto.randomUUID(), sendKey: value.sendKey || crypto.randomUUID() };
  state.files = []; state.missingFiles = value.savedFileNames || []; state.forwarded = value.forwardedAttachments || [];
  for (const key of ['to', 'cc', 'bcc']) $(`#compose-${key}`).value = (value[key] || []).join(', ');
  $('#cc-line').hidden = !value.cc?.length; $('#bcc-line').hidden = !value.bcc?.length;
  $('#compose-subject').value = value.subject || ''; $('#compose-body').value = value.body || '';
  $('#compose-error').hidden = true; $('#draft-status').textContent = state.missingFiles.length ? 'Selecione novamente os anexos do rascunho.' : '';
  $('#composer').hidden = false; $('#composer').classList.remove('minimized'); $('#file-input').value = '';
  $('#compose-body').maxLength = state.config.maxMessageLength; $('#composer-title').textContent = value.inReplyTo ? 'Responder à conversa' : 'Nova mensagem';
  renderComposeFiles(); hideSuggestions(); $('#compose-to').focus();
}
function closeCompose({ discard = false } = {}) {
  if (!state.draft || sending) return;
  clearTimeout(draftTimer);
  if (discard) drafts.remove(state.draft.id); else {
    try { persistDraft(); } catch { toast('O rascunho não foi salvo', 'Copie seu texto antes de fechar: o navegador está sem espaço.', { error: true }); return; }
  }
  state.draft = null; state.files = []; state.forwarded = []; state.missingFiles = [];
  $('#composer').hidden = true; $('#compose-button').focus(); updateCounts();
  if (state.folder === 'drafts') perform(() => loadFolder());
}
function renderComposeFiles() {
  const chips = [];
  function chip(label, remove) { const node = el('div', 'attachment-chip'); const button = el('button', '', '×'); button.type = 'button'; button.setAttribute('aria-label', `Remover ${label}`); button.addEventListener('click', () => { remove(); state.draft.sendKey = crypto.randomUUID(); renderComposeFiles(); safePersistDraft(); }); node.append(el('span', '', label), button); return node; }
  state.files.forEach((file, index) => chips.push(chip(`${file.name} · ${(file.size / 1024).toFixed(0)} KB`, () => state.files.splice(index, 1))));
  state.forwarded.forEach((file, index) => chips.push(chip(`${file.name} · encaminhado`, () => state.forwarded.splice(index, 1))));
  state.missingFiles.forEach((name, index) => chips.push(chip(`${name} · selecionar novamente`, () => state.missingFiles.splice(index, 1))));
  $('#compose-attachments').replaceChildren(...chips);
}
function pickFiles(accept = '.pdf,.png,.jpg,.jpeg,.txt,.docx') { $('#file-input').accept = accept; $('#file-input').click(); }
$('#file-input').addEventListener('change', () => {
  const files = Array.from($('#file-input').files);
  const remainingMissing = state.missingFiles.filter(name => !files.some(file => file.name === name));
  if (files.some(file => file.size > state.config.maxAttachmentSize || !/\.(pdf|png|jpe?g|txt|docx)$/i.test(file.name))) {
    toast('Anexo inválido', `Use PDF, PNG, JPG, TXT ou DOCX de até ${(state.config.maxAttachmentSize / 1024 / 1024).toFixed(0)} MB.`, { error: true }); return;
  }
  if (state.files.length + state.forwarded.length + remainingMissing.length + files.length > state.config.maxAttachments) {
    toast('Limite de anexos', `Use no máximo ${state.config.maxAttachments} anexos.`, { error: true }); return;
  }
  state.missingFiles = remainingMissing; state.files.push(...files); state.draft.sendKey = crypto.randomUUID();
  renderComposeFiles(); safePersistDraft(); $('#file-input').value = '';
});
$('#compose-form').addEventListener('input', () => {
  if (!state.draft) return;
  state.draft.sendKey = crypto.randomUUID(); $('#compose-error').hidden = true;
  clearTimeout(draftTimer); draftTimer = setTimeout(safePersistDraft, 350);
});
$('#compose-form').addEventListener('submit', async event => {
  event.preventDefault(); if (sending || !state.draft) return;
  const errorNode = $('#compose-error'); errorNode.hidden = true;
  if (state.missingFiles.length) { errorNode.textContent = 'Selecione novamente os anexos indicados ou remova-os antes de enviar.'; errorNode.hidden = false; return; }
  const draft = draftValue();
  if (draft.to.length + draft.cc.length + draft.bcc.length > state.config.maxRecipients) { errorNode.textContent = `Use no máximo ${state.config.maxRecipients} destinatários.`; errorNode.hidden = false; return; }
  safePersistDraft(); clearTimeout(draftTimer); sending = true;
  const controls = [...$('#compose-form').elements, ...$('.composer-header').querySelectorAll('button')];
  controls.forEach(control => control.disabled = true); $('#send-button').firstChild.textContent = 'Enviando';
  const form = new FormData();
  form.set('message', JSON.stringify({ to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body,
    inReplyTo: draft.inReplyTo, forwardMessageId: draft.forwardMessageId, forwardedAttachmentIds: state.forwarded.map(file => file.id) }));
  state.files.forEach(file => form.append('attachments', file));
  try {
    const sent = await api('/messages', { method: 'POST', body: form, headers: { 'Idempotency-Key': draft.sendKey }, timeout: 30000 });
    sending = false; controls.forEach(control => control.disabled = false); closeCompose({ discard: true });
    toast('Mensagem enviada'); polling.trigger('messages');
    if (draft.inReplyTo && state.thread?.id === sent.threadId) await openMessage(sent.id);
    else if (state.folder === 'sent') await loadFolder({ reset: true });
  } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; }
  finally { sending = false; controls.forEach(control => control.disabled = false); $('#send-button').firstChild.textContent = 'Enviar'; }
});
function hideSuggestions() {
  for (const input of document.querySelectorAll('[data-recipients]')) {
    const list = $(`#suggestions-${input.dataset.recipients}`); list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  }
}
for (const input of document.querySelectorAll('[data-recipients]')) {
  const list = $(`#suggestions-${input.dataset.recipients}`);
  let active = -1;
  input.addEventListener('focus', hideSuggestions);
  input.addEventListener('blur', event => {
    if (!list.contains(event.relatedTarget)) hideSuggestions();
  });
  list.addEventListener('focusout', event => {
    if (event.relatedTarget !== input && !list.contains(event.relatedTarget)) hideSuggestions();
  });
  input.addEventListener('input', () => {
    hideSuggestions();
    const partial = input.value.split(/[;,]/).at(-1).trim().toLocaleLowerCase('pt-BR'); active = -1;
    const selected = parseRecipients(input.value.replace(/[^;,]*$/, ''));
    const suggestions = partial ? state.directory.filter(user => !selected.includes(user.email) && `${user.name} ${user.email}`.toLocaleLowerCase('pt-BR').includes(partial)).slice(0, 6) : [];
    list.replaceChildren(...suggestions.map((user, index) => {
      const button = el('button', 'suggestion'); button.type = 'button'; button.id = `${list.id}-${index}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', 'false');
      button.append(el('span', '', user.name), el('small', '', `${user.email}${user.online ? '' : ' · offline'}`));
      button.addEventListener('click', () => {
        const existing = input.value.replace(/[^;,]*$/, ''); input.value = `${existing}${user.email}, `;
        input.dispatchEvent(new Event('input', { bubbles: true })); hideSuggestions(); input.focus();
      }); return button;
    }));
    list.hidden = !suggestions.length; input.setAttribute('aria-expanded', String(suggestions.length > 0));
  });
  input.addEventListener('keydown', event => {
    if (list.hidden) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + list.children.length) % list.children.length;
      [...list.children].forEach((node, index) => { node.classList.toggle('active', index === active); node.setAttribute('aria-selected', String(index === active)); });
      input.setAttribute('aria-activedescendant', list.children[active].id);
    } else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); list.children[active].click(); }
    else if (event.key === 'Escape') { event.preventDefault(); hideSuggestions(); }
  });
}
document.addEventListener('click', event => { if (!event.target.closest('.recipient-line')) hideSuggestions(); });

function showDialog(title, content, mode = null) {
  state.dialogMode = mode; $('#dialog-title').textContent = title; $('#dialog-content').replaceChildren(content);
  if (!$('#utility-dialog').open) $('#utility-dialog').showModal();
}
function closeDialog() { $('#utility-dialog').close(); state.dialogMode = null; }
$('#close-dialog').addEventListener('click', closeDialog);
$('#utility-dialog').addEventListener('close', () => state.dialogMode = null);
function showHelp() {
  const content = el('div', 'dialog-copy');
  for (const message of [
    'Use o mesmo nome de sala que seus colegas. Clique em Escrever e selecione um destinatário pelas sugestões.',
    'Cc envia uma cópia visível. Cco envia uma cópia oculta: os outros destinatários não veem esse endereço.',
    'Os endereços .local funcionam dentro desta simulação. Mensagens não são enviadas para serviços externos de e-mail.',
    'Se a conexão cair, seu texto fica preservado. A sessão pode ser recuperada nesta aba por até 30 minutos sem heartbeat. Clicar em Sair encerra a sessão.',
    'Salas, mensagens, atividades e anexos são temporários e desaparecem quando o servidor reinicia.',
  ]) content.append(el('p', '', message));
  const credit = el('p', 'muted', 'Referência visual: Gmail UI kit, de Kajal Kashyap. ');
  const link = el('a', '', 'Ver template'); link.href = 'https://www.figma.com/community/file/1419898786931603227/gmail-ui-kit'; link.target = '_blank'; link.rel = 'noopener noreferrer'; credit.append(link); content.append(credit);
  showDialog('Como usar o Correio LAN', content, 'help');
}
function showSettings() {
  const content = el('div', 'dialog-copy'); const label = el('label', 'settings-row', 'Som de nova mensagem');
  const check = document.createElement('input'); check.type = 'checkbox'; check.checked = state.sound;
  check.addEventListener('change', () => {
    state.sound = check.checked; sessionStorage.setItem('correio-lan:sound', String(state.sound));
    if (state.sound) { try { audio ??= new AudioContext(); audio.resume().then(playSound).catch(() => {}); } catch { toast('Áudio indisponível neste navegador'); } }
  }); label.append(check); content.append(label, el('p', 'muted', 'As notificações aparecem dentro do aplicativo. O som começa desligado.'));
  showDialog('Configurações', content, 'settings');
}
function showProfile(expiredMessage) {
  const content = el('div', 'dialog-copy');
  content.append(el('p', '', state.user?.name || 'Sua sessão'), el('p', 'muted', state.user?.email || ''));
  if (expiredMessage) content.append(el('p', 'form-error', expiredMessage), el('p', '', 'Os rascunhos de texto continuam salvos nesta aba. Selecione novamente os anexos após entrar.'));
  else content.append(el('p', '', `Sala: ${state.user.room} · ${state.user.role === 'teacher' ? 'Professor' : 'Aluno'}`));
  const button = el('button', 'primary', expiredMessage ? 'Entrar novamente' : 'Sair da sala');
  button.addEventListener('click', () => expiredMessage ? location.assign('/') : perform(leave)); content.append(button);
  showDialog(expiredMessage ? 'Sessão encerrada' : 'Minha sessão', content, 'profile');
}
async function leave() {
  if (sending) { toast('Aguarde o envio terminar'); return; }
  if (state.draft) persistDraft();
  await api('/rooms/leave', { method: 'POST' });
  polling?.stop(); session.clear(); location.assign('/');
}
function activitySummary() {
  const content = $('#activity-summary'); content.replaceChildren(el('h2', '', 'Atividade da sala'));
  if (!state.activity) { content.append(el('p', 'muted', 'Nenhuma atividade publicada.')); return; }
  content.append(el('p', '', state.activity.title), el('p', 'muted', state.activity.closed ? 'Atividade encerrada' : state.activity.delivered ? '✓ Sua entrega foi registrada' : `Assunto: ${state.activity.requiredSubject}`));
  const button = el('button', 'text-button', 'Ver atividade'); button.addEventListener('click', showActivity); content.append(button);
}
function activityContent() {
  const content = el('div', 'activity-details'); const activity = state.activity;
  if (!activity) { content.append(el('p', 'muted', 'Nenhuma atividade publicada.')); return content; }
  content.append(el('h3', '', activity.title), el('p', '', `Enviar para: ${activity.teacherEmail}`), el('p', '', `Assunto: ${activity.requiredSubject}`), el('p', 'activity-instructions', activity.instructions));
  if (activity.closed) content.append(el('p', 'muted', 'Esta atividade foi encerrada.'));
  else if (activity.delivered) content.append(el('p', 'delivered', '✓ Sua entrega foi registrada.'));
  if (!activity.closed && state.user.role === 'student') {
    const button = el('button', 'primary', activity.delivered ? 'Enviar outra resposta' : 'Responder à atividade');
    button.addEventListener('click', () => { closeDialog(); openCompose({ to: [activity.teacherEmail], subject: activity.requiredSubject }); }); content.append(button);
  }
  return content;
}
function showActivity() { showDialog('Atividade da sala', activityContent(), 'activity'); }
function deliveryContent() {
  const content = el('div', 'dialog-copy'); const data = state.teacherStatus;
  if (!data) { content.append(el('p', '', 'Carregando entregas…')); return content; }
  const stats = el('div', 'stat-grid');
  for (const [value, label] of [[data.delivered, 'Entregaram'], [data.pending, 'Pendentes'], [data.total, 'Participantes']]) {
    const stat = el('div', 'stat'); stat.append(el('strong', '', String(value)), el('span', '', label)); stats.append(stat);
  }
  content.append(stats, el('p', '', `${data.onlineStudents} alunos online · ${data.sentCount} mensagens enviadas · ${data.deliveredCount} entregas de mensagens`),
    el('p', 'muted', `Tempo da sala: ${Math.max(0, Math.floor((Date.now() - data.createdAt) / 60000))} minutos`));
  if (!data.activity) content.append(el('p', '', 'Publique uma atividade para acompanhar as entregas.'));
  else {
    content.append(el('p', '', `Atividade: ${data.activity.title}${data.activity.closed ? ' · encerrada' : ''}`));
    const table = el('table', 'delivery-table'); const head = el('thead'); const row = el('tr');
    row.append(el('th', '', 'Aluno'), el('th', '', 'Entrega')); head.append(row); const body = el('tbody');
    for (const item of data.participants) { const tr = el('tr'); const name = el('td', '', item.name); name.append(el('small', 'muted', ` · ${item.email}`));
      tr.append(name, el('td', item.delivered ? 'delivered' : 'pending', item.delivered ? `✓ Entregue · ${shortTime(item.deliveredAt)}` : 'Pendente')); body.append(tr); }
    table.append(head, body); content.append(table);
  }
  return content;
}
function showTeacher() {
  if (state.user.role !== 'teacher') { showActivity(); return; }
  const content = el('div'); const status = el('section'); status.id = 'teacher-status'; status.append(deliveryContent());
  const form = el('form', 'dialog-form'); form.id = 'activity-form';
  for (const [name, label, max, multiline] of [['title', 'Título da atividade', 100], ['requiredSubject', 'Assunto obrigatório', 100], ['instructions', 'Instruções', 10000, true]]) {
    const wrapper = el('label', 'field', label); const input = document.createElement(multiline ? 'textarea' : 'input'); input.name = name; input.maxLength = max; input.required = name !== 'requiredSubject'; wrapper.append(input); form.append(wrapper);
  }
  const button = el('button', 'primary', 'Publicar atividade'); button.type = 'submit'; form.append(button);
  form.addEventListener('submit', event => {
    event.preventDefault(); perform(async () => {
      button.disabled = true;
      try {
        await api('/activities', { method: 'POST', body: { title: form.elements.title.value, requiredSubject: form.elements.requiredSubject.value, instructions: form.elements.instructions.value } });
        form.reset(); await refreshActivity(); toast('Atividade publicada para a turma');
      } finally { button.disabled = false; }
    });
  });
  content.append(status, el('hr'), el('h2', '', 'Publicar nova atividade'), el('p', 'muted dialog-copy', 'Uma nova publicação encerra a atividade anterior.'), form);
  showDialog('Painel do professor', content, 'teacher'); polling.trigger('activities');
}
async function refreshActivity(signal) {
  const data = await api('/activities/current', { signal });
  const previous = JSON.stringify(state.activity); state.activity = data; activitySummary();
  if (state.user.role === 'teacher') state.teacherStatus = await api('/activities/status', { signal });
  if (state.dialogMode === 'teacher' && $('#teacher-status')) $('#teacher-status').replaceChildren(deliveryContent());
  if (state.dialogMode === 'activity' && previous !== JSON.stringify(data)) $('#dialog-content').replaceChildren(activityContent());
}
function showMessageActions() {
  const content = el('div', 'dialog-copy');
  for (const [action, label] of [['reply', 'Responder'], ['reply-all', 'Responder a todos'], ['forward', 'Encaminhar'], ['restore', 'Restaurar'], ['delete', 'Excluir definitivamente']]) {
    if (['restore', 'delete'].includes(action) && !state.message.trash) continue;
    const button = el('button', 'reply-menu-button', label); button.addEventListener('click', () => { closeDialog(); perform(() => readerAction(action)); }); content.append(button);
  }
  showDialog('Ações da mensagem', content, 'message-actions');
}
function insertText(value) {
  const input = $('#compose-body'); input.setRangeText(value, input.selectionStart, input.selectionEnd, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
}
function showInsertLink() {
  const form = el('form', 'dialog-form'); const label = el('label', 'field', 'Endereço do link');
  const input = document.createElement('input'); input.type = 'url'; input.required = true; input.placeholder = 'https://'; input.maxLength = 500; label.append(input);
  const button = el('button', 'primary', 'Inserir link'); button.type = 'submit'; form.append(label, button);
  form.addEventListener('submit', event => { event.preventDefault(); closeDialog(); insertText(input.value); }); showDialog('Inserir link como texto', form);
}

$('#compose-button').addEventListener('click', () => openCompose());
for (const button of document.querySelectorAll('[data-folder]')) button.addEventListener('click', () => perform(() => changeFolder(button.dataset.folder)));
for (const button of document.querySelectorAll('[data-reader-action]')) button.addEventListener('click', () => perform(() => readerAction(button.dataset.readerAction)));
for (const button of document.querySelectorAll('[data-smart-reply]')) button.addEventListener('click', () => openCompose({ ...replyMessage(state.message, state.user.email), body: button.dataset.smartReply }));
$('#refresh-button').addEventListener('click', () => perform(() => loadFolder()));
$('#previous-page').addEventListener('click', () => { state.offset = Math.max(0, state.offset - 50); perform(() => loadFolder()); });
$('#next-page').addEventListener('click', () => { state.offset += 50; perform(() => loadFolder()); });
$('#select-all').addEventListener('change', event => { state.selected = event.target.checked ? new Set(state.rows.keys()) : new Set(); renderList(); });
$('#bulk-trash').addEventListener('click', () => perform(async () => {
  const removingDrafts = state.folder === 'drafts';
  if (removingDrafts && !window.confirm('Descartar os rascunhos selecionados?')) return;
  $('#bulk-trash').disabled = true;
  const ids = [...state.selected];
  for (const id of ids) { if (removingDrafts) drafts.remove(id); else await api(`/messages/${state.rows.get(id).id}/thread/trash`, { method: 'PATCH', body: {} }); }
  state.selected.clear(); await loadFolder(); toast(removingDrafts ? 'Rascunhos descartados' : 'Seleção movida para a lixeira');
}));
$('#search-form').addEventListener('submit', event => { event.preventDefault(); clearTimeout(searchTimer); state.query = $('#search-input').value.trim(); showList(); perform(() => loadFolder({ reset: true })); });
$('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => $('#search-form').requestSubmit(), 400); });
$('#menu-button').addEventListener('click', () => {
  const mobile = matchMedia('(max-width:600px)').matches;
  document.body.classList.toggle(mobile ? 'mobile-nav-open' : 'nav-collapsed');
  $('#menu-button').setAttribute('aria-expanded', String(mobile ? document.body.classList.contains('mobile-nav-open') : !document.body.classList.contains('nav-collapsed')));
});
$('#help-button').addEventListener('click', showHelp); $('#settings-button').addEventListener('click', showSettings);
$('#profile-button').addEventListener('click', () => showProfile()); $('#leave-button').addEventListener('click', () => perform(leave));
$('#activity-button').addEventListener('click', () => state.user.role === 'teacher' ? showTeacher() : showActivity());
for (const button of document.querySelectorAll('[data-panel]')) button.addEventListener('click', () => {
  const panel = button.dataset.panel;
  if (panel === 'compose') openCompose(); else if (panel === 'activity') showActivity(); else if (panel === 'teacher') showTeacher();
  else if (panel === 'drafts') perform(() => changeFolder('drafts'));
  else { const content = el('div'); displayPeople(content); showDialog('Pessoas na sala', content, 'people'); }
});
$('#toggle-cc').addEventListener('click', () => { $('#cc-line').hidden = !$('#cc-line').hidden; if (!$('#cc-line').hidden) $('#compose-cc').focus(); });
$('#toggle-bcc').addEventListener('click', () => { $('#bcc-line').hidden = !$('#bcc-line').hidden; if (!$('#bcc-line').hidden) $('#compose-bcc').focus(); });
$('#close-compose').addEventListener('click', () => closeCompose()); $('#cancel-compose').addEventListener('click', () => closeCompose());
$('#discard-compose').addEventListener('click', () => { if (window.confirm('Descartar este rascunho e seus anexos?')) closeCompose({ discard: true }); });
$('#minimize-compose').addEventListener('click', () => $('#composer').classList.toggle('minimized'));
$('#expand-compose').addEventListener('click', () => { $('#composer').classList.toggle('expanded'); $('#composer').classList.remove('minimized'); });
$('#save-draft').addEventListener('click', () => { try { persistDraft(); toast('Rascunho salvo'); } catch { toast('Não foi possível salvar o rascunho', 'O navegador está sem espaço.', { error: true }); } });
$('#attach-button').addEventListener('click', () => pickFiles()); $('#document-button').addEventListener('click', () => pickFiles('.pdf,.txt,.docx'));
$('#image-button').addEventListener('click', () => pickFiles('.png,.jpg,.jpeg')); $('#emoji-button').addEventListener('click', () => insertText('🙂'));
$('#signature-button').addEventListener('click', () => insertText(`\n\n${state.user.name}\n${state.user.email}`));
$('#link-button').addEventListener('click', showInsertLink);
$('#format-button').addEventListener('click', () => toast('Mensagem em texto', 'Use parágrafos e quebras de linha para organizar sua mensagem.'));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#utility-dialog').open && !$('#composer').hidden) { event.preventDefault(); closeCompose(); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !$('#composer').hidden && !$('#utility-dialog').open) { event.preventDefault(); $('#compose-form').requestSubmit(); }
});
document.addEventListener('session-expired', event => {
  if (state.expired) return;
  state.expired = true; polling?.stop(); bootPolling.stop(); safePersistDraft(); session.clear();
  $('#loading').hidden = true; showProfile(event.detail);
});
window.addEventListener('pagehide', () => { safePersistDraft(); polling?.stop(); bootPolling.stop(); });
window.addEventListener('pageshow', () => {
  if (state.expired) return;
  if (state.user) polling?.start(); else bootPolling.start();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const name of ['heartbeat', 'users', 'messages', 'activities']) polling?.trigger(name); });

async function bootstrap(signal) {
  if (booting || state.user || state.expired) return;
  if (!session.get()) { location.replace('/'); return; }
  booting = true;
  try {
    const data = await api('/rooms/current', { signal });
    state.config = data.config;
    state.user = data.user;
    session.set({ ...session.get(), ...data });
    drafts = new DraftStore(state.user.email);
    await api('/presence/heartbeat', { method: 'POST', signal });
    await refreshPeople(signal); await loadFolder(); await refreshActivity(signal);
    $('#loading').hidden = true; $('#mail-list-view').hidden = false;
    polling = new PollingManager({
      onSuccess: name => { state.failures.delete(name); connection(); },
      onError: (name, error) => { if (!state.expired) { state.failures.add(name); connection(); } },
    });
    polling.add('heartbeat', state.config.heartbeatInterval, signal => api('/presence/heartbeat', { method: 'POST', signal }))
      .add('users', state.config.pollUsersInterval, refreshPeople)
      .add('messages', state.config.pollMessagesInterval, syncMessages)
      .add('activities', state.config.pollActivitiesInterval, refreshActivity);
    bootPolling.stop(); state.failures.clear(); connection(); polling.start();
  } catch (error) {
    if (!state.expired && !signal?.aborted) {
      state.user = null;
      $('#loading p').textContent = `${error.message} Tentando reconectar…`;
      state.failures.add('bootstrap'); connection(); throw error;
    }
  } finally { booting = false; }
}
const bootPolling = new PollingManager();
bootPolling.add('bootstrap', 3000, bootstrap);
bootPolling.start();
