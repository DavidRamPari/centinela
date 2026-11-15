import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { createShutdown } from '../src/shutdown.js';

describe('graceful shutdown', () => {
  it('closes the HTTP server, then the pool, once', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());

    const end = vi.fn(() => Promise.resolve());
    const shutdown = createShutdown({
      server,
      pool: { end },
      logger: createLogger({ logLevel: 'silent' }),
    });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(server.listening).toBe(false);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('runs beforeClose after the server stopped and before the pool closes', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const order: string[] = [];
    const shutdown = createShutdown({
      server,
      pool: { end: () => Promise.resolve(void order.push('pool closed')) },
      logger: createLogger({ logLevel: 'silent' }),
      beforeClose: () => {
        order.push(`state saved (server listening: ${server.listening})`);
        return Promise.resolve();
      },
    });
    await shutdown('SIGTERM');
    expect(order).toEqual(['state saved (server listening: false)', 'pool closed']);
  });

  it('still closes the pool when beforeClose fails', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const end = vi.fn(() => Promise.resolve());
    const shutdown = createShutdown({
      server,
      pool: { end },
      logger: createLogger({ logLevel: 'silent' }),
      beforeClose: () => Promise.reject(new Error('checkpoint failed')),
    });
    await expect(shutdown('SIGTERM')).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
