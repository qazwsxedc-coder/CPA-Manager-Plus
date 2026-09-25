import { describe, expect, it } from 'vitest';
import {
  compareUpstreamVersions,
  selectPreparedRelease,
  samePreparedRelease,
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
  it('offers the detected CLI target before download when the host advertises support', () => {
    const offer = {
      ...release,
      releaseId: 'prepare-cli-v7.3.17',
      version: 'v7.3.17',
      imageId: '',
      prepareRequired: true,
    };
    expect(selectPreparedRelease({ ...catalog, releases: [], offers: [offer] }, 'cli')).toEqual(
      offer
    );
  });
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
  it('prefers an official CLI image over a custom revision of the same upstream version', () => {
    const custom = { ...release, version: 'v7.3.16-custom.9' };
    const official = {
      ...release,
      releaseId: 'cli-7.3.16-official',
      version: 'v7.3.16',
      imageSource: 'official' as const,
      imageTag: 'eceasy/cli-proxy-api:v7.3.16',
      imageDigest: `eceasy/cli-proxy-api@sha256:${'d'.repeat(64)}`,
    };
    expect(selectPreparedRelease({ ...catalog, releases: [custom, official] }, 'cli')).toEqual(
      official
    );
    const newer = { ...custom, releaseId: 'newer-custom', version: 'v7.3.17-custom.1' };
    expect(selectPreparedRelease({ ...catalog, releases: [official, newer] }, 'cli')).toEqual(
      newer
    );
  });
  it('allows an explicitly prepared additive Manager migration without promising data rollback', () => {
    const manager = {
      ...release,
      component: 'manager' as const,
      allowedFromImageIds: ['sha256:manager'],
      migrationRequired: true,
      migrationMode: 'automatic-additive' as const,
      rollbackDataCompatible: false,
    };
    expect(selectPreparedRelease({ ...catalog, releases: [manager] }, 'manager')).toEqual(manager);
    expect(
      selectPreparedRelease(
        { ...catalog, releases: [{ ...manager, rollbackDataCompatible: true }] },
        'manager'
      )
    ).toBeNull();
    expect(
      selectPreparedRelease(
        { ...catalog, releases: [{ ...manager, migrationRequired: false }] },
        'manager'
      )
    ).toBeNull();
  });
  it('still rejects CLI migration and legacy migrations without an explicit mode', () => {
    const cli = {
      ...release,
      migrationRequired: true,
      migrationMode: 'automatic-additive' as const,
      rollbackDataCompatible: false,
    };
    expect(selectPreparedRelease({ ...catalog, releases: [cli] }, 'cli')).toBeNull();
    const manager = {
      ...release,
      component: 'manager' as const,
      allowedFromImageIds: ['sha256:manager'],
      migrationRequired: true,
    };
    expect(selectPreparedRelease({ ...catalog, releases: [manager] }, 'manager')).toBeNull();
  });
  it('invalidates a confirmation when the same release ID changes image or migration policy', () => {
    expect(
      samePreparedRelease(release, { ...release, imageSource: 'custom', migrationMode: 'none' })
    ).toBe(true);
    expect(samePreparedRelease(release, { ...release, imageId: 'sha256:changed' })).toBe(false);
    expect(samePreparedRelease(release, { ...release, migrationRequired: true })).toBe(false);
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
