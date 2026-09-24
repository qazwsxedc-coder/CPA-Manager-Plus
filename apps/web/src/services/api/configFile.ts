/**
 * 配置文件相关 API（/config.yaml）
 */

import { apiClient, createScopedApiRequestConfig, type ApiClientRequestScope } from './client';

export const configFileApi = {
  async fetchConfigYaml(scope?: ApiClientRequestScope): Promise<string> {
    const scoped = scope ? createScopedApiRequestConfig(scope) : {};
    const response = await apiClient.getRaw('/config.yaml', {
      ...scoped,
      responseType: 'text',
      headers: { ...scoped.headers, Accept: 'application/yaml, text/yaml, text/plain' },
    });
    const data: unknown = response.data;
    if (typeof data === 'string') return data;
    if (data === undefined || data === null) return '';
    return String(data);
  },

  async saveConfigYaml(content: string, scope?: ApiClientRequestScope): Promise<void> {
    const scoped = scope ? createScopedApiRequestConfig(scope) : {};
    await apiClient.put('/config.yaml', content, {
      ...scoped,
      headers: {
        ...scoped.headers,
        'Content-Type': 'application/yaml',
        Accept: 'application/json, text/plain, */*',
      },
    });
  },
};
