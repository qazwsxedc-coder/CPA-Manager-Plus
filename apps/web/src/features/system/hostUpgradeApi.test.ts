import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostUpgradeApi } from './hostUpgradeApi';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('axios', () => ({ default: { request: mocks.request } }));
vi.mock('@/services/api/usageService', () => ({
  normalizeUsageServiceBase: (base: string) => base.replace(/\/+$/, ''),
}));
afterEach(() => vi.resetAllMocks());

describe('host upgrade admin API', () => {
  it('separates read-only check recovery from explicit manual requests', async () => {
    mocks.request.mockResolvedValue({ data: null });
    await hostUpgradeApi.currentCheck('http://manager.test', 'test-admin-key');
    await hostUpgradeApi.check(
      'http://manager.test',
      'test-admin-key',
      '12345678-1234-1234-1234-123456789abc'
    );
    expect(
      mocks.request.mock.calls.map(([config]) => [config.url, config.method, config.data])
    ).toEqual([
      ['http://manager.test/usage-service/upgrades/checks/current', 'GET', undefined],
      [
        'http://manager.test/usage-service/upgrades/checks',
        'POST',
        { requestId: '12345678-1234-1234-1234-123456789abc' },
      ],
    ]);
  });
  it('uses the Manager endpoint and admin authentication, preserving the idempotent payload', async () => {
    const intent = {
      component: 'cli' as const,
      releaseId: 'cli-v7.3.16-custom.1',
      requestId: '12345678-1234-1234-1234-123456789abc',
    };
    mocks.request.mockResolvedValue({ data: { id: intent.requestId, state: 'queued' } });
    await expect(
      hostUpgradeApi.submit('http://manager.test:18317/', 'test-admin-key', intent)
    ).resolves.toEqual({ id: intent.requestId, state: 'queued' });
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://manager.test:18317/usage-service/upgrades/jobs',
        method: 'POST',
        data: intent,
        headers: { Authorization: 'Bearer test-admin-key' },
      })
    );
  });
  it('queries releases and a durable job without sending mutation bodies', async () => {
    mocks.request.mockResolvedValue({ data: {} });
    await hostUpgradeApi.releases('http://manager.test', 'test-admin-key');
    await hostUpgradeApi.job(
      'http://manager.test',
      'test-admin-key',
      '12345678-1234-1234-1234-123456789abc'
    );
    expect(
      mocks.request.mock.calls.map(([config]) => [config.url, config.method, config.data])
    ).toEqual([
      ['http://manager.test/usage-service/upgrades/releases', 'GET', undefined],
      [
        'http://manager.test/usage-service/upgrades/jobs/12345678-1234-1234-1234-123456789abc',
        'GET',
        undefined,
      ],
    ]);
  });
});
