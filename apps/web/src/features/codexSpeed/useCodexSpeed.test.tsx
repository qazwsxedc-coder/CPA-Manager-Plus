import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateCodexSpeedConfig } from './config';

const initial = 'port: 8317\n';
const mocks = vi.hoisted(() => ({
  auth: {
    apiBase: 'http://first.local:8317',
    managementKey: 'first-test-key',
    connectionStatus: 'connected',
  },
  listeners: new Set<() => void>(),
  read: vi.fn(),
  write: vi.fn(),
  clearCache: vi.fn(),
  fetchConfig: vi.fn(),
}));
vi.mock('@/services/api/configFile', () => ({
  configFileApi: { fetchConfigYaml: mocks.read, saveConfigYaml: mocks.write },
}));
vi.mock('@/stores', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useAuthStore: Object.assign(
      (selector: (state: typeof mocks.auth) => unknown) =>
        useSyncExternalStore(
          (listener) => {
            mocks.listeners.add(listener);
            return () => {
              mocks.listeners.delete(listener);
            };
          },
          () => selector(mocks.auth)
        ),
      { getState: () => mocks.auth }
    ),
    useConfigStore: {
      getState: () => ({ clearCache: mocks.clearCache, fetchConfig: mocks.fetchConfig }),
    },
  };
});

import { useCodexSpeed } from './useCodexSpeed';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
let value: ReturnType<typeof useCodexSpeed>;
function Harness({ signal = 0 }: { signal?: number }) {
  const current = useCodexSpeed(signal);
  useEffect(() => {
    value = current;
  });
  return <div data-status={current.state.status} data-mode={current.state.mode} />;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setAuth(next: Partial<typeof mocks.auth>) {
  await act(async () => {
    mocks.auth = { ...mocks.auth, ...next };
    mocks.listeners.forEach((listener) => listener());
  });
}
beforeEach(() => {
  mocks.auth = {
    apiBase: 'http://first.local:8317',
    managementKey: 'first-test-key',
    connectionStatus: 'connected',
  };
  mocks.read.mockReset().mockResolvedValue(initial);
  mocks.write.mockReset().mockResolvedValue(undefined);
  mocks.clearCache.mockReset();
  mocks.fetchConfig.mockReset().mockResolvedValue({});
});
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
});
async function render() {
  await act(async () => {
    renderer = create(<Harness />);
  });
}

describe('Codex speed connection lifecycle', () => {
  it('reads on mount and dashboard refresh without writing', async () => {
    await render();
    expect(value.state.mode).toBe('standard');
    mocks.read.mockResolvedValueOnce(updateCodexSpeedConfig(initial, 'standard'));
    await act(async () => {
      renderer?.update(<Harness signal={1} />);
    });
    expect(value.state.mode).toBe('standard');
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('scopes all mutation calls to the selected server and refreshes the store after verification', async () => {
    await render();
    const fast = updateCodexSpeedConfig(initial, 'fast');
    mocks.read
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(fast);
    await act(async () => {
      value.select('fast');
    });
    expect(value.state.mode).toBe('fast');
    expect(mocks.write).toHaveBeenCalledWith(fast, {
      apiBase: 'http://first.local:8317',
      managementKey: 'first-test-key',
    });
    expect(
      mocks.read.mock.calls.every(
        ([scope]) =>
          scope.apiBase === 'http://first.local:8317' && scope.managementKey === 'first-test-key'
      )
    ).toBe(true);
    expect(mocks.clearCache).toHaveBeenCalled();
    expect(mocks.fetchConfig).toHaveBeenCalledWith(undefined, true);
  });

  it('cancels the old operation before PUT when a different server is selected', async () => {
    await render();
    const oldRead = deferred<string>();
    mocks.read.mockReturnValueOnce(oldRead.promise);
    act(() => value.select('fast'));
    expect(value.state.status).toBe('saving');
    await setAuth({ apiBase: 'http://second.local:8317', managementKey: 'second-test-key' });
    expect(value.state.mode).toBe('standard');
    await act(async () => oldRead.resolve(initial));
    expect(mocks.write).not.toHaveBeenCalled();
    expect(value.state.mode).toBe('standard');
  });

  it('ignores completed writes from the old server after a switch', async () => {
    await render();
    const oldWrite = deferred<void>();
    mocks.write.mockReturnValueOnce(oldWrite.promise);
    await act(async () => value.select('fast'));
    expect(mocks.write).toHaveBeenCalledTimes(1);
    await setAuth({ apiBase: 'http://second.local:8317', managementKey: 'second-test-key' });
    await act(async () => oldWrite.resolve(undefined));
    expect(value.state.mode).toBe('standard');
    expect(mocks.fetchConfig).not.toHaveBeenCalled();
  });

  it('does not read or offer a selected mode while disconnected', async () => {
    mocks.auth.connectionStatus = 'disconnected';
    await render();
    expect(value.state).toMatchObject({ status: 'disconnected', mode: null });
    expect(mocks.read).not.toHaveBeenCalled();
    await setAuth({ connectionStatus: 'connected' });
    expect(value.state.mode).toBe('standard');
  });

  it('does not issue a mutation after unmount', async () => {
    await render();
    const pending = deferred<string>();
    mocks.read.mockReturnValueOnce(pending.promise);
    act(() => value.select('fast'));
    act(() => renderer?.unmount());
    renderer = undefined;
    await act(async () => pending.resolve(initial));
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
