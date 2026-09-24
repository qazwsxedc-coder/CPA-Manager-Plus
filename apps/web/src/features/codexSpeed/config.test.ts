import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { inspectCodexSpeedConfig, updateCodexSpeedConfig, type CodexSpeedMode } from './config';

const modes: CodexSpeedMode[] = ['standard', 'fast'];
const baseline = '# Keep the operator notes\nport: 8317\nfuture-setting: { enabled: true }\n';
const groups = ['default', 'default-raw', 'override', 'override-raw', 'filter'];

function customRule(group: string, params: unknown, protocol?: string) {
  return stringify({
    payload: {
      [group]: [{ models: [{ name: 'gpt-*', ...(protocol ? { protocol } : {}) }], params }],
    },
  });
}

function expectConflict(source: string) {
  const result = inspectCodexSpeedConfig(source);
  expect(result).toMatchObject({ mode: null, conflict: true });
  expect(result.reason).toBeTruthy();
  for (const mode of modes) expect(() => updateCodexSpeedConfig(source, mode)).toThrow();
}

describe('Codex speed YAML config', () => {
  it('uses Cockpit API payload defaults across its three supported protocols', () => {
    const config = parse(updateCodexSpeedConfig(baseline, 'fast'));
    expect(config.payload.default).toEqual([
      {
        models: ['codex', 'openai', 'openai-response'].map((protocol) => ({ name: '*', protocol })),
        params: { service_tier: 'priority' },
      },
    ]);
    expect(config.payload.override ?? []).toEqual([]);
  });

  it('standard mode removes defaults without filtering explicit client tiers', () => {
    const config = parse(
      updateCodexSpeedConfig(updateCodexSpeedConfig(baseline, 'fast'), 'standard')
    );
    expect(config.payload.filter ?? []).toEqual([]);
    expect(config.payload.default ?? []).toEqual([]);
  });

  it('migrates an intact legacy fast override even when fast remains selected', () => {
    const legacy = `${baseline}payload:\n  override:\n    - models:\n        - name: "*" # cpa-manager-plus:codex-speed:v1:fast\n          protocol: codex\n      params:\n        service_tier: priority\n`;
    const updated = updateCodexSpeedConfig(legacy, 'fast');
    expect(parse(updated).payload.override ?? []).toEqual([]);
    expect(parse(updated).payload.default[0].params).toEqual({ service_tier: 'priority' });
    expect(updated).toContain('cpa-manager-plus:codex-speed:v2:fast');
  });

  it('removes an intact legacy standard filter without removing unrelated rules', () => {
    const legacy = `${baseline}payload:\n  filter:\n    - models:\n        - name: "*" # cpa-manager-plus:codex-speed:v1:standard\n          protocol: codex\n      params: [service_tier]\n    - models: [{name: "*", protocol: claude}]\n      params: [temperature]\n`;
    expect(inspectCodexSpeedConfig(legacy)).toEqual({
      mode: 'standard',
      conflict: false,
      needsMigration: true,
    });
    const updated = updateCodexSpeedConfig(legacy, 'standard');
    expect(parse(updated).payload.filter).toEqual([
      { models: [{ name: '*', protocol: 'claude' }], params: ['temperature'] },
    ]);
    expect(inspectCodexSpeedConfig(updated)).toEqual({ mode: 'standard', conflict: false });
    expectConflict(legacy.replace('params: [service_tier]', 'params: [service_tier, temperature]'));
  });

  it('does not change an unconfigured document or rewrite a no-op selection', () => {
    expect(inspectCodexSpeedConfig(baseline)).toEqual({ mode: 'standard', conflict: false });
    expect(updateCodexSpeedConfig(baseline, 'standard')).toBe(baseline);
  });

  it.each(modes.flatMap((from) => modes.map((to) => [from, to] as const)))(
    'switches %s to %s and survives a fresh inspection',
    (from, to) => {
      const initial = updateCodexSpeedConfig(baseline, from);
      const updated = updateCodexSpeedConfig(initial, to);
      expect(inspectCodexSpeedConfig(updated)).toEqual({ mode: to, conflict: false });
      expect(updateCodexSpeedConfig(updated, to)).toBe(updated);
      expect(updated).toContain('# Keep the operator notes');
      expect(parse(updated)).toMatchObject({ port: 8317, 'future-setting': { enabled: true } });
      const payload = parse(updated).payload ?? {};
      const defaults = payload.default ?? [];
      const overrides = payload.override ?? [];
      const filters = payload.filter ?? [];
      expect(defaults).toEqual(
        to === 'fast'
          ? [
              {
                models: ['codex', 'openai', 'openai-response'].map((protocol) => ({
                  name: '*',
                  protocol,
                })),
                params: { service_tier: 'priority' },
              },
            ]
          : []
      );
      expect(overrides).toEqual([]);
      expect(filters).toEqual([]);
    }
  );

  it('preserves unrelated rules, unknown fields, comments and harmless anchors', () => {
    const original = `${baseline}shared: &shared {keep: true}\ncopy: *shared\npayload:\n  future-rule: {keep: true}\n  override: # User overrides\n    # Keep this rule\n    - models: [{name: "*", protocol: claude}]\n      params: {service_tier: default}\n    - models: [{name: "*", protocol: codex}]\n      params: {reasoning.effort: high}\n`;
    const enabled = updateCodexSpeedConfig(original, 'fast');
    const restored = updateCodexSpeedConfig(enabled, 'standard');
    expect(parse(restored)).toEqual(parse(original));
    for (const comment of ['# Keep the operator notes', '# User overrides', '# Keep this rule']) {
      expect(restored).toContain(comment);
    }
    expect(restored).toContain('&shared');
    expect(restored).toContain('*shared');
  });

  it('preserves large integer values in unknown configuration fields', () => {
    const source = `${baseline}future-limit: 9223372036854775807\nfuture-mask: 0xabcdef1234567890\nfuture-negative: -9007199254740993\nfuture-tagged: !!int 9007199254740993\n`;
    const updated = updateCodexSpeedConfig(source, 'fast');
    const before = parse(source, { intAsBigInt: true });
    const after = parse(updated, { intAsBigInt: true });
    for (const key of ['future-limit', 'future-mask', 'future-negative', 'future-tagged']) {
      expect(after[key]).toEqual(before[key]);
    }
  });

  it.each(groups)('rejects unowned service_tier in %s', (group) => {
    expectConflict(
      customRule(group, group === 'filter' ? ['service_tier'] : { service_tier: 'priority' })
    );
  });

  it.each(groups)(
    'allows %s service_tier rules explicitly restricted to other protocols',
    (group) => {
      const source = customRule(
        group,
        group === 'filter' ? ['service_tier'] : { service_tier: 'priority' },
        'claude'
      );
      expect(inspectCodexSpeedConfig(updateCodexSpeedConfig(source, 'fast')).mode).toBe('fast');
    }
  );

  it.each(['codex', ' CODEX ', 'openai', 'openai-response', '*'])(
    'rejects potentially Codex-applicable protocol %s',
    (protocol) => {
      expectConflict(customRule('override', { service_tier: 'priority' }, protocol));
    }
  );

  it.each([
    '',
    '.',
    '$',
    '*',
    'service_*',
    'service_?ier',
    'response.service_tier',
    'service\\_tier',
    '@this',
  ])('rejects ambiguous, wildcard or service tier path %s', (path) => {
    expectConflict(customRule('override', { [path]: 'priority' }, 'codex'));
    expectConflict(customRule('filter', [path], 'codex'));
  });

  it.each(['default-raw', 'override-raw'])(
    'rejects nested and encoded raw tier writes in %s',
    (group) => {
      expectConflict(customRule(group, { response: '{"service_tier":"priority"}' }, 'codex'));
      expectConflict(customRule(group, { response: '{"service_\\u0074ier":"priority"}' }, 'codex'));
      expectConflict(customRule(group, { response: { service_tier: 'priority' } }, 'codex'));
    }
  );

  it.each([
    (source: string) => source.replace('protocol: codex', 'protocol: claude'),
    (source: string) => source.replace('service_tier: priority', 'service_tier: default'),
    (source: string) => source.replace('v2:fast', 'v3:fast'),
    (source: string) =>
      source.replace('service_tier: priority', 'service_tier: priority\n        temperature: 1'),
    (source: string) => source.replace('protocol: codex', 'protocol: codex # User note'),
    (source: string) => source.replace('models:', 'headers: {X-Test: yes}\n      models:'),
  ])('blocks externally modified owned rules', (modify) => {
    expectConflict(modify(updateCodexSpeedConfig(baseline, 'fast')));
  });

  it('rejects duplicated ownership markers and marker placement outside the owned rule', () => {
    const source = updateCodexSpeedConfig(baseline, 'fast');
    const ruleStart = source.indexOf('    - models:');
    expect(ruleStart).toBeGreaterThan(0);
    expectConflict(source + source.slice(ruleStart));
    expectConflict(`${baseline}# cpa-manager-plus:codex-speed:v1:fast\n`);
  });

  it.each([
    'payload: &payload {}\n',
    'rules: &rules []\npayload: {override: *rules}\n',
    'defaults: &defaults {payload: {}}\n<<: *defaults\n',
    'payload:\n  <<: {override: []}\n',
    'payload:\n  override:\n    - models: &models [{name: "*", protocol: codex}]\n      params: {reasoning.effort: high}\n',
  ])('rejects aliases, anchors or merges that make payload ownership ambiguous', (source) => {
    expectConflict(source);
  });

  it.each([
    'port: [',
    'port: 8317\nport: 8318\n',
    'port: 8317\n---\nport: 8318\n',
    '[]',
    'payload: []',
    'payload: {override: {params: {service_tier: priority}}}',
    'payload: {filter: [false]}',
  ])('returns a conflict for invalid or unsupported config', (source) => {
    expectConflict(source);
  });

  it('handles empty documents and empty payload sections', () => {
    for (const source of [
      '',
      '# Empty config\n',
      'payload: null\n',
      'payload: {override: null}\n',
    ]) {
      expect(inspectCodexSpeedConfig(updateCodexSpeedConfig(source, 'fast')).mode).toBe('fast');
    }
  });

  it('never includes source text or parser errors in public errors', () => {
    const secret = 'synthetic-private-value-do-not-show';
    const source = `api-key: ${secret}\npayload: [broken`;
    expect(JSON.stringify(inspectCodexSpeedConfig(source))).not.toContain(secret);
    expect(() => updateCodexSpeedConfig(source, 'fast')).toThrow(
      'Codex speed configuration is unsafe to edit.'
    );
  });
});
