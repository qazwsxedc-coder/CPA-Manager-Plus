import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHostUpgrades } from './useHostUpgrades';
import type { HostUpgradeCatalog, HostUpgradeJob, HostUpgradeRelease } from './hostUpgradeModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ releases: vi.fn(), job: vi.fn(), submit: vi.fn() }));
vi.mock('./hostUpgradeApi', () => ({ hostUpgradeApi: mocks }));
vi.mock('@/stores', () => ({
  useAuthStore: (select: (value: unknown) => unknown) =>
    select({ managementKey: 'test-admin', isAuthenticated: true }),
}));
vi.mock('@/features/demo/demoMode', () => ({ isDemoMode: () => false }));
vi.mock('@/services/api/usageService', () => ({
  normalizeUsageServiceBase: (base: string) => base.replace(/\/+$/, ''),
}));

const release: HostUpgradeRelease = {
  releaseId: 'manager-v1.13.3-custom.1',
  component: 'manager',
  version: 'v1.13.3-custom.1',
  imageTag: 'local/manager:v1.13.3-custom.1',
  imageId: 'sha256:new',
  allowedFromImageIds: ['sha256:old'],
  migrationRequired: false,
};
const initialCatalog: HostUpgradeCatalog = {
  enabled: true,
  executorOnline: true,
  current: {
    cli: { version: 'v7.3.15-custom.1', imageId: 'sha256:cli' },
    manager: { version: 'v1.13.2-custom.1', imageId: 'sha256:old' },
  },
  latest: { cli: 'v7.3.15', manager: 'v1.13.3' },
  releases: [release],
};
let catalog: HostUpgradeCatalog;
let renderer: ReactTestRenderer | null;
let controls: ReturnType<typeof useHostUpgrades>;
const makeJob = (id: string, state: HostUpgradeJob['state'] = 'installing'): HostUpgradeJob => ({
  schemaVersion: 1,
  id,
  component: 'manager',
  releaseId: release.releaseId,
  state,
  step: 'manager',
  message: '',
  createdAt: '2026-09-24T00:00:00Z',
  updatedAt: '2026-09-24T00:00:01Z',
});
function Harness({ base = 'http://manager.test' }: { base?: string }) {
  const value = useHostUpgrades(base, true);
  useLayoutEffect(() => {
    controls = value;
  }, [value]);
  return null;
}
async function mount(base?: string) {
  await act(async () => {
    renderer = create(<Harness base={base} />);
  });
}
async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('window', {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  catalog = structuredClone(initialCatalog);
  mocks.releases.mockImplementation(async () => catalog);
  mocks.submit.mockImplementation(async (_base, _key, intent) => makeJob(intent.requestId));
  mocks.job.mockImplementation(async (_base, _key, id) => makeJob(id));
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('host upgrade tracking', () => {
  it('waits for the host lock to clear before dismissing a terminal active job', async () => {
    catalog.activeJob = makeJob('12345678-1234-1234-1234-123456789abc', 'succeeded');
    mocks.job.mockResolvedValue(catalog.activeJob);
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(controls.job?.state).toBe('succeeded');
    expect(controls.busy).toBe(true);
    catalog = { ...catalog, activeJob: null };
    await act(async () => {
      await controls.refresh();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(controls.pending).toBeNull();
    expect(controls.busy).toBe(false);
    await poll();
    expect(controls.job).toBeNull();
  });
  it('preserves the result and reports storage failure if dismissal cannot be persisted', async () => {
    await mount();
    await act(async () => {
      await controls.start(release);
    });
    mocks.job.mockResolvedValue(makeJob(controls.job!.id, 'succeeded'));
    await act(async () => {
      await controls.refresh();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('storage disabled');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(controls.job?.state).toBe('succeeded');
    expect(controls.error).toBe('storage');
  });
  it('shows success for five seconds, then clears it across polls and page refresh', async () => {
    await mount();
    await act(async () => {
      await controls.start(release);
    });
    const id = controls.job!.id;
    mocks.job.mockResolvedValue(makeJob(id, 'succeeded'));
    await act(async () => {
      await controls.refresh();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(controls.job?.state).toBe('succeeded');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(controls.job).toBeNull();
    expect(controls.pending).toBeNull();
    expect(
      JSON.parse(localStorage.getItem('cpamp:host-upgrade:v1:http://manager.test')!).pending
    ).toBeUndefined();
    await poll();
    expect(controls.job).toBeNull();
    await act(async () => renderer?.unmount());
    renderer = null;
    await mount();
    expect(controls.job).toBeNull();
  });
  it('does not restore a dismissed success from a poll already in flight', async () => {
    await mount();
    await act(async () => {
      await controls.start(release);
    });
    const id = controls.job!.id;
    mocks.job.mockResolvedValue(makeJob(id, 'succeeded'));
    await act(async () => {
      await controls.refresh();
    });
    let finishJob!: (job: HostUpgradeJob) => void;
    mocks.job.mockReturnValueOnce(
      new Promise<HostUpgradeJob>((resolve) => {
        finishJob = resolve;
      })
    );
    await poll();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(controls.job).toBeNull();
    await act(async () => {
      finishJob(makeJob(id, 'succeeded'));
    });
    expect(controls.pending).toBeNull();
  });
  it.each(['failed', 'rolled_back', 'manual_recovery'] as const)(
    'keeps %s visible without a dismissal timer',
    async (jobState) => {
      await mount();
      await act(async () => {
        await controls.start(release);
      });
      const id = controls.job!.id;
      mocks.job.mockResolvedValue(makeJob(id, jobState));
      await act(async () => {
        await controls.refresh();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(controls.job?.state).toBe(jobState);
    }
  );
  it('does not clear a newer upgrade when the previous success timer would expire', async () => {
    await mount();
    await act(async () => {
      await controls.start(release);
    });
    const firstId = controls.job!.id;
    mocks.job.mockResolvedValue(makeJob(firstId, 'succeeded'));
    await act(async () => {
      await controls.refresh();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await act(async () => {
      await controls.start(release);
    });
    const secondId = controls.job!.id;
    mocks.job.mockResolvedValue(makeJob(secondId));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(secondId).not.toBe(firstId);
    expect(controls.job?.id).toBe(secondId);
    expect(controls.job?.state).toBe('installing');
  });
  it('requires a fresh confirmation if the same prepared release gains a migration', async () => {
    await mount();
    catalog.releases = [
      {
        ...release,
        migrationRequired: true,
        migrationMode: 'automatic-additive',
        rollbackDataCompatible: false,
      },
    ];
    await act(async () => {
      await controls.refresh();
    });
    await act(async () => {
      await controls.start(release);
    });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(controls.pending).toBeNull();
  });
  it('accepts confirmation during a background poll and ignores its stale response', async () => {
    await mount();
    let finishPoll!: (value: HostUpgradeCatalog) => void;
    mocks.releases.mockReturnValueOnce(
      new Promise<HostUpgradeCatalog>((resolve) => {
        finishPoll = resolve;
      })
    );
    await act(async () => {
      void controls.refresh();
    });
    await act(async () => {
      await controls.start(release);
    });
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    const id = controls.job!.id;
    await act(async () => {
      finishPoll(catalog);
    });
    expect(controls.job?.id).toBe(id);
    expect(controls.busy).toBe(true);
  });
  it.each([400, 404, 409, 422])(
    'clears a definitively rejected HTTP %s intent without resubmitting it',
    async (status) => {
      await mount();
      mocks.submit.mockRejectedValueOnce({ response: { status } });
      await act(async () => {
        await controls.start(release);
      });
      expect(controls.pending).toBeNull();
      expect(controls.error).toBe('rejected');
      expect(controls.rejectionStatus).toBe(status);
      expect(controls.reconnecting).toBe(false);
      await poll();
      expect(mocks.submit).toHaveBeenCalledTimes(1);
      expect(controls.busy).toBe(false);
    }
  );
  it('deduplicates rapid confirmation and persists the UUID before submission', async () => {
    await mount();
    await act(async () => {
      await Promise.all([controls.start(release), controls.start(release)]);
    });
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(controls.busy).toBe(true);
    expect(localStorage.getItem('cpamp:host-upgrade:v1:http://manager.test')).toContain(
      controls.job!.id
    );
    expect(localStorage.getItem('cpamp:host-upgrade:v1:http://manager.test')).not.toContain(
      'test-admin'
    );
  });
  it('keeps Manager self-upgrade running through disconnect, then reconnects to success', async () => {
    await mount();
    await act(async () => {
      await controls.start(release);
    });
    const id = controls.job!.id;
    mocks.releases.mockRejectedValueOnce(new Error('network disconnected'));
    await poll();
    expect(controls.job?.state).toBe('installing');
    expect(controls.reconnecting).toBe(true);
    expect(controls.busy).toBe(true);
    mocks.job.mockResolvedValueOnce({
      ...makeJob(id, 'succeeded'),
      backupPath: 'C:\\backups\\upgrade-1',
    });
    await poll();
    expect(controls.job?.state).toBe('succeeded');
    expect(controls.reconnecting).toBe(false);
    expect(controls.busy).toBe(false);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });
  it('resumes the same accepted task across refresh without resubmitting', async () => {
    await mount();
    await act(async () => {
      await controls.start(release);
    });
    const id = controls.job!.id;
    await act(async () => renderer?.unmount());
    renderer = null;
    await mount();
    expect(mocks.job).toHaveBeenLastCalledWith('http://manager.test', 'test-admin', id);
    expect(controls.job?.id).toBe(id);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });
  it('can read a durable job while the release catalog is temporarily unavailable', async () => {
    await mount();
    await act(async () => {
      await controls.start(release);
    });
    const id = controls.job!.id;
    mocks.releases.mockRejectedValueOnce({ response: { status: 503 } });
    mocks.job.mockResolvedValueOnce(makeJob(id, 'checking'));
    await poll();
    expect(controls.job?.state).toBe('checking');
    expect(controls.reconnecting).toBe(true);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });
  it('keeps tracking an accepted task while a restarting Manager temporarily disables upgrades', async () => {
    await mount();
    await act(async () => {
      await controls.start(release);
    });
    const id = controls.job!.id;
    catalog = { ...catalog, enabled: false };
    mocks.job.mockRejectedValueOnce({ response: { status: 503 } });
    await poll();
    expect(controls.enabled).toBe(true);
    expect(controls.reconnecting).toBe(true);
    expect(controls.busy).toBe(true);
    catalog = { ...catalog, enabled: true };
    mocks.job.mockResolvedValueOnce(makeJob(id, 'succeeded'));
    await poll();
    expect(controls.job?.state).toBe('succeeded');
    expect(controls.reconnecting).toBe(false);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });
  it('retries a lost submission response with the same UUID after refresh', async () => {
    await mount();
    mocks.submit.mockRejectedValueOnce(new Error('lost response'));
    await act(async () => {
      await controls.start(release);
    });
    const first = mocks.submit.mock.calls[0][2];
    expect(controls.busy).toBe(true);
    expect(controls.job).toBeNull();
    await act(async () => renderer?.unmount());
    renderer = null;
    mocks.job.mockRejectedValueOnce({ response: { status: 404 } });
    await mount();
    expect(mocks.submit.mock.calls[1][2]).toEqual(first);
    expect(controls.job?.id).toBe(first.requestId);
  });
  it('also clears a definite rejection after retrying an uncertain POST', async () => {
    await mount();
    mocks.submit.mockRejectedValueOnce(new Error('lost response'));
    await act(async () => {
      await controls.start(release);
    });
    mocks.job.mockRejectedValueOnce({ response: { status: 404 } });
    mocks.submit.mockRejectedValueOnce({ response: { status: 400 } });
    await poll();
    expect(controls.pending).toBeNull();
    expect(controls.error).toBe('rejected');
    await poll();
    expect(mocks.submit).toHaveBeenCalledTimes(2);
  });
  it('keeps another Manager base independent', async () => {
    await mount();
    await act(async () => {
      await controls.start(release);
    });
    await act(async () => renderer?.update(<Harness base="http://other-manager.test" />));
    expect(controls.pending).toBeNull();
    expect(controls.busy).toBe(false);
  });
  it('adopts the global host task and keeps manual recovery locked', async () => {
    catalog.activeJob = makeJob('12345678-1234-1234-1234-123456789abc', 'manual_recovery');
    mocks.job.mockResolvedValue(catalog.activeJob);
    await mount();
    expect(controls.job?.state).toBe('manual_recovery');
    expect(controls.busy).toBe(true);
    await act(async () => {
      await controls.start(release);
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('adopts an existing host task after a conflict instead of retrying a new submission', async () => {
    await mount();
    mocks.submit.mockRejectedValueOnce({ response: { status: 409 } });
    await act(async () => {
      await controls.start(release);
    });
    catalog.activeJob = makeJob('12345678-1234-1234-1234-123456789abc');
    mocks.job.mockResolvedValue(catalog.activeJob);
    await poll();
    expect(controls.job?.id).toBe(catalog.activeJob.id);
    expect(controls.busy).toBe(true);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });
  it('does not submit if the new task cannot be persisted before the request', async () => {
    await mount();
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('storage disabled');
    });
    await act(async () => {
      await controls.start(release);
    });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(controls.error).toBe('storage');
    expect(controls.pending).toBeNull();
  });
  it('disables submission while the host executor is unavailable', async () => {
    catalog.executorOnline = false;
    await mount();
    expect(controls.canStart).toBe(false);
    await act(async () => {
      await controls.start(release);
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
