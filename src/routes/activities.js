import { Router } from 'express';
import { ok } from '../utils/errors.js';

export function activityRoutes({ activityService, config, auth, limiter }) {
  const router = Router();
  router.use(auth);
  router.get('/current', (req, res) => ok(res, activityService.current(req.user)));
  router.get('/status', (req, res) => ok(res, activityService.status(req.user)));
  router.post('/', limiter.limit('activity', 10, 60000, req => req.user.id), (req, res) => ok(res, activityService.publish(req.user, req.body ?? {}), 201));
  return router;
}
