import axios from 'axios';
import type { ApiClientRequestScope } from './client';
import type { CodexSpeedMode } from '@/features/codexSpeed/config';
import { normalizeApiBase } from '@/utils/connection';
import { isDemoMode } from '@/features/demo/demoMode';

export type NativeCodexSpeedSnapshot = {
  available: boolean;
  mode: CodexSpeedMode | null;
  requestId: string | null;
  state: 'disabled' | 'unavailable' | 'ready' | 'applied' | 'error' | 'pending';
  code: string | null;
  updatedAt: string | null;
};

function endpoint(scope: ApiClientRequestScope) {
  // The host bridge is a Manager endpoint, outside /v0/management.
  return `${normalizeApiBase(scope.apiBase)}/usage-service/codex-native-speed`;
}

function requestConfig(scope: ApiClientRequestScope) {
  return {
    timeout: 5000,
    headers: scope.managementKey ? { Authorization: `Bearer ${scope.managementKey}` } : {},
  };
}

function readSnapshot(value: unknown): NativeCodexSpeedSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid native speed response');
  const data = value as Record<string, unknown>;
  if (
    typeof data.available !== 'boolean' ||
    typeof data.state !== 'string' ||
    !['disabled', 'unavailable', 'ready', 'applied', 'error', 'pending'].includes(data.state) ||
    (data.mode !== null && data.mode !== 'fast' && data.mode !== 'standard') ||
    (data.requestId !== null && typeof data.requestId !== 'string') ||
    (data.code !== null && typeof data.code !== 'string') ||
    (data.updatedAt !== null && typeof data.updatedAt !== 'string')
  )
    throw new Error('Invalid native speed response');
  return {
    available: data.available,
    mode: data.mode as NativeCodexSpeedSnapshot['mode'],
    requestId: data.requestId as NativeCodexSpeedSnapshot['requestId'],
    state: data.state as NativeCodexSpeedSnapshot['state'],
    code: data.code as NativeCodexSpeedSnapshot['code'],
    updatedAt: data.updatedAt as NativeCodexSpeedSnapshot['updatedAt'],
  };
}

export const nativeCodexSpeedApi = {
  async read(scope: ApiClientRequestScope): Promise<NativeCodexSpeedSnapshot> {
    if (__DEMO_SITE__ && isDemoMode()) return disabledSnapshot();
    try {
      const response = await axios.get(endpoint(scope), requestConfig(scope));
      return readSnapshot(response.data);
    } catch (error) {
      if ((error as { response?: { status?: number } })?.response?.status === 404) {
        // Older Manager versions and standalone CPA servers have no native host bridge.
        return disabledSnapshot();
      }
      throw error;
    }
  },

  async write(
    mode: CodexSpeedMode,
    scope: ApiClientRequestScope
  ): Promise<NativeCodexSpeedSnapshot> {
    if (__DEMO_SITE__ && isDemoMode()) return disabledSnapshot();
    const response = await axios.put(endpoint(scope), { mode }, requestConfig(scope));
    return readSnapshot(response.data);
  },
};

function disabledSnapshot(): NativeCodexSpeedSnapshot {
  return {
    available: false,
    mode: null,
    state: 'disabled',
    requestId: null,
    code: null,
    updatedAt: null,
  };
}
