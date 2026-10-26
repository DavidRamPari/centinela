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
