// POST /send-mini-app hardening tests: policy comes from the config file,
// sends are MULTI with a sliding rate limit, URL policy is https-prefix
// based. All fixtures are synthetic (see test-harness.mjs); assertion
// messages never contain space-id values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSidecar, approvedSpace, approvedUrl } from './test-harness.mjs';

const enabled = { PHOTON_MINI_APPS: 'true' };
const send = (req, body, opts) => req('/send-mini-app', { body, ...opts });

test('approved request uses the real SDK live app builder with mock transport', async () => {
  await runSidecar(enabled, async ({ req, readCapture }) => {
    const r = await send(req, { spaceId: approvedSpace, url: approvedUrl });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).messageId, 'mock-app-id');
    const captured = readCapture();
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, approvedUrl);
  });
});

test('resolver errors do not leak sensitive details', async () => {
  await runSidecar({ ...enabled, MOCK_MODE: 'resolve-fail' }, async ({ req, logs }) => {
    const r = await send(req, { spaceId: approvedSpace, url: approvedUrl });
    assert.equal(r.status, 500);
    assert.equal(JSON.parse(r.body).retryable, false);
    assert.equal(r.body.includes('private-error-marker'), false);
    assert.equal(logs().includes('private-error-marker'), false);
    assert.equal(logs().includes(approvedSpace), false);
  });
});

test('gate defaults closed and requires exact true', async () => {
  for (const gate of [undefined, '', '1', 'TRUE']) {
    await runSidecar(gate === undefined ? {} : { PHOTON_MINI_APPS: gate }, async ({ req }) => {
      assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 400);
    });
  }
});

test('authentication and method are enforced', async () => {
  await runSidecar(enabled, async ({ req }) => {
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl }, { token: 'wrong' })).status, 401);
    assert.equal((await req('/send-mini-app', { method: 'GET' })).status, 405);
  });
});

test('send failure is generic and not retryable', async () => {
  await runSidecar({ ...enabled, MOCK_MODE: 'send-fail' }, async ({ req, logs }) => {
    const r = await send(req, { spaceId: approvedSpace, url: approvedUrl });
    assert.equal(r.status, 500);
    assert.equal(JSON.parse(r.body).retryable, false);
    assert.equal(r.body.includes('private-error-marker'), false);
    assert.equal(logs().includes('private-error-marker'), false);
  });
});

test('multiple approved sends all succeed (no one-shot guard)', async () => {
  await runSidecar(enabled, async ({ req, readCapture }) => {
    for (let i = 0; i < 3; i++) {
      const r = await send(req, { spaceId: approvedSpace, url: approvedUrl });
      assert.equal(r.status, 200, `send ${i}`);
      assert.equal(JSON.parse(r.body).messageId, 'mock-app-id');
    }
    assert.equal(readCapture().length, 3);
  });
});

test('a failed send does not poison later attempts', async () => {
  await runSidecar({ ...enabled, MOCK_MODE: 'send-fail' }, async ({ req }) => {
    const request = { spaceId: approvedSpace, url: approvedUrl };
    assert.equal((await send(req, request)).status, 500);
    // No one-shot guard: the second attempt reaches the SDK again (500, not 400).
    assert.equal((await send(req, request)).status, 500);
  });
});

test('recipient and URL policy validation (exact space, https prefix)', async () => {
  await runSidecar(enabled, async ({ req }) => {
    const rejected = [
      { spaceId: 'test-space', url: approvedUrl },
      { spaceId: approvedSpace + ' ', url: approvedUrl },
      { spaceId: ' ' + approvedSpace, url: approvedUrl },
      { spaceId: '', url: approvedUrl },
      { spaceId: 42, url: approvedUrl },
      { spaceId: approvedSpace, url: null },
      { spaceId: approvedSpace, url: 'http://example.com' },
      { spaceId: approvedSpace, url: 'https://user:pass@example.com' },
      { spaceId: approvedSpace, url: 'junk' },
      { spaceId: approvedSpace, url: ' ' + approvedUrl },
      { spaceId: approvedSpace, url: approvedUrl + ' ' },
      { spaceId: approvedSpace, url: 'https://evil.example.net/' },
      { spaceId: approvedSpace },                    // missing url
      { url: approvedUrl },                          // missing spaceId
      { spaceId: approvedSpace, url: approvedUrl, extra: 1 }, // strict keys
    ];
    for (let i = 0; i < rejected.length; i++) {
      assert.equal((await send(req, rejected[i])).status, 400, `rejected case ${i}`);
    }
    // Prefix semantics: query strings and subpaths UNDER the prefix are allowed.
    for (const url of [approvedUrl + '?x=1', approvedUrl + 'sub/page']) {
      assert.equal((await send(req, { spaceId: approvedSpace, url })).status, 200, url);
    }
  });
});