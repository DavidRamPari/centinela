/**
 * Background access.log traffic for the shop (ARCHITECTURE §4.3): load-balancer health
 * checks, customers browsing with a daily rhythm (pages, static assets, cart, checkout),
 * search-engine crawlers, and a few 404s (`/favicon.ico`, an occasional `/wp-login.php`).
 * Paths and queries avoid anything the SigmaHQ web rules look for.
 */
import {
  ADDRESSES,
  BROWSER_USER_AGENTS,
  BROWSER_WEIGHTS,
  CATEGORIES,
  CRAWLER_USER_AGENTS,
  crawlerIp,
  customerIp,
  HEALTHCHECK_USER_AGENT,
  PRODUCTS,
  SEARCH_TERMS,
  SHOP_ORIGIN,
  STATIC_ASSETS,
} from './catalog.js';
import { WEB_HOSTS, type Host, type Interval } from './model.js';
import { localHour, type AccessEntry, type LineCollector } from './output.js';
import { Random } from './prng.js';

/** Relative traffic per Lima hour (0–23); the mean is close to 1. */
const DIURNAL = [
  0.3, 0.18, 0.12, 0.1, 0.1, 0.15, 0.35, 0.65, 0.95, 1.15, 1.25, 1.3, 1.4, 1.35, 1.25, 1.25, 1.3,
  1.4, 1.55, 1.75, 1.85, 1.65, 1.15, 0.65,
];

/** Mean seconds between customer visits at relative traffic 1. */
const MEAN_VISIT_GAP_S: Record<string, number> = { 'web-01': 60, 'web-02': 68 };
const HEALTHCHECK_PERIOD_MS = 15_000;
const MEAN_CRAWLER_GAP_S = 45;
const MEAN_WP_PROBE_GAP_S = 6 * 3600;

const RETIRED_PRODUCTS = ['poncho-edicion-2023', 'zapatillas-runner-v1'];

interface Visit {
  host: Host;
  out: LineCollector;
  rng: Random;
  ip: string;
  userAgent: string;
}

function request(v: Visit, ms: number, entry: Omit<AccessEntry, 'ip' | 'userAgent'>): void {
  v.out.access(v.host, ms, { ip: v.ip, userAgent: v.userAgent, ...entry });
}

function pagePath(rng: Random, pageIndex: number): string {
  const roll = rng.float();
  if (pageIndex === 0 && roll < 0.35) return '/';
  if (roll < 0.6) return `/products/${rng.pick(PRODUCTS)}`;
  if (roll < 0.8) return `/category/${rng.pick(CATEGORIES)}${rng.chance(0.3) ? '?page=2' : ''}`;
  if (roll < 0.92) {
    const sort = rng.chance(0.3) ? '&sort=price_asc' : '';
    return `/search?q=${rng.pick(SEARCH_TERMS)}${sort}`;
  }
  return '/cart';
}

function customerVisit(v: Visit, startMs: number): void {
  const { rng } = v;
  const pages = 1 + Math.min(12, Math.floor(rng.exponential(2.5)));
  const returning = rng.chance(0.3);
  let t = startMs;
  let referer: string | undefined = rng.weighted(
    ['https://search.example/', 'https://social.example/', undefined],
    [5, 2, 3],
  );
  for (let i = 0; i < pages; i += 1) {
    let path = pagePath(rng, i);
    let status = 200;
    if (path.startsWith('/products/') && rng.chance(0.01)) {
      path = `/products/${rng.pick(RETIRED_PRODUCTS)}`;
      status = 404;
    }
    request(v, t, {
      method: 'GET',
      target: path,
      status,
      bytes: status === 200 ? rng.int(9_000, 62_000) : 3_412,
      ...(referer === undefined ? {} : { referer }),
      requestTime: rng.int(15, 320) / 1000,
    });
    const pageUrl = `${SHOP_ORIGIN}${path}`;
    let assetAt = t + rng.int(150, 500);
    if (i === 0) {
      for (const asset of STATIC_ASSETS) {
        const cached = returning && rng.chance(0.8);
        request(v, assetAt, {
          method: 'GET',
          target: asset.path,
          status: cached ? 304 : 200,
          bytes: cached ? 0 : asset.bytes,
          referer: pageUrl,
          requestTime: rng.int(1, 40) / 1000,
        });
        assetAt += rng.int(5, 80);
      }
      if (rng.chance(0.03)) {
        request(v, assetAt, {
          method: 'GET',
          target: '/favicon.ico',
          status: 404,
          bytes: 153,
          referer: pageUrl,
        });
      }
    }
    if (status === 200) {
      const images = rng.int(1, 4);
      for (let k = 0; k < images; k += 1) {
        assetAt += rng.int(10, 120);
        request(v, assetAt, {
          method: 'GET',
          target: `/static/img/products/${rng.pick(PRODUCTS)}-${rng.int(1, 4)}.webp`,
          status: 200,
          bytes: rng.int(18_000, 140_000),
          referer: pageUrl,
          requestTime: rng.int(2, 60) / 1000,
        });
      }
      request(v, assetAt + rng.int(30, 300), {
        method: 'GET',
        target: '/api/cart',
        status: 200,
        bytes: rng.int(80, 900),
        referer: pageUrl,
        requestTime: rng.int(3, 30) / 1000,
      });
    }
    if (path.startsWith('/products/') && status === 200 && rng.chance(0.25)) {
      const addAt = t + rng.int(8_000, 40_000);
      request(v, addAt, {
        method: 'POST',
        target: '/cart/add',
        status: 302,
        bytes: 0,
        referer: pageUrl,
      });
      request(v, addAt + rng.int(80, 300), {
        method: 'GET',
        target: '/cart',
        status: 200,
        bytes: rng.int(11_000, 20_000),
        referer: pageUrl,
      });
      t = addAt;
      if (rng.chance(0.35)) {
        const payAt = addAt + rng.int(20_000, 120_000);
        const cartUrl = `${SHOP_ORIGIN}/cart`;
        request(v, payAt, {
          method: 'GET',
          target: '/checkout',
          status: 200,
          bytes: rng.int(14_000, 22_000),
          referer: cartUrl,
        });
        request(v, payAt + rng.int(40_000, 180_000), {
          method: 'POST',
          target: '/checkout',
          status: 303,
          bytes: 0,
          referer: `${SHOP_ORIGIN}/checkout`,
        });
        t = payAt + rng.int(181_000, 200_000);
        request(v, t, {
          method: 'GET',
          target: '/checkout/confirmacion',
          status: 200,
          bytes: rng.int(9_000, 12_000),
          referer: `${SHOP_ORIGIN}/checkout`,
        });
      }
    }
    referer = pageUrl;
    t += rng.int(4_000, 90_000);
  }
}

