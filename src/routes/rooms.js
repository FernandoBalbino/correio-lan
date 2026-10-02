import { Router } from 'express';
import { ok } from '../utils/errors.js';
import { clientConfig } from '../config.js';

export function roomRoutes({ roomService, auth, limiter, config }) {
  const router = Router();
  router.post('/join', limiter.limit('join', config.joinRateLimit, config.joinRateWindow, req => req.ip), (req, res) => {
    const user = roomService.join(req.body ?? {});
    ok(res, { sessionToken: user.token, ...roomService.current(user), config: clientConfig(config) }, 201);
  });
  router.use(auth);
  router.post('/leave', (req, res) => ok(res, roomService.leave(req.user)));
  router.get('/current', (req, res) => ok(res, { ...roomService.current(req.user), config: clientConfig(config) }));
  router.get('/users', (req, res) => ok(res, roomService.users(req.user)));
  return router;
}
