import axios from 'axios';
import { normalizeUsageServiceBase } from '@/services/api/usageService';
import type { HostUpgradeCatalog, HostUpgradeJob, UpgradeComponent } from './hostUpgradeModel';

export interface UpgradeRequest {
  component: UpgradeComponent;
  releaseId: string;
  requestId: string;
}

// Use the Manager admin credential and base, not the CLI management API client.
async function request<T>(base: string, key: string, suffix: string, data?: UpgradeRequest) {
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
  releases: (base: string, key: string) => request<HostUpgradeCatalog>(base, key, '/releases'),
  job: (base: string, key: string, id: string) =>
    request<HostUpgradeJob>(base, key, `/jobs/${encodeURIComponent(id)}`),
  submit: (base: string, key: string, data: UpgradeRequest) =>
    request<HostUpgradeJob>(base, key, '/jobs', data),
};
