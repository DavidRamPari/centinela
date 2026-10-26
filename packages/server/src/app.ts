/**
 * Express application factory: security headers, request logging, authentication, `/api`,
 * problem+json errors.
 */
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { createAuth } from './auth/index.js';
import type { AppDeps } from './deps.js';
import { createErrorHandler, notFoundHandler } from './http/errors.js';
import { createApiRouter } from './routes/index.js';
import { apiSecurityHeaders } from './security/headers.js';

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustProxy);
  // Plain `key=value` parsing: no nested objects from attacker-shaped query strings.
  app.set('query parser', 'simple');

  app.use(apiSecurityHeaders());
  app.use(
    pinoHttp({
      logger: deps.logger,
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );

  app.use('/api', createApiRouter(deps, createAuth(deps)));
  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));
  return app;
}
