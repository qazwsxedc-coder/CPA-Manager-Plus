import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Document,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';

export type CodexSpeedMode = 'client' | 'standard' | 'fast';

const markerPrefix = 'cpa-manager-plus:codex-speed:';
const groups = ['default', 'default-raw', 'override', 'override-raw', 'filter'] as const;
const unsafeMessage = 'Codex speed configuration is unsafe to edit.';

type OwnedRule = { mode: Exclude<CodexSpeedMode, 'client'>; list: YAMLSeq; index: number };
type Inspection = {
  mode: CodexSpeedMode | null;
  conflict: boolean;
  reason?: string;
};

function unsafe(): never {
  // YAML parser messages may quote credentials. Never expose them to a toast or log.
  throw new Error(unsafeMessage);
}

function isEmpty(node: unknown) {
  return node === undefined || node === null || (isScalar(node) && node.value === null);
}

function comments(node: { comment?: string | null; commentBefore?: string | null }) {
  return [node.commentBefore, node.comment].filter((value): value is string => Boolean(value));
}

function hasExactKeys(node: unknown, keys: string[]): node is YAMLMap {
  return isMap(node) && node.items.length === keys.length && keys.every((key) => node.has(key));
}

function isValue(node: unknown, value: string) {
  return isScalar(node) && node.value === value;
}

function rejectAmbiguousPayload(node: unknown) {
  if (!isNode(node)) return;
  visit(node, (_key, child) => {
    if (isAlias(child) || (isNode(child) && 'anchor' in child && child.anchor)) unsafe();
    if (isMap(child) && child.has('<<')) unsafe();
  });
}

function ownershipMode(rule: YAMLMap, group: string): OwnedRule['mode'] | null {
  const ruleComments: string[] = [];
  visit(rule, (_key, node) => {
    if (isNode(node)) ruleComments.push(...comments(node));
  });
  if (!ruleComments.some((comment) => comment.includes(markerPrefix))) return null;
  if (!hasExactKeys(rule, ['models', 'params'])) unsafe();
  const models = rule.get('models', true);
  if (!isSeq(models) || models.items.length !== 1) unsafe();
  const model = models.items[0];
  if (!hasExactKeys(model, ['name', 'protocol'])) unsafe();
  const name = model.get('name', true);
  if (!isValue(name, '*') || !isValue(model.get('protocol', true), 'codex')) unsafe();

  const mode = group === 'override' ? 'fast' : group === 'filter' ? 'standard' : null;
  if (!mode) unsafe();
  const expectedMarker = `${markerPrefix}v1:${mode}`;
  // A fixed location and exact version/shape prevent adopting or deleting user rules.
  if (!isScalar(name) || name.comment?.trim() !== expectedMarker) unsafe();
  if (ruleComments.length !== 1 || ruleComments[0].trim() !== expectedMarker) unsafe();

  const params = rule.get('params', true);
  if (mode === 'fast') {
    if (
      !hasExactKeys(params, ['service_tier']) ||
      !isValue(params.get('service_tier', true), 'priority')
    )
      unsafe();
  } else if (
    !isSeq(params) ||
    params.items.length !== 1 ||
    !isValue(params.items[0], 'service_tier')
  ) {
    unsafe();
  }
  return mode;
}

function mayApplyToCodex(rule: YAMLMap) {
  const models = rule.get('models', true);
  if (!isSeq(models) || models.items.length === 0) return true;
  return models.items.some((model) => {
    if (!isMap(model)) return true;
    const protocol = model.get('protocol', true);
    if (!isScalar(protocol) || typeof protocol.value !== 'string') return true;
    const value = protocol.value.trim().toLowerCase();
    return value === '' || value === 'codex' || /[*?]/.test(value);
  });
}

function mayTouchTier(path: unknown) {
  if (typeof path !== 'string') return true;
  const normalized = path.replace(/\\/g, '').trim().toLowerCase();
  return (
    normalized === '' ||
    /^[.$]+$/.test(normalized) ||
    /[*?@#]/.test(normalized) ||
    normalized.includes('service_tier')
  );
}

function nestedTier(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(nestedTier);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, child]) => mayTouchTier(key) || nestedTier(child));
  }
  return false;
}

