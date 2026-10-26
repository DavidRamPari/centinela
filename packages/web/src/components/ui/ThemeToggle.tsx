import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { setTheme, useTheme } from '../../lib/theme';

export function ThemeToggle() {
  const { t } = useTranslation();
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const Icon = theme === 'dark' ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className="rounded-md border border-line p-1.5 text-muted hover:text-fg"
      aria-label={t(next === 'light' ? 'theme.toLight' : 'theme.toDark')}
      title={t(next === 'light' ? 'theme.toLight' : 'theme.toDark')}
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  );
}
