import { AppError } from '../utils/errors.js';

export function createRateLimiter({ now = Date.now } = {}) {
  const windows = new Map();
  const sweep = () => {
    for (const [key, entry] of windows) if (entry.expiresAt <= now()) windows.delete(key);
  };
  const limit = (name, max, interval, identify) => (req, res, next) => {
    const key = `${name}:${identify(req)}`;
    let entry = windows.get(key);
    if (!entry || entry.expiresAt <= now()) {
      entry = { count: 0, expiresAt: now() + interval };
      windows.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.expiresAt - now()) / 1000));
      return next(new AppError(429, 'RATE_LIMIT', 'Muitas tentativas. Aguarde um pouco e tente novamente.'));
    }
    next();
  };
  return { limit, sweep };
}
