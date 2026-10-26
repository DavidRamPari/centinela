import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { LANGUAGES } from '../../i18n';

/** EN / ES switch. The selection is persisted by the i18n module. */
export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const current = i18n.resolvedLanguage ?? i18n.language;
  return (
    <div
      role="group"
      aria-label={t('language.label')}
      className="flex rounded-md border border-line p-0.5"
    >
      {LANGUAGES.map((lang) => (
        <button
          key={lang}
          type="button"
          lang={lang}
          aria-pressed={current === lang}
          title={t(`language.${lang}`)}
          onClick={() => void i18n.changeLanguage(lang)}
          className={clsx(
            'rounded px-2 py-0.5 text-xs font-semibold uppercase',
            current === lang ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg',
          )}
        >
          {lang}
        </button>
      ))}
    </div>
  );
}
