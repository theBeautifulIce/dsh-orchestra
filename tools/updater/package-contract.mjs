// Shared by repository package acceptance and the standalone updater.
// Protocol IDs describe exact sets. Package version strings do not select a
// protocol: historical and current builds can advertise the same npm version.
const g5 = Object.freeze([
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-workspace',
]);
const slash = Object.freeze([...g5,
  '@deepseek-ai/dsh-client-ui-input-trigger',
]);
const conversation = Object.freeze([...slash,
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-chat',
]);
const workbench = Object.freeze([...conversation,
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-sidebar-browser',
  '@deepseek-ai/dsh-client-ui-commands',
]);

export const CLIENT_INJECT_PROTOCOLS = Object.freeze({
  'dsh-orchestra/client-inject/g5/v1': g5,
  'dsh-orchestra/client-inject/slash/v1': slash,
  'dsh-orchestra/client-inject/conversation/v1': conversation,
  'dsh-orchestra/client-inject/workbench/v1': workbench,
});

export const CLIENT_INJECT_ROLES = Object.freeze({
  candidate: 'dsh-orchestra/client-inject/workbench/v1',
  // Only the repository's explicitly selected, pinned G5 rehearsal predecessor.
  previous: 'dsh-orchestra/client-inject/g5/v1',
});

/**
 * Validate an exact, unique set of string dependencies. The caller selects the
 * role; never infer an older role from missing candidate entries. In particular,
 * current minus its three workbench dependencies is indistinguishable from an
 * old nine-entry manifest, so the updater must reject both as candidates.
 * @param {unknown} inject
 * @param {'candidate' | 'previous'} [role]
 */
export function assertClientInject(inject, role = 'candidate') {
  if (typeof role !== 'string' || !Object.hasOwn(CLIENT_INJECT_ROLES, role)) {
    throw new Error('Unknown DSH client inject package role: ' + String(role));
  }
  const protocol = CLIENT_INJECT_ROLES[role];
  const expected = CLIENT_INJECT_PROTOCOLS[protocol];
  const fail = (detail) => {
    throw new Error('DSH client inject must contain exactly the entries of "' + protocol
      + '" for role "' + role + '". ' + detail);
  };
  if (!Array.isArray(inject)) fail('client.inject must be an array of strings.');
  const invalid = Array.from(inject).flatMap((item, index) => typeof item === 'string' ? [] : [index]);
  if (invalid.length) fail('Non-string entries at indexes: ' + invalid.join(', ') + '.');
  const unique = new Set(inject);
  const duplicates = [...unique].filter((item) => inject.indexOf(item) !== inject.lastIndexOf(item));
  if (duplicates.length) fail('Duplicate entries: ' + duplicates.join(', ') + '.');
  const missing = expected.filter((item) => !unique.has(item));
  const unknown = inject.filter((item) => !expected.includes(item));
  if (missing.length || unknown.length) {
    const recognized = Object.entries(CLIENT_INJECT_PROTOCOLS).find(([, entries]) =>
      entries.length === unique.size && entries.every((item) => unique.has(item)))?.[0];
    const details = [];
    if (recognized) {
      details.push('Manifest matches "' + recognized + '", which is not allowed for this role.');
      if (role === 'candidate') {
        details.push('Older or incomplete manifests are not auto-selected; rebuild from current main.');
      }
    }
    if (missing.length) details.push('Missing entries: ' + missing.join(', ') + '.');
    if (unknown.length) details.push('Unknown entries: ' + unknown.join(', ') + '.');
    fail(details.join(' '));
  }
  return protocol;
}
