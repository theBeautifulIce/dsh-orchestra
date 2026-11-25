import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assertClientInject, CLIENT_INJECT_PROTOCOLS, CLIENT_INJECT_ROLES,
} from '../package-contract.mjs';

const candidate = CLIENT_INJECT_PROTOCOLS[CLIENT_INJECT_ROLES.candidate];
const previous = CLIENT_INJECT_PROTOCOLS[CLIENT_INJECT_ROLES.previous];
const manifestUrl = new URL('../../../package.json', import.meta.url);
const repositoryManifest = existsSync(manifestUrl) ? JSON.parse(readFileSync(manifestUrl, 'utf8')) : null;

test('current repository manifest matches the shared candidate contract exactly', {
  skip: repositoryManifest?.name === 'dsh-orchestra' ? false : 'Repository manifest is not included in a standalone updater copy',
}, () => {
  assert.equal(candidate.length, 12);
  assert.equal(previous.length, 6);
  assert.deepEqual([...repositoryManifest.dsh.client.inject].sort(), [...candidate].sort());
  assert.equal(assertClientInject(repositoryManifest.dsh.client.inject), CLIENT_INJECT_ROLES.candidate);
});

test('the pinned G5 predecessor requires its explicit previous role', () => {
  assert.equal(assertClientInject([...previous].reverse(), 'previous'), CLIENT_INJECT_ROLES.previous);
  assert.throws(() => assertClientInject(previous), /role "candidate".*Missing entries/);
  assert.throws(() => assertClientInject(candidate, 'previous'), /role "previous".*Unknown entries/);
});

test('candidate validation accepts reordering but requires every current dependency', () => {
  assert.equal(assertClientInject([...candidate].reverse()), CLIENT_INJECT_ROLES.candidate);
  for (const dependency of candidate) {
    assert.throws(() => assertClientInject(candidate.filter((item) => item !== dependency)),
      (error) => error.message.includes('Missing entries: ' + dependency));
  }
});

test('known seven- and nine-entry manifests never select an older candidate protocol', () => {
  for (const protocol of ['dsh-orchestra/client-inject/slash/v1', 'dsh-orchestra/client-inject/conversation/v1']) {
    assert.throws(() => assertClientInject(CLIENT_INJECT_PROTOCOLS[protocol]), (error) =>
      error.message.includes('Manifest matches "' + protocol + '"')
      && error.message.includes('rebuild from current main'));
  }
  const removedWorkbenchClients = candidate.filter((item) => ![
    '@deepseek-ai/dsh-client-ui-sidebar-right',
    '@deepseek-ai/dsh-client-ui-sidebar-browser',
    '@deepseek-ai/dsh-client-ui-commands',
  ].includes(item));
  assert.deepEqual(removedWorkbenchClients, CLIENT_INJECT_PROTOCOLS['dsh-orchestra/client-inject/conversation/v1']);
  assert.throws(() => assertClientInject(removedWorkbenchClients), /Older or incomplete manifests are not auto-selected/);
});

test('contract rejects duplicates, unknown names, non-string members and non-array values', () => {
  assert.throws(() => assertClientInject([...candidate, candidate[0]]), /Duplicate entries/);
  assert.throws(() => assertClientInject([...candidate.slice(0, -1), candidate[0]]), /Duplicate entries/);
  assert.throws(() => assertClientInject([...candidate, '@deepseek-ai/dsh-client-ui-unknown']), /Unknown entries/);
  for (const value of [42, null, {}, ['@deepseek-ai/dsh-client-ui-commands']]) {
    assert.throws(() => assertClientInject([...candidate.slice(0, -1), value]), /Non-string entries at indexes: 11/);
  }
  for (const value of [undefined, null, candidate.join(','), { ...candidate }]) {
    assert.throws(() => assertClientInject(value), /client.inject must be an array of strings/);
  }
  assert.throws(() => assertClientInject(candidate, 'legacy'), /Unknown DSH client inject package role: legacy/);
});
