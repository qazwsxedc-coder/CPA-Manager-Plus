import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexSpeedState } from './controller';

const mocks = vi.hoisted(() => ({
  state: { status: 'ready', mode: 'standard', error: null } as CodexSpeedState,
  select: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('./useCodexSpeed', () => ({ useCodexSpeed: () => mocks }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

import { CodexSpeedControl } from './CodexSpeedControl';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer;
beforeEach(() => {
  mocks.state = { status: 'ready', mode: 'standard', error: null };
  mocks.select.mockReset();
  mocks.refresh.mockReset();
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
});
function render() {
  act(() => {
    renderer = create(<CodexSpeedControl refreshSignal={0} />);
  });
}

describe('Codex speed control', () => {
  it('shows an explicit migration action instead of silently changing legacy semantics', () => {
    mocks.state = { status: 'ready', mode: 'fast', error: null, needsMigration: true };
    render();
    expect(JSON.stringify(renderer.toJSON())).toContain('codex_speed.migration_hint');
    act(() => renderer.root.findByType('button').props.onClick());
    expect(mocks.select).toHaveBeenCalledWith('fast');
  });
  it('renders two labeled radios using the confirmed state and switches immediately', () => {
    render();
    const inputs = renderer.root.findAllByType('input');
    expect(inputs).toHaveLength(2);
    expect(inputs.map((node) => node.props.checked)).toEqual([true, false]);
    expect(inputs.every((node) => node.props.type === 'radio')).toBe(true);
    expect(renderer.root.findByType('legend').children).toEqual(['codex_speed.label']);
    act(() => inputs[1].props.onChange());
    expect(mocks.select).toHaveBeenCalledWith('fast');
    expect(inputs[0].props.checked).toBe(true);
  });

  it('keeps the old selection disabled while saving and shows progress', () => {
    mocks.state = { status: 'saving', mode: 'standard', error: null };
    render();
    expect(renderer.root.findAllByType('input').every((node) => node.props.disabled)).toBe(true);
    expect(renderer.root.findAllByType('input')[0].props.checked).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('codex_speed.saving');
  });

  it('shows custom configuration with a configuration link and no selected mode', () => {
    mocks.state = { status: 'conflict', mode: null, error: null };
    render();
    expect(
      renderer.root
        .findAllByType('input')
        .every((node) => node.props.disabled && !node.props.checked)
    ).toBe(true);
    expect(renderer.root.findByType('a').props.href).toBe('/config');
    expect(JSON.stringify(renderer.toJSON())).toContain('codex_speed.conflict');
  });

  it.each([
    { status: 'error', error: 'changed' },
    { status: 'error', error: 'read_failed' },
    { status: 'unknown', error: 'unconfirmed' },
  ] as const)(
    'allows read-only recovery from $error and never displays a successful selection',
    (state) => {
      mocks.state = { ...state, mode: null };
      render();
      expect(renderer.root.findAllByType('input').some((node) => node.props.checked)).toBe(false);
      expect(renderer.root.findAllByType('input').every((node) => node.props.disabled)).toBe(true);
      expect(JSON.stringify(renderer.toJSON())).toContain(`codex_speed.${state.error}`);
      act(() => renderer.root.findByType('button').props.onClick());
      expect(mocks.refresh).toHaveBeenCalled();
    }
  );

  it.each(['loading', 'disconnected'] as const)(
    'does not imply a default mode while %s',
    (status) => {
      mocks.state = { status, mode: null, error: null };
      render();
      expect(
        renderer.root
          .findAllByType('input')
          .every((node) => node.props.disabled && !node.props.checked)
      ).toBe(true);
      expect(JSON.stringify(renderer.toJSON())).toContain(`codex_speed.${status}`);
    }
  );

  it('displays the usage hint for fast mode', () => {
    mocks.state.mode = 'fast';
    render();
    expect(renderer.root.findByProps({ role: 'status' }).children).toContain(
      'codex_speed.fast_hint'
    );
  });
});