function paramsMayTouchTier(rule: YAMLMap, group: string) {
  const params = rule.get('params', true);
  if (isEmpty(params)) return false;
  if (group === 'filter') {
    if (!isSeq(params)) return true;
    return params.items.some((path) => !isScalar(path) || mayTouchTier(path.value));
  }
  if (!isMap(params)) return true;
  return params.items.some(({ key, value }) => {
    if (!isScalar(key) || mayTouchTier(key.value)) return true;
    if (isMap(value) || isSeq(value)) return nestedTier(value.toJSON());
    if (group.endsWith('-raw')) {
      if (!isScalar(value) || typeof value.value !== 'string') return true;
      try {
        return nestedTier(JSON.parse(value.value));
      } catch {
        return true;
      }
    }
    return false;
  });
}

function analyze(source: string) {
  const doc: Document = parseDocument(source, { intAsBigInt: true });
  if (doc.errors.length || doc.warnings.length) unsafe();
  const root = doc.contents;
  if (!isEmpty(root) && !isMap(root)) unsafe();
  if (isMap(root) && (root.anchor || root.has('<<'))) unsafe();
  const payload: unknown = isMap(root) ? root.get('payload', true) : undefined;
  if (!isEmpty(payload) && !isMap(payload)) unsafe();
  rejectAmbiguousPayload(payload);

  let markerCount = comments(doc).filter((comment) => comment.includes(markerPrefix)).length;
  visit(doc, (_key, node) => {
    if (isNode(node))
      markerCount += comments(node).filter((comment) => comment.includes(markerPrefix)).length;
  });
  let owned: OwnedRule | null = null;
  if (isMap(payload)) {
    for (const group of groups) {
      const list = payload.get(group, true);
      if (isEmpty(list)) continue;
      if (!isSeq(list)) unsafe();
      for (let index = 0; index < list.items.length; index += 1) {
        const rule = list.items[index];
        if (!isMap(rule)) unsafe();
        const mode = ownershipMode(rule, group);
        if (mode) {
          if (owned) unsafe();
          owned = { mode, list, index };
        } else if (mayApplyToCodex(rule) && paramsMayTouchTier(rule, group)) {
          unsafe();
        }
      }
    }
  }
  if (markerCount !== (owned ? 1 : 0)) unsafe();
  const mode: CodexSpeedMode = owned?.mode ?? 'client';
  return { doc, payload, owned, mode };
}

export function inspectCodexSpeedConfig(source: string): Inspection {
  try {
    const { mode } = analyze(source);
    return { mode, conflict: false };
  } catch {
    return { mode: null, conflict: true, reason: unsafeMessage };
  }
}

function retainComments(previous: unknown, next: YAMLMap | YAMLSeq) {
  if (!isNode(previous)) return;
  next.comment = previous.comment;
  next.commentBefore = previous.commentBefore;
}

export function updateCodexSpeedConfig(source: string, mode: CodexSpeedMode): string {
  try {
    if (mode !== 'client' && mode !== 'standard' && mode !== 'fast') unsafe();
    const { doc, payload, owned, mode: currentMode } = analyze(source);
    if (currentMode === mode) return source;
    if (owned) owned.list.delete(owned.index);
    if (mode !== 'client') {
      let root = doc.contents;
      if (!isMap(root)) {
        const nextRoot = doc.createNode({});
        retainComments(root, nextRoot);
        doc.contents = nextRoot;
        root = nextRoot;
      }
      const nextPayload: YAMLMap = isMap(payload) ? payload : doc.createNode({});
      if (!isMap(payload)) {
        retainComments(payload, nextPayload);
        root.set('payload', nextPayload);
      }
      const group = mode === 'fast' ? 'override' : 'filter';
      const previousList = nextPayload.get(group, true);
      const list: YAMLSeq = isSeq(previousList) ? previousList : doc.createNode([]);
      if (!isSeq(previousList)) {
        retainComments(previousList, list);
        nextPayload.set(group, list);
      }
      const rule = doc.createNode({
        models: [{ name: '*', protocol: 'codex' }],
        params: mode === 'fast' ? { service_tier: 'priority' } : ['service_tier'],
      });
      const name = rule.getIn(['models', 0, 'name'], true);
      if (!isScalar(name)) unsafe();
      name.comment = ` ${markerPrefix}v1:${mode}`;
      list.add(rule);
    }
    const output = doc.toString();
    // Verify marker round-tripping before handing a config to the API layer.
    if (analyze(output).mode !== mode) unsafe();
    return output;
  } catch {
    return unsafe();
  }
}
