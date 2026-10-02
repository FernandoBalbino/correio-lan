import { AppError } from './errors.js';

export function text(value, label, max, { required = true, multiline = false } = {}) {
  if (typeof value !== 'string') throw new AppError(400, 'INVALID_FIELD', `${label} inválido.`);
  const clean = value.normalize('NFC').replace(multiline ? /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g : /[\x00-\x1F\x7F]/g, '').trim();
  if ((required && !clean) || [...clean].length > max) {
    throw new AppError(400, 'INVALID_FIELD', `${label} deve ter ${required ? 'entre 1 e' : 'até'} ${max} caracteres.`);
  }
  return clean;
}

export function normalizeRoom(value) {
  const raw = text(value, 'Sala', 30);
  const key = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!key || key.length > 30) throw new AppError(400, 'INVALID_ROOM', 'Informe uma sala com letras ou números.');
  return key;
}

export function normalizeUsername(value) {
  const username = text(value, 'Identificador', 30).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(username)) {
    throw new AppError(400, 'INVALID_USERNAME', 'Use letras sem acento, números, ponto, hífen ou sublinhado; comece e termine com letra ou número.');
  }
  return username;
}

export function createEmail(username, room) {
  return `${normalizeUsername(username)}@${normalizeRoom(room)}.local`;
}

export function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new AppError(400, 'INVALID_CURSOR', 'Página ou cursor inválido.');
  return n;
}

export function boolean(value) {
  if (typeof value !== 'boolean') throw new AppError(400, 'INVALID_FIELD', 'Informe true ou false.');
  return value;
}
