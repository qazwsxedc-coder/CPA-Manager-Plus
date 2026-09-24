import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getRaw: vi.fn(), put: vi.fn() }));
vi.mock('./client', async (importOriginal) => {
  const original = await importOriginal<typeof import('./client')>();
  return { ...original, apiClient: mocks };
});

import { configFileApi } from './configFile';

beforeEach(() => {
  mocks.getRaw.mockReset().mockResolvedValue({ data: 'port: 8317\n' });
  mocks.put.mockReset().mockResolvedValue(undefined);
});

describe('config file captured request scope', () => {
  it('uses the original connection and authorization for both YAML read and write', async () => {
    const scope = { apiBase: 'http://original.local:8317', managementKey: 'test-management-key' };
    await configFileApi.fetchConfigYaml(scope);
    await configFileApi.saveConfigYaml('port: 8317\n', scope);
    const read = mocks.getRaw.mock.calls[0][1];
    const write = mocks.put.mock.calls[0][2];
    for (const config of [read, write]) {
      expect(config).toMatchObject({
        baseURL: 'http://original.local:8317/v0/management',
        cpampScopedRequest: true,
        headers: { Authorization: 'Bearer test-management-key' },
      });
    }
    expect(read.headers.Accept).toContain('yaml');
    expect(write.headers['Content-Type']).toBe('application/yaml');
  });

  it('preserves the existing unscoped call behavior', async () => {
    expect(await configFileApi.fetchConfigYaml()).toBe('port: 8317\n');
    await configFileApi.saveConfigYaml('port: 8317\n');
    expect(mocks.getRaw.mock.calls[0][1].cpampScopedRequest).toBeUndefined();
    expect(mocks.put.mock.calls[0][2].cpampScopedRequest).toBeUndefined();
  });
});
