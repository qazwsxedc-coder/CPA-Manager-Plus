import { useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHostUpdateCheck } from './useHostUpdateCheck';
import type { HostUpdateCheck } from './hostUpgradeModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ currentCheck: vi.fn(), check: vi.fn() }));
vi.mock('./hostUpgradeApi', () => ({ hostUpgradeApi: mocks }));
vi.mock('@/stores', () => ({
  useAuthStore: (select: (value: unknown) => unknown) =>
    select({ managementKey: 'test-admin', isAuthenticated: true }),
}));
vi.mock('@/features/demo/demoMode', () => ({ isDemoMode: () => false }));
vi.mock('@/services/api/usageService', () => ({
  normalizeUsageServiceBase: (base: string) => base.replace(/\/+$/, ''),
}));
const job = (id: string, state: HostUpdateCheck['state'] = 'queued'): HostUpdateCheck => ({
  schemaVersion: 1,
  id,
  state,
  createdAt: '2026-09-24T00:00:00Z',
  updatedAt: '2026-09-24T00:00:01Z',
  message: 'Checking official versions',
});
let renderer: ReactTestRenderer | null;
let controls: ReturnType<typeof useHostUpdateCheck>;
let current: HostUpdateCheck | null;
function Harness({
  base = 'http://manager.test',
  allowed = true,
}: {
  base?: string;
  allowed?: boolean;
}) {
  const value = useHostUpdateCheck(base, true, allowed);
  useLayoutEffect(() => {
    controls = value;
  }, [value]);
  return null;
}
async function mount() {
  await act(async () => {
    renderer = create(<Harness />);
  });
}
async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  });
  current = null;
  mocks.currentCheck.mockImplementation(async () => current);
  mocks.check.mockImplementation(async (_base, _key, id: string) => (current = job(id)));
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('manual host version checks', () => {
  it('mounts, polls and reloads without starting a version query', async () => {
    await mount();
    await poll();
    await act(async () => renderer?.unmount());
    await mount();
    expect(controls.canCheck).toBe(true);
    expect(controls.check).toBeNull();
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it('submits one UUID on click and rejects repeated clicks while queued', async () => {
    await mount();
    await act(async () => {
      await Promise.all([controls.start(), controls.start()]);
    });
    expect(controls.check?.state).toBe('queued');
    expect(controls.canCheck).toBe(false);
    await act(async () => controls.start());
    await poll();
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(mocks.check).toHaveBeenCalledWith(
      'http://manager.test',
      'test-admin',
      expect.stringMatching(/^[0-9a-f-]{36}$/)
    );
  });
  it('reconnects to an accepted request after a lost POST response without resubmitting', async () => {
    mocks.check.mockImplementation(async (_base, _key, id: string) => {
      current = job(id, 'running');
      throw new Error('connection interrupted');
    });
    await mount();
    await act(async () => controls.start());
    expect(controls.check?.state).toBe('running');
    expect(controls.error).toBe(false);
    await poll();
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });
  it('retains an unconfirmed-request error when the host still reports an old success', async () => {
    current = job('old', 'succeeded');
    mocks.check.mockRejectedValue(new Error('offline'));
    await mount();
    await act(async () => controls.start());
    await poll();
    expect(controls.error).toBe(true);
    expect(mocks.check).toHaveBeenCalledTimes(1);
  });
  it('restores running and failed results after remount without a new query', async () => {
    current = job('restored', 'running');
    await mount();
    expect(controls.checking).toBe(true);
    current = job('restored', 'failed');
    await poll();
    expect(controls.check?.state).toBe('failed');
    expect(controls.canCheck).toBe(true);
    await act(async () => renderer?.unmount());
    await mount();
    expect(controls.check?.state).toBe('failed');
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it('ignores an older read that finishes after a manual request is accepted', async () => {
    await mount();
    let finish!: (value: HostUpdateCheck | null) => void;
    mocks.currentCheck.mockReturnValueOnce(
      new Promise<HostUpdateCheck | null>((resolve) => {
        finish = resolve;
      })
    );
    await poll();
    await act(async () => controls.start());
    await act(async () => finish(null));
    expect(controls.check?.state).toBe('queued');
    await poll();
    expect(controls.check?.state).toBe('queued');
  });
  it('blocks manual submissions when the executor cannot accept work', async () => {
    await act(async () => {
      renderer = create(<Harness allowed={false} />);
    });
    await act(async () => controls.start());
    expect(controls.canCheck).toBe(false);
    expect(mocks.check).not.toHaveBeenCalled();
  });
});
