import { randomUUID, createHash } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { text, integer } from '../utils/validation.js';

export class MessageService {
  constructor(store, config, { roomService, attachments = null } = {}) {
    this.store = store; this.config = config; this.roomService = roomService; this.attachments = attachments;
  }
  get(user, id) {
    const message = this.store.rooms.get(user.room)?.messages.get(id);
    if (!message || !message.copies.has(user.id)) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Mensagem não encontrada.');
    return message;
  }
  projection(user, message, full = false) {
    const copy = message.copies.get(user.id);
    // CCO nunca é serializado: nem para destinatários, remetente, listagens ou sincronização.
    return {
      id: message.id, from: message.from, fromName: message.fromName, to: message.to, cc: message.cc,
      subject: message.subject, preview: message.body.replace(/\s+/g, ' ').slice(0, 140),
      ...(full ? { body: message.body } : {}), timestamp: message.timestamp,
      attachments: message.attachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })),
      receivedAsBcc: copy.receivedAsBcc, read: copy.read, starred: copy.starred, trash: copy.trash,
      inbox: copy.inbox, sent: copy.sent, location: copy.location, snoozedUntil: copy.snoozedUntil,
    };
  }
  validateRecipients(user, input) {
    const result = {};
    let count = 0;
    const seen = new Set();
    const room = this.store.rooms.get(user.room);
    for (const field of ['to', 'cc', 'bcc']) {
      const values = input[field] ?? [];
      if (!Array.isArray(values)) throw new AppError(400, 'INVALID_RECIPIENTS', 'Destinatários devem ser uma lista de endereços.');
      count += values.length;
      if (count > this.config.maxRecipients) throw new AppError(400, 'RECIPIENT_LIMIT', `Use no máximo ${this.config.maxRecipients} destinatários.`);
      result[field] = [];
      for (const value of values) {
        if (typeof value !== 'string' || value.length > 80) throw new AppError(400, 'INVALID_RECIPIENTS', 'Endereço de destinatário inválido.');
        const email = value.trim().toLowerCase();
        const [username, domain, extra] = email.split('@');
        const recipient = room.users.get(room.usernames.get(username));
        if (extra || domain !== `${room.key}.local` || !recipient || this.store.now() - recipient.lastSeen >= this.config.sessionTimeout) {
          throw new AppError(400, 'RECIPIENT_NOT_FOUND', 'Um dos destinatários não está disponível nesta sala. Atualize a lista e confira os endereços.');
        }
        if (!seen.has(email)) { result[field].push(email); seen.add(email); }
      }
    }
    if (!seen.size) throw new AppError(400, 'RECIPIENT_REQUIRED', 'Informe pelo menos um destinatário.');
    return result;
  }
  async send(user, input, files = [], key) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'INVALID_REQUEST', 'Mensagem inválida.');
    this.roomService.authenticate(user.token);
    const subject = text(input.subject, 'Assunto', 100);
    const body = text(input.body ?? '', 'Mensagem', this.config.maxMessageLength, { required: false, multiline: true });
    const recipients = this.validateRecipients(user, input);
    const forwarded = input.forwardedAttachmentIds ?? [];
    if (!Array.isArray(forwarded) || forwarded.length + files.length > this.config.maxAttachments) throw new AppError(413, 'ATTACHMENT_LIMIT', 'Quantidade de anexos acima do limite.');
    if (key && !/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Identificador de envio inválido.');
    const fingerprint = createHash('sha256').update(JSON.stringify({ subject, body, recipients, forwarded, source: input.forwardMessageId,
      files: files.map(file => [file.originalname, createHash('sha256').update(file.buffer).digest('hex')]) })).digest('hex');
    if (key && user.idempotency.has(key)) {
      const previous = user.idempotency.get(key);
      if (previous.fingerprint !== fingerprint) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Este identificador de envio já foi usado para outra mensagem.');
      return previous.promise;
    }
    const promise = this.deliver(user, { subject, body, ...recipients }, input, files);
    if (key) {
      user.idempotency.set(key, { fingerprint, promise });
      // Limite alinhado à capacidade da sala; não cresce sem controle.
      if (user.idempotency.size > this.config.maxMessagesPerRoom) user.idempotency.delete(user.idempotency.keys().next().value);
    }
    try { return await promise; } catch (error) { if (key) user.idempotency.delete(key); throw error; }
  }
  async deliver(user, data, input, files) {
    let saved = [];
    const forwarded = input.forwardedAttachmentIds ?? [];
    const existingAttachments = [];
    if (forwarded.length) {
      const original = this.get(user, input.forwardMessageId);
      for (const id of new Set(forwarded)) {
        const attachment = original.attachments.find(item => item.id === id);
        if (!attachment) throw new AppError(404, 'ATTACHMENT_NOT_FOUND', 'Anexo não encontrado.');
        existingAttachments.push(attachment);
      }
    }
    try {
      if (files.length) saved = await this.attachments.persist(files, user.room);
      this.roomService.authenticate(user.token);
      // Revalidar após operações assíncronas: um destinatário pode ter saído durante o upload.
      this.validateRecipients(user, data);
      const room = this.store.rooms.get(user.room);
      if (room.messages.size >= this.config.maxMessagesPerRoom) throw new AppError(429, 'MESSAGE_LIMIT', 'A sala atingiu o limite de mensagens temporárias.');
      const message = {
        id: randomUUID(), from: user.email, fromName: user.name, ...data, timestamp: this.store.now(),
        attachments: [...existingAttachments, ...saved], copies: new Map(),
      };
      const addCopy = (participant, inbox, bcc = false) => {
        let copy = message.copies.get(participant.id);
        if (!copy) {
          copy = { read: !inbox, starred: false, trash: false, inbox, sent: !inbox,
            receivedAsBcc: bcc, location: 'inbox', snoozedUntil: null };
          message.copies.set(participant.id, copy);
          participant.mailbox.set(message.id, copy);
        } else { copy.inbox ||= inbox; copy.sent ||= !inbox; copy.receivedAsBcc ||= bcc; if (inbox) copy.read = false; }
      };
      addCopy(user, false);
      for (const field of ['to', 'cc', 'bcc']) for (const email of data[field]) {
        const participant = room.users.get(room.usernames.get(email.split('@')[0]));
        addCopy(participant, true, field === 'bcc');
      }
      room.messages.set(message.id, message);
      room.sentCount += 1;
      room.deliveredCount += data.to.length + data.cc.length + data.bcc.length;
      for (const id of message.copies.keys()) this.store.recordChange(room.users.get(id), message.id, 'created');
      const activity = room.activities.get(room.currentActivityId);
      if (activity && !activity.closed && user.role === 'student'
        && message.copies.has(activity.teacherId)
        && data.subject.trim().toLocaleLowerCase('pt-BR') === activity.requiredSubject.trim().toLocaleLowerCase('pt-BR')) {
        const participant = activity.participants.get(user.id);
        if (participant) { participant.delivered = true; participant.deliveredAt = message.timestamp; }
      }
      return this.projection(user, message, true);
    } catch (error) { if (saved.length) await this.attachments.discard(saved); throw error; }
  }
  update(user, id, patch) {
    const message = this.get(user, id);
    const copy = message.copies.get(user.id);
    Object.assign(copy, patch);
    this.store.recordChange(user, id, 'updated');
    return this.projection(user, message, true);
  }
  remove(user, id) {
    const message = this.get(user, id);
    if (!message.copies.get(user.id).trash) throw new AppError(409, 'TRASH_REQUIRED', 'Mova a mensagem para a lixeira antes de excluir definitivamente.');
    message.copies.delete(user.id);
    user.mailbox.delete(id);
    this.store.recordChange(user, id, 'deleted');
    if (!message.copies.size) this.store.rooms.get(user.room).messages.delete(id);
    return { deleted: true, id };
  }
  matches(copy, folder) {
    if (folder === 'trash') return copy.trash;
    if (copy.trash) return false;
    if (folder === 'sent') return copy.sent;
    if (folder === 'starred') return copy.starred;
    return copy.inbox && copy.location === folder;
  }
  totals(user) {
    const totals = { inbox: 0, sent: 0, trash: 0, starred: 0, archive: 0, spam: 0, snoozed: 0, unread: 0 };
    for (const copy of user.mailbox.values()) {
      for (const folder of Object.keys(totals).filter(item => item !== 'unread')) if (this.matches(copy, folder)) totals[folder]++;
      if (this.matches(copy, 'inbox') && !copy.read) totals.unread++;
    }
    return totals;
  }
  list(user, folder, query = {}) {
    const offset = integer(query.offset, 0, this.config.maxMessagesPerRoom);
    const limit = integer(query.limit, 50, 50);
    if (!limit) throw new AppError(400, 'INVALID_LIMIT', 'O limite deve ser maior que zero.');
    const search = query.q === undefined ? '' : text(query.q, 'Busca', 100, { required: false }).toLocaleLowerCase('pt-BR');
    const room = this.store.rooms.get(user.room);
    const all = [...user.mailbox.keys()].reverse().map(id => room.messages.get(id)).filter(message => message
      && this.matches(message.copies.get(user.id), folder)
      && (!search || [message.subject, message.body, message.fromName, message.from, ...message.to, ...message.cc].some(value => value.toLocaleLowerCase('pt-BR').includes(search))));
    return { messages: all.slice(offset, offset + limit).map(message => this.projection(user, message)),
      total: all.length, offset, limit, hasMore: offset + limit < all.length, cursor: user.revision, totals: this.totals(user) };
  }
  sync(user, cursorValue) {
    const cursor = integer(cursorValue, 0, Number.MAX_SAFE_INTEGER);
    const earliest = user.changes[0]?.revision ?? user.revision + 1;
    if (cursor > user.revision || cursor < earliest - 1) return { reset: true, cursor: user.revision, events: [], totals: this.totals(user) };
    const room = this.store.rooms.get(user.room);
    const events = user.changes.filter(event => event.revision > cursor).map(event => {
      const message = room.messages.get(event.messageId);
      return { ...event, message: message?.copies.has(user.id) ? this.projection(user, message) : null };
    });
    return { reset: false, cursor: user.revision, events, totals: this.totals(user) };
  }
  wakeSnoozed() {
    for (const user of this.store.sessions.values()) for (const [id, copy] of user.mailbox) {
      if (copy.snoozedUntil !== null && copy.snoozedUntil <= this.store.now()) this.update(user, id, { location: 'inbox', snoozedUntil: null });
    }
  }
}
