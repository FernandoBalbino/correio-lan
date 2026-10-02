import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import { MemoryStore } from '../src/repositories/memory-store.js';
import { RoomService } from '../src/services/room-service.js';
import { MessageService } from '../src/services/message-service.js';

function setup() {
  const config = createConfig({});
  const store = new MemoryStore({ config });
  const rooms = new RoomService(store, config);
  const service = new MessageService(store, config, { roomService: rooms });
  const users = ['fernando', 'maria', 'joao', 'pedro'].map(username => rooms.join({ name: username, username, room: 'TESTE' }));
  return { store, rooms, service, users };
}
test('envio, CC e CCO seguro em detalhe, lista, enviados e sync', async () => {
  const { service, users: [sender, to, cc, bcc] } = setup();
  const sent = await service.send(sender, { to: [to.email], cc: [cc.email], bcc: [bcc.email], subject: 'Atividade', body: '<script>alert(1)</script>' });
  assert.equal(service.list(to, 'inbox').total, 1);
  assert.equal(service.list(cc, 'inbox').total, 1);
  assert.equal(service.list(bcc, 'inbox').total, 1);
  for (const user of [sender, to, cc, bcc]) {
    const detail = service.projection(user, service.get(user, sent.id), true);
    assert.equal(Object.hasOwn(detail, 'bcc'), false);
    assert.equal(detail.receivedAsBcc, user.id === bcc.id);
    assert.equal(detail.body, '<script>alert(1)</script>');
    assert.equal(JSON.stringify(service.sync(user, 0)).includes(bcc.email), false);
  }
  assert.equal(service.list(sender, 'sent').total, 1);
});
test('estado individual, lixeira, restauração, exclusão e eventos', async () => {
  const { service, users: [sender, maria, joao] } = setup();
  const sent = await service.send(sender, { to: [maria.email, joao.email], subject: 'Teste', body: 'Olá' });
  service.update(maria, sent.id, { read: true, starred: true, trash: true });
  assert.equal(service.list(maria, 'inbox').total, 0);
  assert.equal(service.list(maria, 'trash').total, 1);
  assert.equal(service.list(joao, 'inbox').messages[0].read, false);
  service.update(maria, sent.id, { trash: false });
  assert.equal(service.list(maria, 'starred').total, 1);
  assert.throws(() => service.remove(maria, sent.id), { code: 'TRASH_REQUIRED' });
  service.update(maria, sent.id, { trash: true });
  service.remove(maria, sent.id);
  assert.throws(() => service.get(maria, sent.id), { code: 'MESSAGE_NOT_FOUND' });
  assert.equal(service.list(joao, 'inbox').total, 1);
  assert.equal(service.sync(maria, 0).events.at(-1).kind, 'deleted');
});
test('isolamento por sala e sessão; destinatários e limites', async () => {
  const { service, rooms, users: [sender, recipient] } = setup();
  const outsider = rooms.join({ name: 'Outra sala', username: 'maria', room: 'OUTRA' });
  const sent = await service.send(sender, { to: [recipient.email], subject: 'Privada', body: 'Texto' });
  assert.throws(() => service.get(outsider, sent.id), { code: 'MESSAGE_NOT_FOUND' });
  await assert.rejects(service.send(sender, { to: [outsider.email], subject: 'X' }), { code: 'RECIPIENT_NOT_FOUND' });
  await assert.rejects(service.send(sender, { to: [recipient.email], subject: 'a'.repeat(101) }), { code: 'INVALID_FIELD' });
  await assert.rejects(service.send(sender, { to: [recipient.email], subject: 'X', body: 'a'.repeat(10001) }), { code: 'INVALID_FIELD' });
  await assert.rejects(service.send(sender, { to: Array(31).fill(recipient.email), subject: 'X' }), { code: 'RECIPIENT_LIMIT' });
});
test('idempotência protege envio repetido concorrente', async () => {
  const { service, users: [sender, recipient] } = setup();
  const input = { to: [recipient.email], subject: 'Uma vez', body: 'Texto' };
  const [a, b] = await Promise.all([service.send(sender, input, [], '1234567890123456'), service.send(sender, input, [], '1234567890123456')]);
  assert.equal(a.id, b.id);
  assert.equal(service.list(recipient, 'inbox').total, 1);
  await assert.rejects(service.send(sender, { ...input, body: 'Outra' }, [], '1234567890123456'), { code: 'IDEMPOTENCY_CONFLICT' });
});
test('paginação e cursor incremental não repetem histórico', async () => {
  const { service, users: [sender, recipient] } = setup();
  for (let i = 0; i < 55; i++) await service.send(sender, { to: [recipient.email], subject: `Mensagem ${i}`, body: 'Texto' });
  const page = service.list(recipient, 'inbox');
  assert.equal(page.messages.length, 50); assert.equal(page.hasMore, true);
  assert.equal(service.list(recipient, 'inbox', { offset: 50 }).messages.length, 5);
  assert.equal(service.sync(recipient, page.cursor).events.length, 0);
  await service.send(sender, { to: [recipient.email], subject: 'Nova' });
  assert.equal(service.sync(recipient, page.cursor).events.length, 1);
});
