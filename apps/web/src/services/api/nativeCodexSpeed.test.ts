import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('axios', () => ({ default: mocks }));

import { nativeCodexSpeedApi } from './nativeCodexSpeed';

const snapshot = {
  available: true,
  mode: 'standard',
  state: 'ready',
  requestId: null,
  code: null,
  updatedAt: null,
};
const scope = { apiBase: 'http://manager.local:18317/v0/management/', managementKey: 'test-key' };

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue({ data: snapshot });
  mocks.put
    .mockReset()
    .mockResolvedValue({ data: { ...snapshot, state: 'pending', requestId: 'r1' } });
});

describe('native Codex speed scoped requests', () => {
  it('treats an older server without the endpoint as disabled and keeps other failures visible', async () => {
    mocks.get.mockRejectedValueOnce({ response: { status: 404 } });
    expect(await nativeCodexSpeedApi.read(scope)).toMatchObject({
      state: 'disabled',
      available: false,
    });
    mocks.get.mockRejectedValueOnce({ response: { status: 401 } });
    await expect(nativeCodexSpeedApi.read(scope)).rejects.toMatchObject({
      response: { status: 401 },
    });
  });
  it('uses the captured Manager root and admin credential for reads and only sends mode on writes', async () => {
    expect(await nativeCodexSpeedApi.read(scope)).toEqual(snapshot);
    expect(await nativeCodexSpeedApi.write('fast', scope)).toMatchObject({ state: 'pending' });
    const url = 'http://manager.local:18317/usage-service/codex-native-speed';
    expect(mocks.get).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-key' },
      })
    );
    expect(mocks.put).toHaveBeenCalledWith(
      url,
      { mode: 'fast' },
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-key' },
      })
    );
  });

  it('rejects a malformed response instead of showing native success', async () => {
    mocks.get.mockResolvedValue({ data: { mode: 'fast', state: 'applied' } });
    await expect(nativeCodexSpeedApi.read(scope)).rejects.toThrow('Invalid native speed response');
  });
});
