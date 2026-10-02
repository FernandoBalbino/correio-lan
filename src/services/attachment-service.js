import { mkdtemp, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import yauzl from 'yauzl';
import { AppError } from '../utils/errors.js';

const types = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export function safeFilename(name) {
  return path.posix.basename(String(name).replace(/\\/g, '/')).normalize('NFC')
    .replace(/[\x00-\x1F\x7F<>:"|?*]/g, '').replace(/^[.\s]+/, '').slice(0, 120) || 'arquivo';
}
function validateDocx(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let entries = 0;
      let totalSize = 0;
      const names = new Set();
      const fail = () => { zip.close(); reject(new Error('Estrutura DOCX inválida')); };
      zip.on('error', reject);
      zip.on('entry', entry => {
        entries++; totalSize += entry.uncompressedSize;
        if (entries > 1000 || totalSize > 100 * 1024 * 1024 || entry.fileName.includes('..') || entry.fileName.startsWith('/')
          || /vbaProject\.bin$/i.test(entry.fileName) || (entry.generalPurposeBitFlag & 1)) return fail();
        names.add(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => names.has('[Content_Types].xml') && names.has('word/document.xml') ? resolve() : reject(new Error('Estrutura DOCX inválida')));
      zip.readEntry();
    });
  });
}
export async function validateAttachment(file, config) {
  const name = safeFilename(file.originalname);
  const ext = path.extname(name).slice(1).toLowerCase();
  const mime = types[ext];
  if (!mime || !file.buffer?.length || file.buffer.length > config.maxAttachmentSize) throw new AppError(400, 'INVALID_ATTACHMENT', 'Anexo inválido. Use PDF, PNG, JPG, TXT ou DOCX dentro do limite.');
  const declared = (file.mimetype ?? '').split(';')[0].toLowerCase();
  if (declared !== mime && declared !== 'application/octet-stream') throw new AppError(400, 'ATTACHMENT_MIME', 'O tipo informado do arquivo não corresponde à extensão.');
  try {
    const detected = await fileTypeFromBuffer(file.buffer);
    if (ext === 'txt') {
      if (detected || file.buffer.includes(0)) throw new Error('Texto inválido');
      new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
    } else if (ext === 'docx') {
      if (!detected || !['docx', 'zip'].includes(detected.ext)) throw new Error('DOCX inválido');
      await validateDocx(file.buffer);
    } else if (detected?.mime !== mime) throw new Error('Conteúdo inválido');
  } catch { throw new AppError(400, 'ATTACHMENT_CONTENT', 'O conteúdo do arquivo não corresponde a um tipo permitido.'); }
  return { name, mime, size: file.buffer.length };
}
export class AttachmentService {
  constructor(directory, config, store) {
    this.directory = directory; this.config = config; this.store = store; this.files = new Map(); this.bytes = 0;
  }
  static async create(config, store) {
    // Diretório exclusivo de cada execução; arquivos nunca sobrevivem como estado da aplicação.
    return new AttachmentService(await mkdtemp(path.join(tmpdir(), 'correio-lan-')), config, store);
  }
  async persist(files, room) {
    if (files.length > this.config.maxAttachments) throw new AppError(413, 'ATTACHMENT_LIMIT', 'Quantidade de anexos acima do limite.');
    const metadata = await Promise.all(files.map(file => validateAttachment(file, this.config)));
    const size = metadata.reduce((sum, item) => sum + item.size, 0);
    if (this.bytes + size > this.config.maxUploadBytes) throw new AppError(429, 'UPLOAD_CAPACITY', 'O servidor atingiu a capacidade de anexos temporários.');
    this.bytes += size;
    const saved = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const item = { id: randomUUID(), ...metadata[i], room, createdAt: this.store.now() };
        item.path = path.join(this.directory, item.id);
        await writeFile(item.path, files[i].buffer, { flag: 'wx', mode: 0o600 });
        this.files.set(item.id, item); saved.push(item);
      }
      return saved;
    } catch (error) {
      await this.discard(saved);
      this.bytes -= size - saved.reduce((sum, item) => sum + item.size, 0);
      throw error;
    }
  }
  async discard(files) {
    for (const file of files) if (this.files.delete(file.id)) {
      this.bytes -= file.size;
      await unlink(file.path).catch(() => {});
    }
  }
  async prune() {
    const used = new Set();
    for (const room of this.store.rooms.values()) for (const message of room.messages.values()) {
      for (const file of message.attachments) used.add(file.id);
    }
    await this.discard([...this.files.values()].filter(file => !used.has(file.id) && this.store.now() - file.createdAt > 60000));
  }
  async close() { await rm(this.directory, { recursive: true, force: true }); }
}
