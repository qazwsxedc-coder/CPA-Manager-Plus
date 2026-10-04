import axios from 'axios';
import { normalizeUsageServiceBase } from '@/services/api/usageService';
import type {
  HostUpdateCheck,
  HostUpgradeCatalog,
  HostUpgradeJob,
  UpgradeComponent,
  UpgradeAutomation,
} from './hostUpgradeModel';

export interface UpgradeRequest {
  component: UpgradeComponent;
  releaseId: string;
  requestId: string;
}

// Use the Manager admin credential and base, not the CLI management API client.
async function request<T>(
  base: string,
  key: string,
  suffix: string,
  data?: UpgradeRequest | { requestId: string }
) {
  const response = await axios.request<T>({
    url: `${normalizeUsageServiceBase(base).replace(/\/+$/, '')}/usage-service/upgrades${suffix}`,
    method: data ? 'POST' : 'GET',
    data,
    timeout: 15_000,
    headers: { Authorization: `Bearer ${key}` },
  });
  return response.data;
}

export const hostUpgradeApi = {
  currentCheck: (base: string, key: string) =>
    request<HostUpdateCheck | null>(base, key, '/checks/current'),
  check: (base: string, key: string, requestId: string) =>
    request<HostUpdateCheck>(base, key, '/checks', { requestId }),
  releases: (base: string, key: string) => request<HostUpgradeCatalog>(base, key, '/releases'),
  automation: (base: string, key: string) => request<UpgradeAutomation>(base, key, '/automation'),
  job: (base: string, key: string, id: string) =>
    request<HostUpgradeJob>(base, key, `/jobs/${encodeURIComponent(id)}`),
  submit: (base: string, key: string, data: UpgradeRequest) =>
    request<HostUpgradeJob>(base, key, '/jobs', data),
};
