/**
 * Fictional "Andes Retail" world: staff accounts, address plan, products, user agents.
 * No real people, domains or public addresses (ARCHITECTURE §4.3): attackers use the
 * documentation ranges 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24, customers the
 * benchmarking range 198.18.0.0/15, offices and servers 10.20.0.0/16; domains end in
 * `.example`.
 */
import type { Random } from './prng.js';

export const SHOP_ORIGIN = 'https://shop.andes-retail.example';

/** Staff with shell access: Linux account name and uid. */
export const ADMINS = [
  { user: 'mquispe', uid: 1002 },
  { user: 'lrojas', uid: 1003 },
  { user: 'cflores', uid: 1004 },
  { user: 'jhuaman', uid: 1006 },
] as const;
export type Admin = (typeof ADMINS)[number];

export const DEPLOY_UID = 1001;
export const INTERN_UID = 1007;

export const ADDRESSES = {
  /** Jump host; admins reach the other servers through it. */
  bastion: '10.20.0.10',
  loadBalancer: '10.20.0.5',
  ciRunner: '10.20.0.30',
} as const;

/** Office workstation (10.20.10.0/24). */
export function officeIp(rng: Random): string {
  return `10.20.10.${rng.int(20, 220)}`;
}

/** Customer address in 198.18.0.0/15 (198.19.250.0/24 is reserved for crawlers). */
export function customerIp(rng: Random): string {
  const second = rng.chance(0.5) ? 18 : 19;
  const third = second === 19 ? rng.int(0, 249) : rng.int(0, 255);
  return `198.${second}.${third}.${rng.int(1, 254)}`;
}

export function crawlerIp(rng: Random): string {
  return `198.19.250.${rng.int(1, 254)}`;
}

/** Ephemeral source port. */
export function clientPort(rng: Random): number {
  return rng.int(32768, 60999);
}

/** OpenSSH key fingerprint text (`SHA256:` + 43 base64 characters). */
export function keyFingerprint(rng: Random): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return `SHA256:${rng.chars(43, alphabet)}`;
}

export const BROWSER_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; moto g54 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
] as const;

export const BROWSER_WEIGHTS = [30, 8, 7, 22, 20, 8, 5] as const;

/** Crawler user agents, without the vendors' URLs (no real domains in the data). */
export const CRAWLER_USER_AGENTS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1)',
  'Mozilla/5.0 (compatible; bingbot/2.0)',
] as const;

export const HEALTHCHECK_USER_AGENT = 'lb-healthcheck/1.0';

export const PRODUCTS = [
  'zapatillas-trail-inca',
  'casaca-impermeable-andina',
  'polo-algodon-pima',
  'mochila-urbana-25l',
  'lentes-de-sol-polarizados',
  'chompa-alpaca-clasica',
  'pantalon-cargo-explorer',
  'gorro-chullo-tejido',
  'botas-montana-cumbre',
  'bufanda-vicuna-suave',
  'reloj-deportivo-gps',
  'termo-acero-750ml',
  'carpa-dos-personas',
  'sandalias-playa-mancora',
  'vestido-lino-verano',
  'camisa-oxford-celeste',
] as const;

export const CATEGORIES = ['hombre', 'mujer', 'ninos', 'outdoor', 'accesorios', 'ofertas'] as const;

export const SEARCH_TERMS = [
  'zapatillas',
  'casaca+impermeable',
  'polo+pima',
  'mochila',
  'lentes+de+sol',
  'chompa+alpaca',
  'botas',
  'regalo+navidad',
  'carpa',
  'termo',
] as const;

/** Static asset fingerprints, as a bundler would emit them. */
export const STATIC_ASSETS = [
  { path: '/static/css/app.3f9a1c.css', bytes: 48_211 },
  { path: '/static/js/app.8b2d4e.js', bytes: 183_406 },
  { path: '/static/js/vendor.c71f02.js', bytes: 402_118 },
] as const;
