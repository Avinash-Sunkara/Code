import pino from 'pino';
import { env, isProd } from './env';

export const logger = pino({
  level: isProd ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
      '*.password', '*.passwordHash', '*.token', '*.refreshToken', '*.secret', '*.newPassword',
    ],
    censor: '[REDACTED]',
  },
  ...(env.NODE_ENV === 'development' ? {} : {}),
});