function poisson(
  rng: Random,
  intervals: readonly Interval[],
  meanGapMs: (t: number) => number,
  emit: (t: number) => void,
): void {
  for (const { fromMs, toMs } of intervals) {
    let t = fromMs;
    for (;;) {
      t += rng.exponential(meanGapMs(t));
      if (t >= toMs) break;
      emit(Math.floor(t));
    }
  }
}

function healthChecks(
  out: LineCollector,
  host: Host,
  intervals: readonly Interval[],
  phaseMs: number,
): void {
  for (const { fromMs, toMs } of intervals) {
    const first =
      Math.ceil((fromMs - phaseMs) / HEALTHCHECK_PERIOD_MS) * HEALTHCHECK_PERIOD_MS + phaseMs;
    for (let t = first; t < toMs; t += HEALTHCHECK_PERIOD_MS) {
      out.access(host, t, {
        ip: ADDRESSES.loadBalancer,
        method: 'GET',
        target: '/healthz',
        status: 200,
        bytes: 2,
        userAgent: HEALTHCHECK_USER_AGENT,
        requestTime: 0.001,
      });
    }
  }
}

export function generateBackgroundWeb(
  out: LineCollector,
  seed: number,
  intervals: readonly Interval[],
): void {
  for (const host of WEB_HOSTS) {
    healthChecks(out, host, intervals, host === 'web-01' ? 0 : 7_000);

    const visits = Random.for(seed, `web:${host}:visits`);
    const visitGap = (MEAN_VISIT_GAP_S[host] ?? 40) * 1000;
    poisson(
      visits,
      intervals,
      (t) => visitGap / (DIURNAL[localHour(t)] ?? 1),
      (t) => {
        const userAgent = visits.weighted(BROWSER_USER_AGENTS, BROWSER_WEIGHTS);
        customerVisit({ host, out, rng: visits, ip: customerIp(visits), userAgent }, t);
      },
    );

    const crawlers = Random.for(seed, `web:${host}:crawlers`);
    poisson(
      crawlers,
      intervals,
      () => MEAN_CRAWLER_GAP_S * 1000,
      (t) => {
        const roll = crawlers.float();
        const target =
          roll < 0.05
            ? '/robots.txt'
            : roll < 0.1
              ? '/sitemap.xml'
              : roll < 0.7
                ? `/products/${crawlers.pick(PRODUCTS)}`
                : `/category/${crawlers.pick(CATEGORIES)}`;
        out.access(host, t, {
          ip: crawlerIp(crawlers),
          method: 'GET',
          target,
          status: 200,
          bytes: crawlers.int(2_000, 60_000),
          userAgent: crawlers.pick(CRAWLER_USER_AGENTS),
          requestTime: crawlers.int(10, 200) / 1000,
        });
      },
    );

    const probes = Random.for(seed, `web:${host}:probes`);
    poisson(
      probes,
      intervals,
      () => MEAN_WP_PROBE_GAP_S * 1000,
      (t) => {
        out.access(host, t, {
          ip: customerIp(probes),
          method: 'GET',
          target: '/wp-login.php',
          status: 404,
          bytes: 153,
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
        });
      },
    );
  }
}
