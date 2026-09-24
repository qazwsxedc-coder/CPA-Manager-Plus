import { describe, expect, it } from 'vitest';
import {
  compareUpstreamVersions,
  selectPreparedRelease,
  upgradeStorageKey,
  type HostUpgradeCatalog,
  type HostUpgradeRelease,
} from './hostUpgradeModel';

export const release: HostUpgradeRelease = {
  releaseId: 'cli-7.3.16-custom.1',
  component: 'cli',
  version: 'v7.3.16-custom.1',
  imageTag: 'local/cli:v7.3.16-custom.1',
  imageId: 'sha256:new',
  allowedFromImageIds: ['sha256:installed'],
  migrationRequired: false,
};
export const catalog: HostUpgradeCatalog = {
  enabled: true,
  executorOnline: true,
  current: {
    cli: { version: 'v7.3.15-custom.1', imageId: 'sha256:installed' },
    manager: { version: 'v1.13.2-custom.1', imageId: 'sha256:manager' },
  },
  latest: { cli: 'v7.3.16', manager: 'v1.13.2' },
  releases: [release],
};

describe('prepared host upgrade eligibility', () => {
  it('offers only a different, prepared image compatible with the installed image', () => {
    expect(selectPreparedRelease(catalog, 'cli')?.releaseId).toBe(release.releaseId);
    expect(selectPreparedRelease(catalog, 'manager')).toBeNull();
  });
  it.each([
    { imageId: 'sha256:installed' },
    { allowedFromImageIds: ['sha256:other'] },
    { migrationRequired: true },
    { component: 'manager' as const },
  ])('rejects an incompatible manifest: %o', (change) => {
    expect(
      selectPreparedRelease({ ...catalog, releases: [{ ...release, ...change }] }, 'cli')
    ).toBeNull();
  });
  it('selects the highest eligible version without modifying its display version', () => {
    const newer = { ...release, releaseId: 'newer', version: 'v7.3.17-custom.2' };
    expect(selectPreparedRelease({ ...catalog, releases: [release, newer] }, 'cli')).toEqual(newer);
  });
  it('ignores only the custom suffix when comparing upstream versions', () => {
    expect(compareUpstreamVersions('v7.3.15', 'v7.3.15-custom.1')).toBe(0);
    expect(compareUpstreamVersions('v7.3.16', 'v7.3.15-custom.9')).toBe(1);
  });
  it('isolates saved tasks by Manager base', () => {
    expect(upgradeStorageKey('http://localhost:18317/')).toBe(
      upgradeStorageKey('http://localhost:18317')
    );
    expect(upgradeStorageKey('http://localhost:18317')).not.toBe(
      upgradeStorageKey('http://localhost:18318')
    );
  });
});
