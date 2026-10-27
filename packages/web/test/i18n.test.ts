import { describe, expect, it, vi } from 'vitest';
import en from '../src/i18n/en.json';
import es from '../src/i18n/es.json';
import { createI18n, readStoredLanguage, storeLanguage } from '../src/i18n';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('i18n', () => {
  it('has the same keys in English and Spanish', () => {
    expect(keys(es).sort()).toEqual(keys(en).sort());
  });

  it('has no empty translations', () => {
    for (const resource of [en, es]) {
      for (const key of keys(resource)) {
        const value = key
          .split('.')
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], resource);
        expect(typeof value === 'string' && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it('has every key used in the source in both languages', () => {
    // Literal keys in t('…') calls and the static prefix of template keys (t(`levels.${x}`)).
    const sources = import.meta.glob<string>(['../src/**/*.{ts,tsx}', '!../src/**/*.d.ts'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const known = { en: new Set(keys(en)), es: new Set(keys(es)) };
    let checked = 0;
    for (const [file, text] of Object.entries(sources)) {
      for (const match of text.matchAll(/\bt\(\s*['`]([a-zA-Z][\w.]*)(\$\{)?/g)) {
        const key = match[1] ?? '';
        const isPrefix = match[2] !== undefined;
        for (const [lang, set] of Object.entries(known)) {
          // A plural key (t('x', { count })) resolves to x_one / x_other.
          const found = isPrefix
            ? [...set].some((k) => k.startsWith(key))
            : set.has(key) || (set.has(`${key}_one`) && set.has(`${key}_other`));
          expect(found, `${file}: "${key}" missing in ${lang}`).toBe(true);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('has the same plural forms in both languages', () => {
    for (const resource of [en, es]) {
      const all = new Set(keys(resource));
      for (const key of all) {
        if (key.endsWith('_one')) expect(all.has(key.replace(/_one$/, '_other')), key).toBe(true);
        if (key.endsWith('_other')) expect(all.has(key.replace(/_other$/, '_one')), key).toBe(true);
      }
    }
  });

  it('survives unavailable localStorage', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    try {
      expect(readStoredLanguage()).toBeUndefined();
      expect(() => storeLanguage('es')).not.toThrow();
      const i18n = createI18n();
      expect(() => i18n.changeLanguage('es')).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('ignores invalid stored values', () => {
    window.localStorage.setItem('centinela.language', 'fr');
    expect(readStoredLanguage()).toBeUndefined();
  });
});
