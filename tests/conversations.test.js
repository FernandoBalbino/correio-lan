import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { once } from 'node:events';

async function setup(t) {
  let clock = 1000;
  const application = await createApplication({ config: createConfig({ MESSAGE_RATE_LIMIT: '100' }), now: () => ++clock });
  t.after(() => application.close());
  const { roomService: rooms, messageService: mail } = application;
  const users = ['ana', 'bruno', 'carla', 'oculto'].map(username => rooms.join({ name: username, username, room: 'CONVERSA' }));
  return { ...application, rooms, mail, users };
}

test('conversa agrupa respostas, preserva a ordem e não mistura assuntos iguais', async t => {
  const { mail, users: [ana, bruno] } = await setup(t);
  const first = await mail.send(ana, { to: [bruno.email], subject: 'Atividade', body: 'Pergunta inicial' });
  const reply = await mail.send(bruno, { to: [ana.email], subject: 'Re: Atividade', body: 'Primeira resposta', inReplyTo: first.id });
  const third = await mail.send(ana, { to: [bruno.email], subject: 'Re: Atividade', body: 'Segunda resposta', inReplyTo: reply.id });
  assert.equal(third.threadId, first.id);
  assert.deepEqual(mail.conversation(ana, third.id).messages.map(message => message.body), ['Pergunta inicial', 'Primeira resposta', 'Segunda resposta']);
  assert.equal(mail.conversation(bruno, first.id).subject, 'Atividade');
  const inbox = mail.list(ana, 'inbox', { view: 'threads' });
  assert.equal(inbox.total, 1); assert.equal(inbox.messages[0].threadCount, 3);
  assert.equal(inbox.messages[0].preview, 'Segunda resposta');
  assert.equal(inbox.totals.inbox, 1); assert.equal(inbox.totals.sent, 1);
  assert.equal(inbox.totals.unread, 1);
  await mail.send(ana, { to: [bruno.email], subject: 'Atividade', body: 'Outra conversa' });
  assert.equal(mail.list(bruno, 'inbox', { view: 'threads' }).total, 2);
  assert.equal(mail.list(bruno, 'inbox', { view: 'threads', q: 'Primeira resposta' }).total, 1);
});

test('histórico autoriza cada cópia, protege CCO e recusa vincular mensagens privadas', async t => {
  const { mail, rooms, users: [ana, bruno, carla, oculto] } = await setup(t);
  const first = await mail.send(ana, { to: [bruno.email], bcc: [oculto.email], subject: 'Privada', body: 'Histórico reservado' });
  const reply = await mail.send(bruno, { to: [ana.email, carla.email], subject: 'Re: Privada', body: 'Nova participante', inReplyTo: first.id });
  const carlaThread = mail.conversation(carla, reply.id);
  assert.equal(carlaThread.messages.length, 1);
  assert.equal(carlaThread.messages[0].body, 'Nova participante');
  assert.equal(JSON.stringify(carlaThread).includes('Histórico reservado'), false);
  assert.throws(() => mail.conversation(carla, first.id), { code: 'MESSAGE_NOT_FOUND' });
  await assert.rejects(mail.send(carla, { to: [ana.email], subject: 'X', inReplyTo: first.id }), { code: 'MESSAGE_NOT_FOUND' });
  const outsider = rooms.join({ name: 'Outra sala', username: 'ana', room: 'OUTRA' });
  assert.throws(() => mail.conversation(outsider, first.id), { code: 'MESSAGE_NOT_FOUND' });
  assert.equal(mail.conversation(oculto, first.id).messages.length, 1);
  for (const user of [ana, bruno, carla]) {
    const serialized = JSON.stringify(mail.conversation(user, reply.id));
    assert.equal(serialized.includes(oculto.email), false); assert.equal(serialized.includes('"bcc"'), false);
  }
  const carlaReply = await mail.send(carla, { to: [bruno.email], subject: 'Re: Privada', body: 'Resposta nova', inReplyTo: reply.id });
  assert.equal(carlaReply.threadId, first.id);
  assert.equal(mail.conversation(carla, carlaReply.id).messages.length, 2);
});

