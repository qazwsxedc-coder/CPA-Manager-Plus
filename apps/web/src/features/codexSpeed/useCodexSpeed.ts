import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuthStore, useConfigStore } from '@/stores';
import { configFileApi } from '@/services/api/configFile';
import { nativeCodexSpeedApi } from '@/services/api/nativeCodexSpeed';
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
        readNative: () => nativeCodexSpeedApi.read(scope),
        writeNative: (mode) => nativeCodexSpeedApi.write(mode, scope),
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
  useEffect(() => {
    if (state.native?.status !== 'pending') return;
    // Requests expire after two minutes. Expose retry if the host never confirms.
    let polls = 0;
    const timer = setInterval(() => {
      if (++polls > 60) {
        if (controller.nativeTimedOut()) clearInterval(timer);
        return;
      }
      void controller.refreshNative();
    }, 2000);
    return () => clearInterval(timer);
  }, [controller, state.native?.status, state.native?.requestId]);

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
