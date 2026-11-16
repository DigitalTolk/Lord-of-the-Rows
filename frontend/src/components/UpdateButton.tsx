import { useTranslation } from 'react-i18next';
import { useApp } from '../store';
import { Icon } from './icons';

/** "Update available" pill: shown while a newer release is known; opens Settings → Updates. */
export function UpdateButton({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const update = useApp((s) => s.update);
  const openUpdates = useApp((s) => s.openUpdates);
  if (!update) return null;
  return (
    <button
      className={`btn btn-primary h-7 gap-1.5 px-2.5 text-xs ${className}`}
      title={t('updates.pillTitle', { version: update.version, current: update.current_version })}
      onClick={() => {
        useApp.setState({ launcher: false });
        openUpdates();
      }}
    >
      <Icon name="download" size={13} /> {t('updates.pill', { version: update.version })}
    </button>
  );
}
