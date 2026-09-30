import { describe, expect, it, vi } from 'vitest';
import { CodexSpeedController } from './controller';
import { inspectCodexSpeedConfig, updateCodexSpeedConfig } from './config';

const initial = 'port: 8317\n';
const custom =
  'payload:\n  override:\n    - models: [{name: "*", protocol: codex}]\n      params: {service_tier: default}\n';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(source = initial) {
  let yaml = source;
  let current = true;
  const io = {
    read: vi.fn(async () => yaml),
    write: vi.fn(async (next: string) => {
      yaml = next;
    }),
    isCurrent: () => current,
    refreshConfig: vi.fn(async () => {}),
  };
  const controller = new CodexSpeedController(io);
  return {
    controller,
    io,
    setYaml: (next: string) => {
      yaml = next;
    },
    disconnect: () => {
      current = false;
    },
  };
}

describe('Codex speed persistence', () => {
  it('withdraws native agreement when CPA confirmation is lost while retaining the native mode', async () => {
    const { io } = setup();
    const readNative = vi
      .fn()
      .mockResolvedValue({
        available: true,
        mode: 'standard',
        state: 'ready',
        requestId: null,
        code: null,
        updatedAt: null,
      });
    const writeNative = vi.fn();
    const controller = new CodexSpeedController({ ...io, readNative, writeNative });
    await controller.refresh();
    expect(controller.getSnapshot().native?.status).toBe('synced');
    const observed: ReturnType<typeof controller.getSnapshot>[] = [];
    controller.subscribe(() => observed.push(controller.getSnapshot()));
    io.read.mockRejectedValueOnce(new Error('read failed'));
    await controller.refresh();
    expect(
      observed.every((state) => state.mode !== null || state.native?.status !== 'synced')
    ).toBe(true);
    await controller.refresh();
    io.write.mockRejectedValueOnce(new Error('write unknown'));
    await controller.select('fast');
    expect(controller.getSnapshot()).toMatchObject({
      mode: null,
      error: 'unconfirmed',
      native: { status: 'loading', mode: 'standard' },
    });
    expect(writeNative).not.toHaveBeenCalled();
  });
  it('never reports native success when the host is unavailable even if the reported mode matches', async () => {
    const { io } = setup(updateCodexSpeedConfig(initial, 'fast'));
    const readNative = vi.fn().mockResolvedValue({
      available: false,
      mode: 'fast',
      state: 'applied',
      requestId: 'old-request',
      code: null,
      updatedAt: null,
    });
    const controller = new CodexSpeedController({ ...io, readNative });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      mode: 'fast',
      native: { status: 'unavailable' },
    });
  });
  it('never carries a stale native synced state across a confirmed CPA mode change', async () => {
    const { io } = setup();
    const readNative = vi.fn().mockResolvedValue({
      available: true,
      mode: 'standard',
      state: 'ready',
      requestId: null,
      code: null,
      updatedAt: null,
    });
    const writeNative = vi.fn().mockResolvedValue({
      available: true,
      mode: 'standard',
      state: 'pending',
      requestId: 'request-1',
      code: null,
      updatedAt: null,
    });
    const controller = new CodexSpeedController({ ...io, readNative, writeNative });
    await controller.refresh();
    const states: ReturnType<typeof controller.getSnapshot>[] = [];
    controller.subscribe(() => states.push(controller.getSnapshot()));
    await controller.select('fast');
    expect(
      states.some((state) => state.native?.status === 'synced' && state.native.mode !== state.mode)
    ).toBe(false);
  });
  it('keeps native read errors separate and respects explicitly disabled sync', async () => {
    const { io } = setup();
    const readNative = vi.fn().mockRejectedValue(new Error('secret native details'));
    const writeNative = vi.fn();
    const controller = new CodexSpeedController({ ...io, readNative, writeNative });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      mode: 'standard',
      error: null,
      native: { status: 'error' },
    });
    readNative.mockResolvedValue({
      available: false,
      mode: null,
      state: 'disabled',
      requestId: null,
      code: null,
      updatedAt: null,
    });
    await controller.refresh();
    await controller.select('fast');
    expect(controller.getSnapshot()).toMatchObject({
      mode: 'fast',
      native: { status: 'disabled' },
    });
    expect(writeNative).not.toHaveBeenCalled();
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('secret');
  });
  it('allows retry after native polling expires without losing the confirmed CPA mode', async () => {
    const { io } = setup(updateCodexSpeedConfig(initial, 'fast'));
    const readNative = vi.fn().mockResolvedValue({
      available: true,
      mode: 'standard',
      state: 'pending',
      requestId: 'request-1',
      code: null,
      updatedAt: null,
    });
    const writeNative = vi.fn().mockResolvedValue({
      available: true,
      mode: 'standard',
      state: 'pending',
      requestId: 'request-2',
      code: null,
      updatedAt: null,
    });
    const controller = new CodexSpeedController({ ...io, readNative, writeNative });
    await controller.refresh();
    controller.nativeTimedOut();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      mode: 'fast',
      native: { status: 'error', requestId: 'request-1' },
    });
    await controller.select('fast');
    expect(writeNative).toHaveBeenCalledWith('fast');
    expect(io.write).not.toHaveBeenCalled();
  });
  it('requests native speed only after the CPA change is confirmed and keeps the CPA mode while pending', async () => {
    const { io } = setup();
    const readNative = vi.fn(async () => ({
      available: true,
      mode: 'standard' as const,
      state: 'ready' as const,
      requestId: null,
      code: null,
      updatedAt: null,
    }));
    const writeNative = vi.fn(async (mode: 'fast' | 'standard') => {
      expect(inspectCodexSpeedConfig(await io.read()).mode).toBe(mode);
      return {
        available: true,
        mode: 'standard' as const,
        state: 'pending' as const,
        requestId: 'request-1',
        code: null,
        updatedAt: null,
      };
    });
    const controller = new CodexSpeedController({ ...io, readNative, writeNative });
    await controller.refresh();
    expect(writeNative).not.toHaveBeenCalled();
    await controller.select('fast');
    expect(writeNative).toHaveBeenCalledWith('fast');
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      mode: 'fast',
      native: { status: 'pending', mode: 'standard' },
    });
  });

  it('retains a confirmed CPA mode on native failure and retries the same mode without rewriting YAML', async () => {
    const { io } = setup(updateCodexSpeedConfig(initial, 'fast'));
    const readNative = vi.fn(async () => ({
      available: true,
      mode: 'standard' as const,
      state: 'ready' as const,
      requestId: null,
      code: null,
      updatedAt: null,
    }));
    const writeNative = vi.fn().mockRejectedValue(new Error('secret local path or token'));
    const controller = new CodexSpeedController({ ...io, readNative, writeNative });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ native: { status: 'drift' } });
    await controller.select('fast');
    expect(io.write).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      mode: 'fast',
      error: null,
      native: { status: 'error' },
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('secret');
    writeNative.mockResolvedValue({
      available: true,
      mode: 'fast',
      state: 'applied',
      requestId: 'request-2',
      code: null,
      updatedAt: null,
    });
    await controller.select('fast');
    expect(controller.getSnapshot()).toMatchObject({ native: { status: 'synced', mode: 'fast' } });
    expect(io.write).not.toHaveBeenCalled();
  });

  it('does not submit native requests after an unconfirmed CPA save', async () => {
    const { io } = setup();
    const readNative = vi.fn(async () => ({
      available: true,
      mode: 'standard' as const,
      state: 'ready' as const,
      requestId: null,
      code: null,
      updatedAt: null,
    }));
    const writeNative = vi.fn();
    const controller = new CodexSpeedController({ ...io, readNative, writeNative });
    await controller.refresh();
    io.write.mockRejectedValueOnce(new Error('write failed'));
    await controller.select('fast');
    expect(controller.getSnapshot()).toMatchObject({ status: 'unknown', error: 'unconfirmed' });
    expect(writeNative).not.toHaveBeenCalled();
  });

  it('reads native completion without mutating either configuration', async () => {
    const { io } = setup(updateCodexSpeedConfig(initial, 'fast'));
    const readNative = vi.fn().mockResolvedValue({
      available: true,
      mode: 'standard',
      state: 'pending',
      requestId: 'request-1',
      code: null,
      updatedAt: null,
    });
    const writeNative = vi.fn();
    const controller = new CodexSpeedController({ ...io, readNative, writeNative });
    await controller.refresh();
    readNative.mockResolvedValue({
      available: true,
      mode: 'fast',
      state: 'applied',
      requestId: 'request-1',
      code: null,
      updatedAt: null,
    });
    await controller.refreshNative();
    expect(controller.getSnapshot()).toMatchObject({ mode: 'fast', native: { status: 'synced' } });
    expect(io.write).not.toHaveBeenCalled();
    expect(writeNative).not.toHaveBeenCalled();
  });

  it('offers migration without writing during refresh and can migrate the same selection', async () => {
    const legacy =
      'payload:\n  override:\n    - models:\n        - name: "*" # cpa-manager-plus:codex-speed:v1:fast\n          protocol: codex\n      params: {service_tier: priority}\n';
    const { controller, io } = setup(legacy);
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ mode: 'fast', needsMigration: true });
    expect(io.write).not.toHaveBeenCalled();
    await controller.select('fast');
    expect(controller.getSnapshot()).toMatchObject({ mode: 'fast', status: 'ready' });
    expect(controller.getSnapshot().needsMigration).toBeUndefined();
    expect(await io.read()).toContain('cpa-manager-plus:codex-speed:v2:fast');
  });
  it('loads without writing and cycles modes using verified server state', async () => {
    const { controller, io } = setup();
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', mode: 'standard' });
    expect(io.write).not.toHaveBeenCalled();
    for (const mode of ['fast', 'standard'] as const) {
      await controller.select(mode);
      expect(controller.getSnapshot()).toMatchObject({ status: 'ready', mode });
      expect(inspectCodexSpeedConfig(await io.read()).mode).toBe(mode);
      await controller.refresh();
      expect(controller.getSnapshot().mode).toBe(mode);
    }
    expect(io.refreshConfig).toHaveBeenCalledTimes(2);
    const writes = io.write.mock.calls.length;
    await controller.select('standard');
    expect(io.write.mock.calls).toHaveLength(writes);
  });

  it('blocks custom rules and keeps raw config or API errors out of state', async () => {
    const { controller, io } = setup(custom);
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ status: 'conflict', mode: null });
    await controller.select('fast');
    expect(io.write).not.toHaveBeenCalled();
    io.read.mockRejectedValueOnce(new Error('secret-key-and-yaml'));
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      mode: null,
      error: 'read_failed',
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('secret');
  });

  it('rejects changes since display and requires a new refresh', async () => {
    const { controller, io, setYaml } = setup();
    await controller.refresh();
    setYaml('port: 8318\n');
    await controller.select('fast');
    expect(io.write).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      mode: null,
      error: 'changed',
    });
    await controller.select('fast');
    expect(io.write).not.toHaveBeenCalled();
    await controller.refresh();
    await controller.select('fast');
    expect(controller.getSnapshot().mode).toBe('fast');
    expect(await io.read()).toContain('8318');
  });

  it('rejects changes immediately before PUT', async () => {
    const { controller, io } = setup();
    await controller.refresh();
    io.read.mockResolvedValueOnce(initial).mockResolvedValueOnce('port: 9999\n');
    await controller.select('fast');
    expect(io.write).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toBe('changed');
  });

  it('disables duplicate operations synchronously and retains only the old mode until verified', async () => {
    const { controller, io } = setup();
    await controller.refresh();
    const gate = deferred<string>();
    io.read.mockReturnValueOnce(gate.promise);
    const first = controller.select('fast');
    expect(controller.getSnapshot()).toMatchObject({ status: 'saving', mode: 'standard' });
    await controller.select('standard');
    await controller.refresh();
    gate.resolve(initial);
    await first;
    expect(io.write).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().mode).toBe('fast');
  });

  it.each(['write', 'readback', 'mismatch'] as const)(
    'marks a %s failure unconfirmed rather than successful',
    async (failure) => {
      const { controller, io } = setup();
      await controller.refresh();
      if (failure === 'write') io.write.mockRejectedValueOnce(new Error('secret'));
      else {
        io.read.mockResolvedValueOnce(initial).mockResolvedValueOnce(initial);
        if (failure === 'readback') io.read.mockRejectedValueOnce(new Error('secret'));
        else io.read.mockResolvedValueOnce(initial);
      }
      await controller.select('fast');
      expect(controller.getSnapshot()).toMatchObject({
        status: 'unknown',
        mode: null,
        error: 'unconfirmed',
      });
      expect(io.refreshConfig).not.toHaveBeenCalled();
    }
  );

  it('accepts formatting normalization but verifies the entire configuration', async () => {
    const { controller, io } = setup();
    await controller.refresh();
    const fast = updateCodexSpeedConfig(initial, 'fast');
    io.read
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(fast.replace(/\n/g, '\r\n'));
    await controller.select('fast');
    expect(controller.getSnapshot().mode).toBe('fast');
    await controller.refresh();
    const standard = updateCodexSpeedConfig(fast, 'standard');
    io.read
      .mockResolvedValueOnce(fast)
      .mockResolvedValueOnce(fast)
      .mockResolvedValueOnce(standard.replace('8317', '9999'));
    await controller.select('standard');
    expect(controller.getSnapshot().status).toBe('unknown');
  });

  it('does not PUT after connection changes during the prewrite read', async () => {
    const { controller, io, disconnect } = setup();
    await controller.refresh();
    const gate = deferred<string>();
    io.read.mockResolvedValueOnce(initial).mockReturnValueOnce(gate.promise);
    const pending = controller.select('fast');
    await Promise.resolve();
    disconnect();
    gate.resolve(initial);
    await pending;
    expect(io.write).not.toHaveBeenCalled();
    expect(controller.getSnapshot().mode).not.toBe('fast');
  });

  it('detects changes to large integer values without numeric rounding', async () => {
    const source = `${initial}external-id: 9223372036854775807\n`;
    const { controller, io } = setup(source);
    await controller.refresh();
    const changed = updateCodexSpeedConfig(source, 'fast').replace(
      '9223372036854775807',
      '9223372036854776000'
    );
    io.read
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(changed);
    await controller.select('fast');
    expect(controller.getSnapshot()).toMatchObject({ status: 'unknown', error: 'unconfirmed' });
  });

  it('ignores old work after unmount or reactivation', async () => {
    const { controller, io } = setup();
    const old = deferred<string>();
    io.read.mockReturnValueOnce(old.promise);
    const first = controller.refresh();
    controller.deactivate();
    controller.activate();
    await controller.refresh();
    old.resolve(custom);
    await first;
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', mode: 'standard' });
  });
});
