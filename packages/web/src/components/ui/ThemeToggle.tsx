import { useTranslation } from 'react-i18next';
import { setTheme, useTheme } from '../../lib/theme';
import { Segmented } from './Fields';

/** Dark (the default, like an arcade screen) or light. */
export function ThemeToggle({ showLabel = true }: { showLabel?: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <Segmented
      label={t('theme.label')}
      showLabel={showLabel}
      value={theme}
      onChange={setTheme}
      options={[
        { value: 'dark', label: t('theme.dark') },
        { value: 'light', label: t('theme.light') },
      ]}
    />
  );
}