test('leitura, lixeira e exclusão de conversa afetam somente a própria sessão', async t => {
  const { mail, users: [ana, bruno] } = await setup(t);
  const first = await mail.send(ana, { to: [bruno.email], subject: 'Conversa' });
  const reply = await mail.send(bruno, { to: [ana.email], subject: 'Re: Conversa', inReplyTo: first.id });
  mail.updateConversation(ana, reply.id, { read: true });
  assert.equal(mail.conversationTotals(ana).unread, 0);
  assert.equal(mail.conversationTotals(bruno).unread, 1);
  assert.throws(() => mail.removeConversation(ana, reply.id), { code: 'TRASH_REQUIRED' });
  mail.update(ana, first.id, { trash: true });
  assert.throws(() => mail.removeConversation(ana, reply.id), { code: 'TRASH_REQUIRED' });
  assert.equal(mail.conversation(ana, reply.id).messages.length, 2);
  mail.updateConversation(ana, reply.id, { trash: true });
  assert.equal(mail.list(ana, 'trash', { view: 'threads' }).total, 1);
  mail.updateConversation(ana, reply.id, { trash: false });
  assert.equal(mail.list(ana, 'inbox', { view: 'threads' }).total, 1);
  mail.updateConversation(ana, reply.id, { trash: true });
  mail.removeConversation(ana, reply.id);
  assert.equal(mail.list(ana, 'trash', { view: 'threads' }).total, 0);
  assert.equal(mail.conversation(bruno, reply.id).messages.length, 2);
});

test('respostas participam da idempotência e rejeitam referência inválida', async t => {
  const { mail, users: [ana, bruno] } = await setup(t);
  const first = await mail.send(ana, { to: [bruno.email], subject: 'Conversa' });
  const other = await mail.send(ana, { to: [bruno.email], subject: 'Outra' });
  const input = { to: [ana.email], subject: 'Re: Conversa', body: 'Resposta', inReplyTo: first.id };
  const [a, b] = await Promise.all([mail.send(bruno, input, [], 'reply-idempotency-01'), mail.send(bruno, input, [], 'reply-idempotency-01')]);
  assert.equal(a.id, b.id); assert.equal(mail.conversation(bruno, first.id).messages.length, 2);
  await assert.rejects(mail.send(bruno, { ...input, inReplyTo: other.id }, [], 'reply-idempotency-01'), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(mail.send(bruno, { ...input, inReplyTo: 'inválido' }), { code: 'INVALID_REPLY' });
});

test('HTTP: listar, abrir, marcar e excluir conversas com autenticação', async t => {
  const { app, rooms } = await setup(t);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const [ana, bruno] = ['httpana', 'httpbruno'].map(username => rooms.join({ username, name: username, room: 'HTTP' }));
  async function request(user, path, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${user.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, ...await response.json() };
  }
  const first = (await request(ana, '/messages', 'POST', { to: [bruno.email], subject: 'HTTP', body: 'Primeira' })).data;
  await request(bruno, '/messages', 'POST', { to: [ana.email], subject: 'Re: HTTP', body: 'Resposta', inReplyTo: first.id });
  const thread = await request(ana, `/messages/${first.id}/thread`);
  assert.equal(thread.status, 200); assert.equal(thread.data.messages.length, 2);
  const list = await request(ana, '/messages/inbox?view=threads');
  assert.equal(list.data.total, 1); assert.equal(list.data.messages[0].threadCount, 2);
  await request(ana, `/messages/${first.id}/thread/read`, 'PATCH', { read: true });
  assert.equal((await request(ana, '/messages/sync?cursor=0&view=threads')).data.totals.unread, 0);
  await request(ana, `/messages/${first.id}/thread/trash`, 'PATCH', {});
  assert.equal((await request(ana, `/messages/${first.id}/thread`, 'DELETE')).status, 200);
  assert.equal((await request(bruno, `/messages/${first.id}/thread`)).data.messages.length, 2);
});

test('paginação limita conversas completas e uma resposta move a conversa para o topo', async t => {
  const { mail, users: [ana, bruno] } = await setup(t);
  const roots = [];
  for (let index = 0; index < 52; index++) {
    const first = await mail.send(ana, { to: [bruno.email], subject: `Conversa ${index}` }); roots.push(first);
    await mail.send(bruno, { to: [ana.email], subject: `Re: Conversa ${index}`, inReplyTo: first.id });
  }
  const page = mail.list(ana, 'inbox', { view: 'threads' });
  assert.equal(page.messages.length, 50); assert.equal(page.total, 52); assert.equal(page.hasMore, true);
  assert.equal(mail.list(ana, 'inbox', { view: 'threads', offset: 50 }).messages.length, 2);
  assert.ok(page.messages.every(message => message.threadCount === 2));
  const newest = await mail.send(bruno, { to: [ana.email], subject: 'Re: Conversa 0', body: 'Nova resposta', inReplyTo: roots[0].id });
  const updated = mail.list(ana, 'inbox', { view: 'threads' });
  assert.equal(updated.messages[0].id, newest.id); assert.equal(updated.messages[0].threadCount, 3); assert.equal(updated.total, 52);
});
