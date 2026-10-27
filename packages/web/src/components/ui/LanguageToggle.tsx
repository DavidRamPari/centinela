import { useTranslation } from 'react-i18next';
import { LANGUAGES, isLanguage } from '../../i18n';
import { Segmented } from './Fields';

/** English / Español, each written in its own language. Persisted by the i18n module. */
export function LanguageToggle({ showLabel = true }: { showLabel?: boolean }) {
  const { t, i18n } = useTranslation();
  const current = i18n.resolvedLanguage ?? i18n.language;
  return (
    <Segmented
      label={t('language.label')}
      showLabel={showLabel}
      value={isLanguage(current) ? current : 'en'}
      onChange={(lang) => void i18n.changeLanguage(lang)}
      options={LANGUAGES.map((lang) => ({ value: lang, label: t(`language.${lang}`), lang }))}
    />
  );
}
