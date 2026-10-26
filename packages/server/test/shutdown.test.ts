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
});
