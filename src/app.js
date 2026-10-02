import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from './config.js';
import { MemoryStore } from './repositories/memory-store.js';
import { RoomService } from './services/room-service.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { roomRoutes } from './routes/rooms.js';
import { AppError, ok } from './utils/errors.js';
import { MessageService } from './services/message-service.js';
import { AttachmentService } from './services/attachment-service.js';
import { ActivityService } from './services/activity-service.js';
import { messageRoutes } from './routes/messages.js';
import { activityRoutes } from './routes/activities.js';

const publicPath = fileURLToPath(new URL('../public/', import.meta.url));

export async function createApplication({ config = createConfig(), now = Date.now, extraRoutes } = {}) {
  const app = express();
  const store = new MemoryStore({ config, now });
  const roomService = new RoomService(store, config);
  const limiter = createRateLimiter({ now });
  const attachments = await AttachmentService.create(config, store);
  const messageService = new MessageService(store, config, { roomService, attachments });
  const activityService = new ActivityService(store, roomService);
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
      imgSrc: ["'self'", 'blob:', 'data:'], fontSrc: ["'self'"], connectSrc: ["'self'"],
      objectSrc: ["'none'"], frameAncestors: ["'none'"],
      upgradeInsecureRequests: config.production ? [] : null,
    } },
    hsts: config.production ? undefined : false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
  }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin) {
      try { if (new URL(origin).host !== req.get('host')) throw new Error(); }
      catch { return next(new AppError(403, 'CROSS_ORIGIN', 'Origem não permitida.')); }
    }
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  const auth = (req, res, next) => {
    try {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') ?? '')?.[1];
      if (!token) throw new AppError(401, 'SESSION_REQUIRED', 'Entre em uma sala para continuar.');
      req.user = roomService.authenticate(token);
      next();
    } catch (error) { next(error); }
  };
  app.get('/api/health', (req, res) => ok(res, {
    status: 'ok', uptime: Math.floor(process.uptime()), rooms: store.rooms.size, users: store.sessions.size, instanceId: store.instanceId,
  }));
  const context = { app, store, config, roomService, messageService, attachments, activityService, auth, limiter };
  app.use('/api/rooms', roomRoutes(context));
  app.post('/api/presence/heartbeat', auth,
    limiter.limit('heartbeat', config.heartbeatRateLimit, 60000, req => req.user.id),
    (req, res) => ok(res, roomService.heartbeat(req.user)));
  app.use('/api/messages', messageRoutes(context));
  app.use('/api/activities', activityRoutes(context));
  if (extraRoutes) await extraRoutes(context);
  app.use('/api', (req, res, next) => next(new AppError(404, 'NOT_FOUND', 'Endpoint não encontrado.')));
  app.use(express.static(publicPath, { dotfiles: 'deny', etag: !config.production, maxAge: 0 }));
  app.get('/app', (req, res) => res.sendFile(path.join(publicPath, 'app.html')));
  app.use((req, res, next) => next(new AppError(404, 'NOT_FOUND', 'Página não encontrada.')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const uploadLimit = ['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_PART_COUNT', 'LIMIT_FIELD_VALUE', 'LIMIT_FIELD_COUNT'].includes(error.code);
    const malformed = error.type === 'entity.parse.failed' || error instanceof SyntaxError || error.code === 'LIMIT_UNEXPECTED_FILE';
    const status = uploadLimit || error.type === 'entity.too.large' ? 413 : malformed ? 400 : (error.status ?? 500);
    if (status >= 500) console.error('Falha interna:', error.message);
    res.status(status).json({ success: false, error: {
      code: status === 413 ? 'PAYLOAD_LIMIT' : malformed ? 'INVALID_REQUEST' : (error.code ?? 'INTERNAL_ERROR'),
      message: status === 413 ? 'Arquivo, quantidade de anexos ou requisição acima do limite permitido.'
        : malformed ? 'Requisição inválida.' : status >= 500 ? 'Não foi possível concluir a operação.' : error.message,
    } });
  });
  const timer = setInterval(() => {
    store.cleanup(); limiter.sweep(); messageService.wakeSnoozed();
    attachments.prune().catch(error => console.error('Falha na limpeza de anexos:', error.message));
  }, config.cleanupInterval);
  timer.unref();
  return { ...context, close: async () => { clearInterval(timer); await attachments.close(); } };
}
