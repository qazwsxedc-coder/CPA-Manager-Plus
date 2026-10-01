import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionCard } from './VersionCard';
import type { HostUpgrades } from '@/features/system/useHostUpgrades';
import type { HostUpgradeJob, HostUpgradeRelease } from '@/features/system/hostUpgradeModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({
  controls: {} as HostUpgrades,
  checking: false,
  latest: vi.fn(),
  external: vi.fn(),
  notification: vi.fn(),
  updateCheck: { check: null, checking: false, canCheck: true, error: false, start: vi.fn() },
}));
vi.mock('@/features/system/useHostUpgrades', () => ({ useHostUpgrades: () => mocks.controls }));
vi.mock('@/features/system/useHostUpdateCheck', () => ({
  useHostUpdateCheck: () => mocks.updateCheck,
}));
vi.mock('@/features/system/ManagerUpdates', () => ({
  useManagerUpdates: () => ({ status: { current_version: 'v0.1.0' } }),
}));
vi.mock('@/hooks/usePanelFeatureAvailability', () => ({
  usePanelFeatureAvailability: () => ({
    checking: mocks.checking,
    panelHostConfirmed: true,
    panelHostMode: 'manager_embedded',
    managerServiceBase: 'http://manager.test',
    managerServiceAvailable: true,
  }),
}));
vi.mock('@/stores', () => ({
  useNotificationStore: (select: (s: unknown) => unknown) =>
    select({ showNotification: mocks.notification }),
}));
vi.mock('@/services/api', () => ({
  versionApi: { checkLatest: mocks.latest, checkManagerUpdateIndex: mocks.external },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.component ? `${key}:${values.component}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/components/ui/Modal', () => ({
  Modal: ({
    open,
    title,
    children,
    footer,
  }: {
    open: boolean;
    title: React.ReactNode;
    children: React.ReactNode;
    footer: React.ReactNode;
  }) =>
    open ? (
      <div role="dialog">
        <h2>{title}</h2>
        {children}
        {footer}
      </div>
    ) : null,
}));

const managerRelease: HostUpgradeRelease = {
  releaseId: 'manager-1.13.3',
  component: 'manager',
  version: 'v1.13.3-custom.1',
  imageTag: 'local/manager:v1.13.3-custom.1',
  imageId: 'sha256:manager-new',
  allowedFromImageIds: ['sha256:manager-old'],
  migrationRequired: false,
};
const cliRelease: HostUpgradeRelease = {
  ...managerRelease,
  releaseId: 'cli-7.3.16',
  component: 'cli',
  version: 'v7.3.16-custom.1',
  imageTag: 'local/cli:v7.3.16-custom.1',
  imageId: 'sha256:cli-new',
  allowedFromImageIds: ['sha256:cli-old'],
};
const job = (state: HostUpgradeJob['state']): HostUpgradeJob => ({
  schemaVersion: 1,
  id: '12345678-1234-1234-1234-123456789abc',
  component: 'manager',
  releaseId: managerRelease.releaseId,
  state,
  step: 'healthcheck',
  message: 'Checking service',
  createdAt: '',
  updatedAt: '',
  fromVersion: 'v1.13.2-custom.1',
  toVersion: 'v1.13.3-custom.1',
  backupPath: 'C:\\backups\\<img src=x onerror=alert(1)>',
});
let renderer: ReactTestRenderer | null;
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
const action = (component: string) =>
  renderer!.root.find(
    (node) =>
      node.type === 'button' &&
      node.props['aria-label'] === `host_upgrades.upgrade_component:${component}`
  );
async function mount() {
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <VersionCard
          appVersion="v0.1.0"
          apiVersion="v0.2.0"
          cpaBase="http://cli.test"
          connectionStatus="connected"
          usageEnabled={false}
          usageLoading={false}
          collectorStatus={null}
          collectorLoading={false}
          errorLogCount={0}
          errorLogsLoading={false}
        />
      </MemoryRouter>
    );
  });
}
beforeEach(() => {
  mocks.checking = false;
  mocks.controls = {
    enabled: true,
    resolved: true,
    pending: null,
    reconnecting: false,
    error: null,
    busy: false,
    canStart: true,
    job: null,
    refresh: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    catalog: {
      enabled: true,
      executorOnline: true,
      current: {
        manager: { version: 'v1.13.2-custom.1', imageId: 'sha256:manager-old' },
        cli: { version: 'v7.3.15-custom.1', imageId: 'sha256:cli-old' },
      },
      latest: { cli: 'v7.3.16', manager: 'v1.13.3' },
      releases: [managerRelease, cliRelease],
    },
  };
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('VersionCard host upgrades', () => {
  it('enables detected Manager upgrades and explains automatic preparation before confirmation', async () => {
    const offer = {
      ...managerRelease,
      releaseId: 'prepare-manager-v1.14.2',
      version: 'v1.14.2',
      imageTag: '',
      imageId: '',
      prepareRequired: true,
    };
    mocks.controls.catalog!.releases = [];
    mocks.controls.catalog!.offers = [offer];
    await mount();
    expect(action('CPAMP').props.disabled).toBe(false);
    await act(async () => action('CPAMP').props.onClick());
    const dialog = renderer!.root.findByProps({ role: 'dialog' });
    expect(text(dialog)).toContain('host_upgrades.direct_manager');
    expect(mocks.controls.start).not.toHaveBeenCalled();
    await act(async () =>
      dialog
        .find((node) => node.type === 'button' && text(node) === 'host_upgrades.confirm')
        .props.onClick()
    );
    expect(mocks.controls.start).toHaveBeenCalledExactlyOnceWith(offer);
  });
  it('enables the existing upgrade button for a detected official CLI version and confirms one task', async () => {
    const offer = {
      ...cliRelease,
      releaseId: 'prepare-cli-v7.3.17',
      version: 'v7.3.17',
      imageId: '',
      prepareRequired: true,
    };
    mocks.controls.catalog!.releases = [managerRelease];
    mocks.controls.catalog!.offers = [offer];
    await mount();
    expect(action('CLIProxyAPI').props.disabled).toBe(false);
    await act(async () => action('CLIProxyAPI').props.onClick());
    const dialog = renderer!.root.findByProps({ role: 'dialog' });
    expect(text(dialog)).toContain('host_upgrades.direct_download');
    expect(mocks.controls.start).not.toHaveBeenCalled();
    await act(async () =>
      dialog
        .find((node) => node.type === 'button' && text(node) === 'host_upgrades.confirm')
        .props.onClick()
    );
    expect(mocks.controls.start).toHaveBeenCalledExactlyOnceWith(offer);
  });
  it('warns before confirming an additive Manager migration without automatic rollback', async () => {
    const migrating = {
      ...managerRelease,
      migrationRequired: true,
      migrationMode: 'automatic-additive' as const,
      rollbackDataCompatible: false,
    };
    mocks.controls.catalog!.releases = [migrating, cliRelease];
    await mount();
    await act(async () => action('CPAMP').props.onClick());
    const dialog = renderer!.root.findByProps({ role: 'dialog' });
    expect(text(dialog.findByProps({ role: 'note' }))).toContain(
      'host_upgrades.automatic_migration'
    );
    expect(text(dialog)).toContain('host_upgrades.outage');
    await act(async () =>
      dialog
        .find((node) => node.type === 'button' && text(node) === 'host_upgrades.confirm')
        .props.onClick()
    );
    expect(mocks.controls.start).toHaveBeenCalledWith(migrating);
  });
  it('waits for Manager discovery before any legacy latest-version request', async () => {
    mocks.checking = true;
    mocks.controls.enabled = false;
    mocks.controls.resolved = true;
    await mount();
    expect(mocks.latest).not.toHaveBeenCalled();
  });
  it('uses cached host versions and confirms the exact current-to-target Manager upgrade', async () => {
    await mount();
    expect(mocks.latest).not.toHaveBeenCalled();
    expect(mocks.external).not.toHaveBeenCalled();
    expect(text(renderer!.root)).toContain('v1.13.2-custom.1');
    expect(text(renderer!.root)).toContain('v7.3.15-custom.1');
    await act(async () => action('CPAMP').props.onClick());
    const dialog = renderer!.root.findByProps({ role: 'dialog' });
    expect(text(dialog)).toContain('v1.13.2-custom.1 → v1.13.3-custom.1');
    expect(text(dialog)).toContain('host_upgrades.outage');
    expect(text(dialog)).toContain('host_upgrades.manager_reconnect');
    expect(mocks.controls.start).not.toHaveBeenCalled();
    await act(async () =>
      dialog
        .find((node) => node.type === 'button' && text(node) === 'host_upgrades.confirm')
        .props.onClick()
    );
    expect(mocks.controls.start).toHaveBeenCalledWith(managerRelease);
  });
  it('keeps both upgrade buttons visible but disabled when no image is prepared', async () => {
    mocks.controls.catalog!.releases = [];
    mocks.controls.catalog!.latest.manager = 'v1.13.2';
    await mount();
    expect(action('CPAMP').props.disabled).toBe(true);
    expect(action('CLIProxyAPI').props.disabled).toBe(true);
    expect(text(renderer!.root)).toContain('host_upgrades.awaiting_preparation');
    expect(text(renderer!.root)).toContain('host_upgrades.no_installable');
  });
  it('routes either manual version button to an explicit upstream check', async () => {
    await mount();
    expect(mocks.updateCheck.start).not.toHaveBeenCalled();
    const buttons = renderer!.root.findAll(
      (node) =>
        node.type === 'button' && node.props['aria-label'] === 'system_info.version_check_button'
    );
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0].props.onClick());
    await act(async () => buttons[1].props.onClick());
    expect(mocks.updateCheck.start).toHaveBeenCalledTimes(2);
    expect(mocks.controls.refresh).not.toHaveBeenCalled();
    expect(mocks.latest).not.toHaveBeenCalled();
  });
  it.each(['installing', 'manual_recovery'] as const)(
    'locks both components during %s and safely renders backup paths',
    async (state) => {
      mocks.controls.job = job(state);
      mocks.controls.busy = true;
      await mount();
      expect(action('CPAMP').props.disabled).toBe(true);
      expect(action('CLIProxyAPI').props.disabled).toBe(true);
      expect(renderer!.root.findByType('code').children).toEqual([mocks.controls.job.backupPath]);
      expect(renderer!.root.findAllByType('img')).toHaveLength(0);
      expect(renderer!.root.findAllByProps({ role: 'status' })).toHaveLength(2);
    }
  );
  it('offers a panel reload after successful Manager self-upgrade', async () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    mocks.controls.job = job('succeeded');
    await mount();
    const button = renderer!.root.find(
      (node) => node.type === 'button' && text(node) === 'host_upgrades.reload_panel'
    );
    await act(async () => button.props.onClick());
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('disables upgrades when executor availability is false', async () => {
    mocks.controls.canStart = false;
    mocks.controls.catalog!.executorOnline = false;
    await mount();
    expect(action('CPAMP').props.disabled).toBe(true);
    expect(action('CLIProxyAPI').props.disabled).toBe(true);
  });
});
