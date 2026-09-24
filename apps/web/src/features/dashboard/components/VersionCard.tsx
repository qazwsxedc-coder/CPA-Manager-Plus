import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import {
  IconCheck,
  IconChevronRight,
  IconExternalLink,
  IconInfo,
  IconRefreshCw,
  IconSatellite,
  IconSettings,
  IconTimer,
} from '@/components/ui/icons';
import { useNotificationStore } from '@/stores';
import { versionApi } from '@/services/api';
import type { UsageServiceStatus } from '@/services/api/usageService';
import type { ConnectionStatus } from '@/types';
import { compareVersions, type VersionComparison } from '@/utils/version';
import { readApiLatestVersion, readManagerStableVersion } from '@/features/system/versionChecks';
import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import { useManagerUpdates } from '@/features/system/ManagerUpdates';
import { useHostUpgrades } from '@/features/system/useHostUpgrades';
import { useHostUpdateCheck } from '@/features/system/useHostUpdateCheck';
import {
  compareUpstreamVersions,
  type HostUpgradeRelease,
} from '@/features/system/hostUpgradeModel';
import {
  HostUpgradeAction,
  HostUpgradeConfirmation,
  HostUpgradeStatus,
} from '@/features/system/HostUpgradeControls';
import { buildDashboardVersionReleaseURL } from '@/features/dashboard/versionReleaseLinks';
import styles from './VersionCard.module.scss';

interface VersionCardProps {
  appVersion: string;
  apiVersion: string;
  cpaBase: string;
  serverBuildDate?: string;
  connectionStatus: ConnectionStatus;
  refreshSignal?: number;
  usageEnabled: boolean;
  usageLoading: boolean;
  usageError?: string;
  collectorStatus: UsageServiceStatus | null;
  collectorLoading: boolean;
  collectorError?: string;
  errorLogCount: number;
  errorLogsLoading: boolean;
}

interface LatestVersions {
  latestApi: string;
}

type HealthTone = 'ok' | 'warn' | 'error' | 'muted';

interface HealthItem {
  label: string;
  value: string;
  tone: HealthTone;
  icon: ReactNode;
  to?: string;
}

type ExternalStableLoadResult =
  | {
      current: true;
      version: string | null;
    }
  | {
      current: false;
    };

interface VersionBadge {
  label: string;
  className: string;
  releaseUrl?: string;
}

const renderBadge = (
  comparison: VersionComparison,
  latest: string,
  releaseUrl: string,
  t: TFunction
): VersionBadge | null => {
  if (comparison === null) return null;
  if (comparison > 0) {
    const display = latest.trim().replace(/^[vV]+/, '');
    return {
      label: t('dashboard.version_update_available', { version: `v${display}` }),
      className: styles.badgeUpdate,
      releaseUrl: releaseUrl || undefined,
    };
  }
  if (comparison === 0) {
    return { label: t('dashboard.version_is_latest'), className: styles.badgeLatest };
  }
  return null;
};

const renderVersionValue = (value: string, releaseUrl: string): ReactNode => {
  if (!releaseUrl) {
    return (
      <span className={styles.value} title={value}>
        {value}
      </span>
    );
  }

  return (
    <a className={styles.versionLink} href={releaseUrl} target="_blank" rel="noopener noreferrer">
      <span className={styles.value} title={value}>
        {value}
      </span>
      <IconExternalLink size={12} />
    </a>
  );
};

const renderBadgeValue = (badge: VersionBadge | null): ReactNode => {
  if (!badge) return null;

  const className = `${styles.badge} ${badge.className}`;
  if (!badge.releaseUrl) {
    return <span className={className}>{badge.label}</span>;
  }

  return (
    <a className={className} href={badge.releaseUrl} target="_blank" rel="noopener noreferrer">
      {badge.label}
    </a>
  );
};

