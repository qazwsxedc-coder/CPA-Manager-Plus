import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuthStore, useConfigStore } from '@/stores';
import { configFileApi } from '@/services/api/configFile';
import { CodexSpeedController } from './controller';
import type { CodexSpeedMode } from './config';

export function useCodexSpeed(refreshSignal: number) {
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const controller = useMemo(() => {
    const scope = { apiBase, managementKey };
    const isCurrent = () => {
      const current = useAuthStore.getState();
      return (
        connectionStatus === 'connected' &&
        current.connectionStatus === 'connected' &&
        current.apiBase === apiBase &&
        current.managementKey === managementKey
      );
    };
    return new CodexSpeedController(
      {
        read: () => configFileApi.fetchConfigYaml(scope),
        write: (source) => configFileApi.saveConfigYaml(source, scope),
        isCurrent,
        refreshConfig: async () => {
          if (!isCurrent()) return;
          useConfigStore.getState().clearCache();
          await useConfigStore.getState().fetchConfig(undefined, true);
        },
      },
      connectionStatus === 'connected'
    );
  }, [apiBase, managementKey, connectionStatus]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    controller.activate();
    return () => controller.deactivate();
  }, [controller]);
  useEffect(() => {
    void controller.refresh();
  }, [controller, refreshSignal]);

  return {
    state,
    select: (mode: CodexSpeedMode) => {
      void controller.select(mode);
    },
    refresh: () => {
      void controller.refresh();
    },
  };
}
