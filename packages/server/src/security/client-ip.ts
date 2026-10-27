import type { Request } from 'express';
import { normalizeIp } from '../parsers/common.js';

/**
 * Client address for lockout and the audit log, normalized like event IPs (IPv4-mapped
 * IPv6 becomes IPv4). Behind a reverse proxy it is only right when `TRUST_PROXY` is set.
 */
export function clientIp(req: Request): string | null {
  return normalizeIp(req.ip ?? '') ?? null;
}
