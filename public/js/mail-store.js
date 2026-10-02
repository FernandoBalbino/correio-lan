export function parseRecipients(value) { return [...new Set(value.split(/[;,\n]/).map(item => item.trim().toLowerCase()).filter(Boolean))]; }
export function replyMessage(message, currentEmail, all = false) {
  const to = [...new Set(message.from === currentEmail ? message.to : [message.from, ...(all ? message.to : [])])].filter(email => email !== currentEmail);
  const cc = all ? [...new Set(message.cc)].filter(email => email !== currentEmail && !to.includes(email)) : [];
  return { to, cc, bcc: [], subject: `Re: ${message.subject.replace(/^(?:re:\s*)+/i, '')}`, body: '', inReplyTo: message.id };
}
export function forwardMessage(message) {
  return {
    to: [], cc: [], bcc: [], subject: `Enc: ${message.subject.replace(/^(?:enc:\s*)+/i, '')}`,
    body: `\n\n---------- Mensagem encaminhada ----------\nDe: ${message.fromName}\nE-mail: ${message.from}\nData: ${new Date(message.timestamp).toLocaleString('pt-BR')}\nAssunto: ${message.subject}\nPara: ${message.to.join(', ')}${message.cc.length ? '\nCc: ' + message.cc.join(', ') : ''}\n\n${message.body}`,
    forwardMessageId: message.id, forwardedAttachments: message.attachments,
  };
}
export class DraftStore {
  constructor(email) { this.key = `correio-lan:drafts:${email}`; }
  list() { try { const value = JSON.parse(sessionStorage.getItem(this.key) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
  save(draft) {
    const list = this.list().filter(item => item.id !== draft.id);
    list.unshift({ ...draft, updatedAt: Date.now() });
    sessionStorage.setItem(this.key, JSON.stringify(list.slice(0, 50)));
  }
  remove(id) { sessionStorage.setItem(this.key, JSON.stringify(this.list().filter(item => item.id !== id))); }
}
