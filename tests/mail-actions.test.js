import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipients, replyMessage, forwardMessage, DraftStore } from '../public/js/mail-store.js';
import { PollingManager } from '../public/js/polling.js';

const message = { id: '1', from: 'joao@teste.local', fromName: 'João', to: ['maria@teste.local', 'fernando@teste.local'], cc: ['pedro@teste.local', 'maria@teste.local'], subject: 'Re: Re: Atividade', body: 'Texto', timestamp: 123456789, attachments: [{ id: 'file', name: 'teste.txt' }] };
test('responder normaliza prefixo e responder a todos só usa destinatários visíveis', () => {
  const reply = replyMessage(message, 'maria@teste.local');
  assert.deepEqual(reply.to, ['joao@teste.local']); assert.equal(reply.subject, 'Re: Atividade');
  const all = replyMessage(message, 'maria@teste.local', true);
  assert.deepEqual(all.to, ['joao@teste.local', 'fernando@teste.local']);
  assert.deepEqual(all.cc, ['pedro@teste.local']); assert.deepEqual(all.bcc, []);
  const hiddenRecipient = replyMessage(message, 'oculto@teste.local', true);
  assert.equal(hiddenRecipient.to.includes('oculto@teste.local'), false);
});
test('encaminhar preserva texto, metadados públicos e referências autorizadas de anexos', () => {
  const forward = forwardMessage(message);
  assert.equal(forward.subject, 'Enc: Re: Re: Atividade');
  assert.match(forward.body, /Mensagem encaminhada/); assert.match(forward.body, /joao@teste.local/);
  assert.equal(forward.forwardMessageId, '1'); assert.deepEqual(forward.forwardedAttachments, message.attachments);
  assert.deepEqual(forward.to, []); assert.deepEqual(parseRecipients('a@t.local; B@t.local, a@t.local'), ['a@t.local', 'b@t.local']);
});
test('rascunhos sobrevivem recarregamento e ficam separados por endereço', () => {
  const data = new Map();
  globalThis.sessionStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const store = new DraftStore('maria@teste.local');
  store.save({ id: 'draft', subject: 'Atividade', body: 'Meu texto', savedFileNames: ['exercicio.pdf'] });
  assert.equal(new DraftStore('maria@teste.local').list()[0].body, 'Meu texto');
  assert.equal(new DraftStore('joao@teste.local').list().length, 0);
  store.remove('draft'); assert.equal(store.list().length, 0);
});
test('PollingManager evita sobreposição, interrompe timers e pode reiniciar', async () => {
  let concurrent = 0; let maximum = 0; let calls = 0;
  const manager = new PollingManager();
  manager.add('slow', 5, async signal => {
    calls++; concurrent++; maximum = Math.max(maximum, concurrent);
    await new Promise(resolve => setTimeout(resolve, 20)); concurrent--;
  });
  manager.start(); manager.start(); manager.trigger('slow');
  await new Promise(resolve => setTimeout(resolve, 50)); manager.stop();
  const stoppedCalls = calls;
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(calls, stoppedCalls); assert.equal(maximum, 1);
  manager.start(); await new Promise(resolve => setTimeout(resolve, 40)); manager.stop();
  assert.ok(calls > stoppedCalls);
});
