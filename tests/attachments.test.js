import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateAttachment } from '../src/services/attachment-service.js';
import { createConfig } from '../src/config.js';

test('anexos: aceitar arquivos reais de todos os formatos permitidos', async () => {
  const config = createConfig({});
  const formats = [
    ['blank.pdf', 'application/pdf'], ['pixel.png', 'image/png'], ['pixel.jpg', 'image/jpeg'],
    ['minimal.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ];
  for (const [name, mime] of formats) {
    const buffer = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
    const result = await validateAttachment({ originalname: name, mimetype: mime, buffer }, config);
    assert.deepEqual(result, { name, mime, size: buffer.length });
  }
  const buffer = Buffer.from('Olá, turma!\nTexto UTF-8 válido.');
  assert.equal((await validateAttachment({ originalname: 'atividade.txt', mimetype: 'text/plain', buffer }, config)).size, buffer.length);
});
