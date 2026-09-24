import { compareVersions } from '@/utils/version';

export type UpgradeComponent = 'cli' | 'manager';
export type UpgradeState =
  | 'queued'
  | 'preflight'
  | 'backup'
  | 'installing'
  | 'checking'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'
  | 'manual_recovery';

export interface HostUpgradeRelease {
  releaseId: string;
  component: UpgradeComponent;
  version: string;
  imageTag: string;
  imageSource?: 'official' | 'custom';
  imageDigest?: string;
  imageId: string;
  allowedFromImageIds: string[];
  migrationRequired: boolean;
  migrationMode?: 'none' | 'automatic-additive';
  rollbackDataCompatible?: boolean;
}

export interface HostUpgradeJob {
  schemaVersion: 1;
  id: string;
  component: UpgradeComponent;
  releaseId: string;
  state: UpgradeState;
  step: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  fromVersion?: string;
  toVersion?: string;
  backupPath?: string;
  errorCode?: string;
}

export interface HostUpgradeCatalog {
  enabled: boolean;
  executorOnline: boolean;
  current: Record<UpgradeComponent, { version: string; imageId: string }>;
  latest: Record<UpgradeComponent, string>;
  releases: HostUpgradeRelease[];
  activeJob?: HostUpgradeJob | null;
}

// Local packaging revisions do not change the upstream release comparison.
export const compareUpstreamVersions = (latest: string, current: string) =>
  compareVersions(latest.replace(/-custom\.\d+$/i, ''), current.replace(/-custom\.\d+$/i, ''));

export const hasAutomaticMigration = (release: HostUpgradeRelease) =>
  release.component === 'manager' &&
  release.migrationRequired === true &&
  release.migrationMode === 'automatic-additive' &&
  release.rollbackDataCompatible === false;

// Confirmation describes this exact image and migration policy. A refreshed
// manifest with the same release ID must not silently change that consent.
export const samePreparedRelease = (a: HostUpgradeRelease, b: HostUpgradeRelease | null) =>
  !!b &&
  a.releaseId === b.releaseId &&
  a.component === b.component &&
  a.version === b.version &&
  a.imageId === b.imageId &&
  a.imageTag === b.imageTag &&
  (a.imageSource || 'custom') === (b.imageSource || 'custom') &&
  (a.imageDigest || '') === (b.imageDigest || '') &&
  a.migrationRequired === b.migrationRequired &&
  (a.migrationMode || 'none') === (b.migrationMode || 'none') &&
  a.rollbackDataCompatible === b.rollbackDataCompatible;

export function selectPreparedRelease(
  catalog: HostUpgradeCatalog | null,
  component: UpgradeComponent
): HostUpgradeRelease | null {
  const imageId = catalog?.current[component]?.imageId;
  if (!imageId) return null;
  return (
    (catalog?.releases || [])
      .filter(
        (release) =>
          release.component === component &&
          ((release.migrationRequired === false &&
            (!release.migrationMode || release.migrationMode === 'none')) ||
            hasAutomaticMigration(release)) &&
          !!release.imageId &&
          release.imageId !== imageId &&
          release.allowedFromImageIds?.includes(imageId)
      )
      .sort((a, b) => {
        const upstream = compareUpstreamVersions(b.version, a.version) || 0;
        if (upstream) return upstream;
        if (component === 'cli') {
          const official =
            Number(b.imageSource === 'official') - Number(a.imageSource === 'official');
          if (official) return official;
        }
        return compareVersions(b.version, a.version) || 0;
      })[0] || null
  );
}

export const isUpgradeRunning = (job: HostUpgradeJob | null | undefined) =>
  !!job && ['queued', 'preflight', 'backup', 'installing', 'checking'].includes(job.state);

export const upgradeStorageKey = (base: string) =>
  `cpamp:host-upgrade:v1:${base.trim().replace(/\/+$/, '')}`;