export function VersionCard({
  appVersion,
  apiVersion,
  cpaBase,
  serverBuildDate,
  refreshSignal,
  usageEnabled,
  usageLoading,
  usageError,
  collectorStatus,
  collectorLoading,
  collectorError,
  errorLogCount,
  errorLogsLoading,
}: VersionCardProps) {
  const { t, i18n } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const updates = useManagerUpdates();
  const featureAvailability = usePanelFeatureAvailability();
  const managerBase =
    featureAvailability.managerServiceBase ||
    (featureAvailability.panelHostMode === 'manager_embedded' ? featureAvailability.panelBase : '');
  const hostUpgrades = useHostUpgrades(
    managerBase,
    featureAvailability.managerServiceAvailable,
    refreshSignal
  );
  const [selectedUpgrade, setSelectedUpgrade] = useState<HostUpgradeRelease | null>(null);
  const refreshHostUpgrades = hostUpgrades.refresh;
  const updateCheck = useHostUpdateCheck(
    managerBase,
    hostUpgrades.enabled,
    hostUpgrades.canStart && !hostUpgrades.busy
  );
  const startVersionCheck = updateCheck.start;
  const completedCheck =
    updateCheck.check && ['succeeded', 'failed'].includes(updateCheck.check.state)
      ? `${updateCheck.check.id}:${updateCheck.check.updatedAt}`
      : null;
  useEffect(() => {
    if (completedCheck) void refreshHostUpgrades();
  }, [completedCheck, refreshHostUpgrades]);
  useEffect(() => {
    setSelectedUpgrade(null);
  }, [featureAvailability.managerServiceBase, featureAvailability.panelBase]);
  const managerVersion =
    (hostUpgrades.enabled && hostUpgrades.catalog?.current.manager.version) ||
    updates.status?.current_version ||
    appVersion;
  const displayedApiVersion =
    (hostUpgrades.enabled && hostUpgrades.catalog?.current.cli.version) || apiVersion;
  const externalManagerUpdateFallback =
    featureAvailability.panelHostConfirmed &&
    featureAvailability.panelHostMode === 'external_panel' &&
    !featureAvailability.managerServiceAvailable;

  const [externalStableVersion, setExternalStableVersion] = useState<string | null | undefined>(
    undefined
  );
  const [externalStableError, setExternalStableError] = useState(false);
  const [checkingManagerVersion, setCheckingManagerVersion] = useState(false);
  const externalRequestSequenceRef = useRef(0);

  const [latest, setLatest] = useState<LatestVersions>({ latestApi: '' });
  const latestApi = hostUpgrades.enabled
    ? hostUpgrades.catalog?.latest.cli || ''
    : latest.latestApi;
  const [checkingApiVersion, setCheckingApiVersion] = useState(false);

  const loadExternalManagerStable = useCallback(async (): Promise<ExternalStableLoadResult> => {
    const requestId = ++externalRequestSequenceRef.current;

    try {
      const data = await versionApi.checkManagerUpdateIndex();
      const version = readManagerStableVersion(data);

      if (requestId !== externalRequestSequenceRef.current) {
        return { current: false };
      }

      setExternalStableVersion(version);
      setExternalStableError(false);

      return {
        current: true,
        version,
      };
    } catch (error) {
      if (requestId !== externalRequestSequenceRef.current) {
        return { current: false };
      }

      setExternalStableVersion(undefined);
      setExternalStableError(true);

      throw error;
    }
  }, []);

  useEffect(() => {
    externalRequestSequenceRef.current += 1;
    setExternalStableVersion(undefined);
    setExternalStableError(false);
    return () => {
      externalRequestSequenceRef.current += 1;
    };
  }, [externalManagerUpdateFallback]);

  const handleExternalManagerCheck = useCallback(async () => {
    setCheckingManagerVersion(true);
    try {
      const result = await loadExternalManagerStable();
      if (!result.current) {
        return;
      }

      const version = result.version;
      if (version === null) {
        showNotification(t('manager_updates.no_candidate'), 'info');
        return;
      }

      const comparison = compareVersions(version, appVersion);
      if (comparison === null) {
        showNotification(t('system_info.manager_version_current_missing'), 'warning');
        return;
      }

      if (comparison > 0) {
        showNotification(t('system_info.manager_version_update_available', { version }), 'warning');
      } else {
        showNotification(t('system_info.manager_version_is_latest'), 'success');
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      const suffix = message ? `: ${message}` : '';
      showNotification(`${t('system_info.manager_version_check_error')}${suffix}`, 'error');
    } finally {
      setCheckingManagerVersion(false);
    }
  }, [appVersion, loadExternalManagerStable, showNotification, t]);

  const handleApiVersionCheck = useCallback(async () => {
    setCheckingApiVersion(true);
    try {
      if (featureAvailability.checking || !hostUpgrades.resolved) return;
      if (hostUpgrades.enabled) {
        await startVersionCheck();
        return;
      }
      const data = await versionApi.checkLatest();
      const latestApi = readApiLatestVersion(data);
      const comparison = compareVersions(latestApi, apiVersion);
      setLatest((prev) => ({ ...prev, latestApi }));

      if (!latestApi) {
        showNotification(t('system_info.version_check_error'), 'error');
        return;
      }

      if (comparison === null) {
        showNotification(t('system_info.version_current_missing'), 'warning');
        return;
      }

      if (comparison > 0) {
        showNotification(
          t('system_info.version_update_available', { version: latestApi }),
          'warning'
        );
      } else {
        showNotification(t('system_info.version_is_latest'), 'success');
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      const suffix = message ? `: ${message}` : '';
      showNotification(`${t('system_info.version_check_error')}${suffix}`, 'error');
    } finally {
      setCheckingApiVersion(false);
    }
  }, [
    apiVersion,
    showNotification,
    t,
    featureAvailability.checking,
    hostUpgrades.enabled,
    hostUpgrades.resolved,
    startVersionCheck,
  ]);

  const appReleaseUrl = useMemo(
    () => buildDashboardVersionReleaseURL('manager', managerVersion),
    [managerVersion]
  );
  const apiReleaseUrl = useMemo(
    () => buildDashboardVersionReleaseURL('core', displayedApiVersion),
    [displayedApiVersion]
  );
  const latestApiReleaseUrl = useMemo(
    () => buildDashboardVersionReleaseURL('core', latestApi),
    [latestApi]
  );
  const managerUpdateAvailable =
    !hostUpgrades.enabled &&
    featureAvailability.managerServiceAvailable &&
    updates.available &&
    !updates.error &&
    !updates.status?.last_error &&
    !updates.status?.stale &&
    updates.status?.state === 'update_available' &&
    !!updates.status.target;
  const apiBadge = useMemo(
    () =>
      renderBadge(
        hostUpgrades.enabled
          ? compareUpstreamVersions(latestApi, displayedApiVersion)
          : compareVersions(latestApi, apiVersion),
        latestApi,
        latestApiReleaseUrl,
        t
      ),
    [apiVersion, displayedApiVersion, latestApi, latestApiReleaseUrl, t, hostUpgrades.enabled]
  );
  const externalReleaseUrl = useMemo(
    () =>
      externalStableVersion
        ? buildDashboardVersionReleaseURL('manager', externalStableVersion)
        : '',
    [externalStableVersion]
  );
  const externalBadge = useMemo(() => {
    if (!externalManagerUpdateFallback || !externalStableVersion || externalStableError) {
      return null;
    }
    return renderBadge(
      compareVersions(externalStableVersion, appVersion),
      externalStableVersion,
      externalReleaseUrl,
      t
    );
  }, [
    externalManagerUpdateFallback,
    externalStableVersion,
    externalStableError,
    appVersion,
    externalReleaseUrl,
    t,
  ]);
  const hostManagerLatest = hostUpgrades.catalog?.latest.manager || '';
  const hostManagerBadge = hostUpgrades.enabled
    ? renderBadge(
        compareUpstreamVersions(hostManagerLatest, managerVersion),
        hostManagerLatest,
        buildDashboardVersionReleaseURL('manager', hostManagerLatest),
        t
      )
    : null;

  const buildTimeDisplay = serverBuildDate
    ? new Date(serverBuildDate).toLocaleString(i18n.language)
    : t('dashboard.version_unknown');

  const collector = collectorStatus?.collector;
  const collectorLastError = collector?.lastError?.trim() || '';
  const usageState: HealthItem = usageEnabled
    ? usageError
      ? {
          label: t('dashboard.health_usage_monitor'),
          value: t('dashboard.health_status_problem'),
          tone: 'error',
          icon: <IconInfo size={16} />,
        }
      : {
          label: t('dashboard.health_usage_monitor'),
          value: usageLoading ? '...' : t('dashboard.health_status_normal'),
          tone: usageLoading ? 'muted' : 'ok',
          icon: <IconCheck size={16} />,
        }
    : {
        label: t('dashboard.health_usage_monitor'),
        value: t('dashboard.health_status_disabled'),
        tone: 'muted',
        icon: <IconInfo size={16} />,
      };

  const collectorState: HealthItem = !usageEnabled
    ? {
        label: t('dashboard.collector_status_title'),
        value: t('dashboard.health_status_disabled'),
        tone: 'muted',
        icon: <IconInfo size={16} />,
      }
    : collectorError
      ? {
          label: t('dashboard.collector_status_title'),
          value: t('dashboard.collector_unavailable'),
          tone: 'error',
          icon: <IconInfo size={16} />,
        }
      : collectorLastError
        ? {
            label: t('dashboard.collector_status_title'),
            value: t('dashboard.health_status_warning'),
            tone: 'warn',
            icon: <IconInfo size={16} />,
          }
        : {
            label: t('dashboard.collector_status_title'),
            value:
              collectorLoading && !collectorStatus ? '...' : t('dashboard.health_status_normal'),
            tone: collectorLoading && !collectorStatus ? 'muted' : 'ok',
            icon: <IconCheck size={16} />,
          };

  const queueState: HealthItem = !usageEnabled
    ? {
        label: t('dashboard.health_queue_status'),
        value: t('dashboard.health_status_disabled'),
        tone: 'muted',
        icon: <IconInfo size={16} />,
      }
    : collectorError
      ? {
          label: t('dashboard.health_queue_status'),
          value: t('dashboard.collector_unavailable'),
          tone: 'error',
          icon: <IconInfo size={16} />,
        }
      : {
          label: t('dashboard.health_queue_status'),
          value:
            collector?.queue ||
            (collectorLoading && !collectorStatus ? '...' : t('dashboard.health_status_normal')),
          tone: collectorLoading && !collectorStatus ? 'muted' : 'ok',
          icon: <IconCheck size={16} />,
        };

  const errorLogState: HealthItem = {
    label: t('dashboard.health_error_logs'),
    value: errorLogsLoading
      ? '...'
      : errorLogCount > 0
        ? t('dashboard.health_error_log_count', { count: errorLogCount })
        : t('dashboard.health_status_normal'),
    tone: errorLogsLoading ? 'muted' : errorLogCount > 0 ? 'warn' : 'ok',
    icon: errorLogCount > 0 ? <IconInfo size={16} /> : <IconCheck size={16} />,
    to: '/logs?tab=errors',
  };

  const healthItems = [usageState, collectorState, queueState, errorLogState];

  return (
    <div className={styles.container}>
      <section className={styles.section}>
        <h2 className={styles.heading}>{t('dashboard.system_overview')}</h2>
        <div className={`${styles.grid} ${styles.systemGrid}`}>
          <div className={styles.item}>
            <div className={styles.icon}>
              <IconSettings size={18} />
            </div>
            <div className={styles.content}>
              <div className={styles.versionHeader}>
                <div
                  className={styles.label}
                  title={t(
                    updates.status?.current_version
                      ? 'manager_updates.server_version'
                      : 'dashboard.app_version'
                  )}
                >
                  {t('title.abbr')}
                </div>
                {(hostUpgrades.enabled || externalManagerUpdateFallback) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    iconOnly
                    className={styles.versionAction}
                    onClick={() =>
                      void (hostUpgrades.enabled
                        ? updateCheck.start()
                        : handleExternalManagerCheck())
                    }
                    loading={hostUpgrades.enabled ? updateCheck.checking : checkingManagerVersion}
                    disabled={hostUpgrades.enabled && !updateCheck.canCheck}
                    title={t(
                      hostUpgrades.enabled
                        ? 'host_upgrades.check_both'
                        : 'system_info.version_check_button'
                    )}
                    aria-label={t('system_info.version_check_button')}
                  >
                    {!(hostUpgrades.enabled ? updateCheck.checking : checkingManagerVersion) && (
                      <IconRefreshCw size={14} />
                    )}
                  </Button>
                )}
                {managerUpdateAvailable && (
                  <Link
                    to="/system/updates"
                    className={`${styles.badge} ${styles.managerUpdateBadge}`}
                    title={t('manager_updates.view_version', {
                      version: updates.status?.target?.release.version,
                    })}
                    aria-label={t('manager_updates.view_version', {
                      version: updates.status?.target?.release.version,
                    })}
                  >
                    {t('manager_updates.available_badge')}
                    <IconChevronRight size={12} aria-hidden="true" />
                  </Link>
                )}
              </div>
              <div className={styles.valueWrap}>
                {renderVersionValue(
                  managerVersion || t('dashboard.version_unknown'),
                  appReleaseUrl
                )}
                {renderBadgeValue(externalBadge)}
                {renderBadgeValue(hostManagerBadge)}
              </div>
              <HostUpgradeAction
                component="manager"
                upgrades={hostUpgrades}
                onSelect={setSelectedUpgrade}
              />
            </div>
          </div>

          <div className={styles.item}>
            <div className={styles.icon}>
              <IconSatellite size={18} />
            </div>
            <div className={styles.content}>
              <div className={styles.versionHeader}>
                <div className={styles.label}>{t('dashboard.api_version')}</div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  iconOnly
                  className={styles.versionAction}
                  onClick={() => void handleApiVersionCheck()}
                  loading={checkingApiVersion || updateCheck.checking}
                  disabled={
                    featureAvailability.checking ||
                    !hostUpgrades.resolved ||
                    (hostUpgrades.enabled && !updateCheck.canCheck)
                  }
                  title={t(
                    hostUpgrades.enabled
                      ? 'host_upgrades.check_both'
                      : 'system_info.version_check_button'
                  )}
                  aria-label={t('system_info.version_check_button')}
                >
                  {!checkingApiVersion && !updateCheck.checking && <IconRefreshCw size={14} />}
                </Button>
              </div>
              <div className={styles.valueWrap}>
                {renderVersionValue(
                  displayedApiVersion || t('dashboard.version_unknown'),
                  apiReleaseUrl
                )}
                {renderBadgeValue(apiBadge)}
              </div>
              <HostUpgradeAction
                component="cli"
                upgrades={hostUpgrades}
                onSelect={setSelectedUpgrade}
              />
            </div>
          </div>

          <div className={styles.item}>
            <div className={styles.icon}>
              <IconTimer size={18} />
            </div>
            <div className={styles.content}>
              <div className={styles.label}>{t('dashboard.build_time')}</div>
              <div className={styles.value}>{buildTimeDisplay}</div>
            </div>
          </div>

          <div className={styles.item}>
            <div className={styles.icon}>
              <IconExternalLink size={18} />
            </div>
            <div className={styles.content}>
              <div className={styles.label}>{t('dashboard.cpa_base')}</div>
              <div className={styles.value}>{cpaBase || '-'}</div>
            </div>
          </div>
        </div>
        {hostUpgrades.enabled && (
          <p className={styles.manualCheck} role="status" aria-live="polite">
            {t('host_upgrades.manual_checks')}
            {' · '}
            {t(
              updateCheck.error
                ? 'host_upgrades.check_request_error'
                : updateCheck.checking
                  ? 'host_upgrades.check_running'
                  : updateCheck.check
                    ? `host_upgrades.check_${updateCheck.check.state}`
                    : 'host_upgrades.check_not_started'
            )}
            {updateCheck.check &&
              !updateCheck.checking &&
              !updateCheck.error &&
              ` (${new Date(updateCheck.check.updatedAt).toLocaleString(i18n.language)})`}
          </p>
        )}
        <HostUpgradeStatus upgrades={hostUpgrades} />
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>{t('dashboard.health_status')}</h2>
        <div className={`${styles.grid} ${styles.healthGrid}`}>
          {healthItems.map((item) => {
            const content = (
              <>
                <div className={`${styles.healthIcon} ${styles[item.tone]}`}>{item.icon}</div>
                <div className={styles.content}>
                  <div className={styles.label}>{item.label}</div>
                  <div className={`${styles.value} ${styles[`${item.tone}Text`]}`}>
                    {item.value}
                  </div>
                </div>
              </>
            );

            return item.to ? (
              <Link
                key={item.label}
                to={item.to}
                className={`${styles.healthItem} ${styles.healthLink}`}
              >
                {content}
              </Link>
            ) : (
              <div key={item.label} className={styles.healthItem}>
                {content}
              </div>
            );
          })}
        </div>
      </section>
      <HostUpgradeConfirmation
        release={selectedUpgrade}
        upgrades={hostUpgrades}
        onClose={() => setSelectedUpgrade(null)}
      />
    </div>
  );
}
