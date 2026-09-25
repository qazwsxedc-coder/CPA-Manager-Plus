import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import {
  compareUpstreamVersions,
  hasAutomaticMigration,
  selectPreparedRelease,
  samePreparedRelease,
  type HostUpgradeRelease,
  type UpgradeComponent,
} from './hostUpgradeModel';
import type { HostUpgrades } from './useHostUpgrades';
import styles from './HostUpgradeControls.module.scss';

const componentName = (component: UpgradeComponent) =>
  component === 'cli' ? 'CLIProxyAPI' : 'CPAMP';

export function HostUpgradeAction({
  component,
  upgrades,
  onSelect,
}: {
  component: UpgradeComponent;
  upgrades: HostUpgrades;
  onSelect: (release: HostUpgradeRelease) => void;
}) {
  const { t } = useTranslation();
  if (!upgrades.enabled) return null;
  const release = selectPreparedRelease(upgrades.catalog, component);
  const current = upgrades.catalog?.current[component].version || '';
  const latest = upgrades.catalog?.latest[component] || '';
  const reason = upgrades.reconnecting
    ? 'reconnecting'
    : !upgrades.canStart
      ? 'executor_offline'
      : upgrades.busy
        ? 'busy'
        : release
          ? ''
          : compareUpstreamVersions(latest, current) === 1
            ? 'awaiting_preparation'
            : 'no_installable';
  return (
    <div className={styles.action}>
      <Button
        type="button"
        variant="secondary"
        size="xs"
        disabled={!release || !upgrades.canStart || upgrades.busy}
        onClick={() => release && onSelect(release)}
        aria-label={t('host_upgrades.upgrade_component', { component: componentName(component) })}
      >
        {t('host_upgrades.upgrade')}
      </Button>
      {reason && <span className={styles.hint}>{t(`host_upgrades.${reason}`)}</span>}
    </div>
  );
}

export function HostUpgradeStatus({ upgrades }: { upgrades: HostUpgrades }) {
  const { t } = useTranslation();
  const job = upgrades.job;
  if (!upgrades.enabled || (!job && !upgrades.pending && !upgrades.error)) return null;
  return (
    <div className={styles.status} role="status" aria-live="polite">
      <strong>
        {job
          ? `${componentName(job.component)} · ${t(`host_upgrades.states.${job.state}`)}`
          : t(upgrades.pending ? 'host_upgrades.submitting' : 'host_upgrades.upgrade')}
      </strong>
      {upgrades.reconnecting && <p>{t('host_upgrades.reconnecting_detail')}</p>}
      {upgrades.error === 'storage' && <p>{t('host_upgrades.storage_unavailable')}</p>}
      {upgrades.error === 'rejected' && (
        <p>{t('host_upgrades.request_rejected', { status: upgrades.rejectionStatus })}</p>
      )}
      {job?.message && <p>{job.message}</p>}
      {job?.step && <p>{t('host_upgrades.step', { step: job.step })}</p>}
      {job?.fromVersion && job.toVersion && (
        <p>
          {job.fromVersion} → {job.toVersion}
        </p>
      )}
      {job?.backupPath && (
        <p>
          {t('host_upgrades.backup_path')} <code className={styles.path}>{job.backupPath}</code>
        </p>
      )}
      {job?.state === 'manual_recovery' && <p>{t('host_upgrades.manual_recovery_detail')}</p>}
      {job?.state === 'succeeded' && job.component === 'manager' && (
        <Button size="xs" variant="secondary" onClick={() => window.location.reload()}>
          {t('host_upgrades.reload_panel')}
        </Button>
      )}
    </div>
  );
}

export function HostUpgradeConfirmation({
  release,
  upgrades,
  onClose,
}: {
  release: HostUpgradeRelease | null;
  upgrades: HostUpgrades;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const eligible =
    release &&
    samePreparedRelease(release, selectPreparedRelease(upgrades.catalog, release.component));
  return (
    <Modal
      open={!!release}
      title={t('host_upgrades.confirm_title', {
        component: release ? componentName(release.component) : '',
      })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!eligible || !upgrades.canStart || upgrades.busy}
            onClick={() => {
              if (!release || !eligible || !upgrades.canStart || upgrades.busy) return;
              void upgrades.start(release);
              onClose();
            }}
          >
            {t('host_upgrades.confirm')}
          </Button>
        </>
      }
    >
      {release && (
        <div className={styles.confirmation}>
          <p className={styles.versions}>
            {upgrades.catalog?.current[release.component].version} → {release.version}
          </p>
          <p>{t('host_upgrades.outage')}</p>
          {release.prepareRequired && <p>{t('host_upgrades.direct_download')}</p>}
          {hasAutomaticMigration(release) && (
            <p role="note">
              <strong>{t('host_upgrades.automatic_migration')}</strong>
            </p>
          )}
          {release.component === 'manager' && <p>{t('host_upgrades.manager_reconnect')}</p>}
        </div>
      )}
    </Modal>
  );
}
