import { Router } from 'express';
import multer from 'multer';
import { AppError, ok } from '../utils/errors.js';
import { boolean } from '../utils/validation.js';

export function messageRoutes({ messageService, config, auth, limiter }) {
  const router = Router();
  let uploading = 0;
  const uploadCapacity = (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    if (uploading >= config.maxConcurrentUploads) {
      res.set('Retry-After', '3');
      return next(new AppError(429, 'UPLOAD_BUSY', 'O servidor está recebendo outros anexos. Aguarde alguns segundos e tente novamente.'));
    }
    uploading++;
    let released = false;
    const release = () => { if (!released) { released = true; uploading--; } };
    res.once('finish', release); res.once('close', release);
    next();
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: config.maxAttachmentSize, files: config.maxAttachments,
    fields: 1, fieldSize: 128 * 1024, parts: config.maxAttachments + 1,
  } });
  router.use(auth);
  router.get('/sync', (req, res) => {
    const data = messageService.sync(req.user, req.query.cursor);
    if (req.query.view === 'threads') data.totals = messageService.conversationTotals(req.user);
    ok(res, data);
  });
  for (const folder of ['inbox', 'sent', 'trash', 'starred', 'archive', 'spam', 'snoozed']) {
    router.get(`/${folder}`, (req, res) => ok(res, messageService.list(req.user, folder, req.query)));
  }
  router.post('/', limiter.limit('send', config.messageRateLimit, 60000, req => req.user.id), uploadCapacity, upload.array('attachments', config.maxAttachments), async (req, res) => {
    const input = req.is('multipart/form-data') ? JSON.parse(req.body.message ?? '{}') : (req.body ?? {});
    ok(res, await messageService.send(req.user, input, req.files ?? [], req.get('Idempotency-Key')), 201);
  });
  router.get('/:id/thread', (req, res) => ok(res, messageService.conversation(req.user, req.params.id)));
  for (const [action, patch] of [
    ['read', req => ({ read: boolean(req.body?.read) })],
    ['star', req => ({ starred: boolean(req.body?.starred) })],
    ['trash', () => ({ trash: true })],
    ['restore', () => ({ trash: false })],
    ['location', req => {
      const location = req.body?.location;
      if (!['inbox', 'archive', 'spam', 'snoozed'].includes(location)) throw new AppError(400, 'INVALID_LOCATION', 'Destino inválido.');
      return { location, snoozedUntil: location === 'snoozed' ? messageService.store.now() + 3600000 : null };
    }],
  ]) router.patch(`/:id/thread/${action}`, (req, res) => ok(res, messageService.updateConversation(req.user, req.params.id, patch(req))));
  router.delete('/:id/thread', (req, res) => ok(res, messageService.removeConversation(req.user, req.params.id)));
  router.get('/:id/attachments/:attachmentId', (req, res, next) => {
    const message = messageService.get(req.user, req.params.id);
    const attachment = message.attachments.find(item => item.id === req.params.attachmentId);
    if (!attachment) throw new AppError(404, 'ATTACHMENT_NOT_FOUND', 'Anexo não encontrado.');
    res.type(attachment.mime);
    res.set('X-Content-Type-Options', 'nosniff');
    res.download(attachment.path, attachment.name, error => { if (error) next(error); });
  });
  router.get('/:id', (req, res) => ok(res, messageService.projection(req.user, messageService.get(req.user, req.params.id), true)));
  router.patch('/:id/read', (req, res) => ok(res, messageService.update(req.user, req.params.id, { read: boolean(req.body?.read) })));
  router.patch('/:id/star', (req, res) => ok(res, messageService.update(req.user, req.params.id, { starred: boolean(req.body?.starred) })));
  router.patch('/:id/trash', (req, res) => ok(res, messageService.update(req.user, req.params.id, { trash: true })));
  router.patch('/:id/restore', (req, res) => ok(res, messageService.update(req.user, req.params.id, { trash: false })));
  router.patch('/:id/location', (req, res) => {
    const location = req.body?.location;
    if (!['inbox', 'archive', 'spam', 'snoozed'].includes(location)) throw new AppError(400, 'INVALID_LOCATION', 'Destino inválido.');
    ok(res, messageService.update(req.user, req.params.id, { location, snoozedUntil: location === 'snoozed' ? messageService.store.now() + 3600000 : null }));
  });
  router.delete('/:id', (req, res) => ok(res, messageService.remove(req.user, req.params.id)));
  return router;
}
