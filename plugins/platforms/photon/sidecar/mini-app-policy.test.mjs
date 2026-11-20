// Policy tests: config fail-closed, mtime hot-reload, prefix matching
// semantics, multi-send sliding rate limit, inject config regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  runSidecar, defaultConfig, approvedSpace, approvedUrl,
  fakeSpace, fakeSpace2, fakePrefix,
} from './test-harness.mjs';

const miniEnabled = { PHOTON_MINI_APPS: 'true' };
const bothEnabled = { PHOTON_MINI_APPS: 'true', PHOTON_INJECT_ENABLED: 'true' };
const send = (req, body) => req('/send-mini-app', { body });
const inject = (req, body) => req('/inject', { body });
const fakeConfig = { allowedSpaces: [fakeSpace], allowedUrlPrefixes: [fakePrefix] };

test('send-mini-app fails closed when the policy config is missing', async () => {
  await runSidecar(miniEnabled, async ({ req }) => {
    const r = await send(req, { spaceId: approvedSpace, url: approvedUrl });
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.body).ok, false);
  }, { config: null });
});

test('send-mini-app fails closed on malformed, wrong-schema, or world-readable config', async () => {
  await runSidecar(miniEnabled, async ({ req, configPath, setConfig }) => {
    const bad = '{corrupt';
    fs.writeFileSync(configPath, bad);
    fs.chmodSync(configPath, 0o600);
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 503, 'corrupt');
    setConfig({ allowedSpaces: 'nope', allowedUrlPrefixes: [approvedUrl] });
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 503, 'wrong schema');
    setConfig({ allowedSpaces: [], allowedUrlPrefixes: [approvedUrl] });
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 503, 'empty spaces');
    setConfig(defaultConfig);
    fs.chmodSync(configPath, 0o644);
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 503, 'world-readable');
    fs.chmodSync(configPath, 0o600);
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 200, 'restored');
  });
});

test('send-mini-app policy hot-reloads from the config file (no restart)', async () => {
  await runSidecar(miniEnabled, async ({ req, setConfig }) => {
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 200);
    // Rotate to a policy that excludes the approved space and URL.
    setConfig(fakeConfig);
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 400, 'space rotated out');
    assert.equal((await send(req, { spaceId: fakeSpace, url: fakePrefix })).status, 200, 'new policy active');
    // Rotate back.
    setConfig(defaultConfig);
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 200, 'restored');
  });
});

test('URL prefix matching is exact-startsWith under an https prefix', async () => {
  const prefix = 'https://demo.example.ts.net:18443/app';
  await runSidecar(miniEnabled, async ({ req, readCapture }) => {
    const allowed = [
      prefix,                          // exact prefix
      prefix + '/',                    // trailing slash
      prefix + '?x=1',                 // query
      prefix + '/deep/page',           // subpath
      prefix + 'lication',             // documented startsWith semantics
    ];
    for (let i = 0; i < allowed.length; i++) {
      const r = await send(req, { spaceId: fakeSpace, url: allowed[i] });
      assert.equal(r.status, 200, `allowed case ${i}`);
    }
    const rejected = [
      'https://demo.example.ts.net:18443/other',   // outside prefix
      'https://demo.example.ts.net:18443/',        // parent of prefix
      'http://demo.example.ts.net:18443/app',      // not https
      'https://evil.example.net/app',              // different host
      'https://demo.example.ts.net:18443/app#frag@evil', // still under prefix? no: starts with prefix -> allowed actually
    ];
    // NOTE: the last entry DOES start with the prefix, so it is allowed by
    // design (fragment is client-side only). Test it as allowed instead.
    assert.equal((await send(req, { spaceId: fakeSpace, url: rejected.pop() })).status, 200);
    for (let i = 0; i < rejected.length; i++) {
      assert.equal((await send(req, { spaceId: fakeSpace, url: rejected[i] })).status, 400, `rejected case ${i}`);
    }
    // Everything that passed policy reached the SDK as a live app card.
    assert.equal(readCapture().length, allowed.length + 1);
  }, { config: { allowedSpaces: [fakeSpace], allowedUrlPrefixes: [prefix] } });
});

test('multiple URL prefixes and multiple spaces are honored', async () => {
  const cfg = {
    allowedSpaces: [fakeSpace, fakeSpace2],
    allowedUrlPrefixes: [fakePrefix, 'https://second.example.ts.net/'],
  };
  await runSidecar(miniEnabled, async ({ req }) => {
    assert.equal((await send(req, { spaceId: fakeSpace2, url: 'https://second.example.ts.net/x' })).status, 200);
    assert.equal((await send(req, { spaceId: fakeSpace, url: fakePrefix })).status, 200);
    assert.equal((await send(req, { spaceId: fakeSpace2, url: fakePrefix })).status, 200);
    assert.equal((await send(req, { spaceId: approvedSpace, url: fakePrefix })).status, 400, 'unlisted space');
    assert.equal((await send(req, { spaceId: fakeSpace, url: 'https://third.example.net/' })).status, 400, 'unlisted prefix');
  }, { config: cfg });
});

test('send-mini-app sliding rate limit defaults to 10 per minute', async () => {
  await runSidecar(miniEnabled, async ({ req }) => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 200, `send ${i}`);
    }
    const r = await send(req, { spaceId: approvedSpace, url: approvedUrl });
    assert.equal(r.status, 429);
    assert.equal(JSON.parse(r.body).ok, false);
  });
});

test('send-mini-app rate limit is tunable and the window recovers', async () => {
  await runSidecar({ ...miniEnabled, PHOTON_MINI_APP_RATE_LIMIT: '2', PHOTON_MINI_APP_RATE_WINDOW_MS: '400' }, async ({ req }) => {
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 200);
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 200);
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 429);
    await new Promise(r => setTimeout(r, 500));
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 200);
  });
});

test('rejected sends do not consume rate-limit budget', async () => {
  await runSidecar({ ...miniEnabled, PHOTON_MINI_APP_RATE_LIMIT: '2' }, async ({ req }) => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await send(req, { spaceId: 'wrong', url: approvedUrl })).status, 400);
      assert.equal((await send(req, { spaceId: approvedSpace, url: 'https://evil.example.net/' })).status, 400);
    }
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 200);
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 200);
    assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 429);
  });
});

test('send and inject rate budgets are independent', async () => {
  await runSidecar({ ...bothEnabled, PHOTON_MINI_APP_RATE_LIMIT: '1', PHOTON_INJECT_RATE_LIMIT: '1' }, async ({ req, consume }) => {
    const consumer = await consume();
    try {
      assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 200);
      assert.equal((await send(req, { spaceId: approvedSpace, url: approvedUrl })).status, 429);
      // Inject budget untouched by the exhausted send budget.
      assert.equal((await inject(req, { spaceId: approvedSpace, text: 'press' })).status, 200);
      await consumer.nextLine();
      assert.equal((await inject(req, { spaceId: approvedSpace, text: 'press' })).status, 429);
    } finally { await consumer.close(); }
  });
});

test('inject fails closed when the policy config is missing or invalid', async () => {
  await runSidecar({ PHOTON_INJECT_ENABLED: 'true' }, async ({ req, setConfig }) => {
    const r = await inject(req, { spaceId: approvedSpace, text: 'hi' });
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.body).ok, false);
  }, { config: null });
  await runSidecar({ PHOTON_INJECT_ENABLED: 'true' }, async ({ req, setConfig }) => {
    setConfig(fakeConfig); // approved space no longer listed
    assert.equal((await inject(req, { spaceId: approvedSpace, text: 'hi' })).status, 400);
    assert.equal((await inject(req, { spaceId: fakeSpace, text: 'hi' })).status, 503, 'no consumer yet');
  });
});

test('inject honors a multi-space config allowlist (regression)', async () => {
  const cfg = { allowedSpaces: [fakeSpace, fakeSpace2], allowedUrlPrefixes: [fakePrefix] };
  await runSidecar({ PHOTON_INJECT_ENABLED: 'true' }, async ({ req, consume }) => {
    const consumer = await consume();
    try {
      for (const spaceId of [fakeSpace, fakeSpace2]) {
        const r = await inject(req, { spaceId, text: 'Mini app button pressed: add-one' });
        assert.equal(r.status, 200);
        const event = JSON.parse(await consumer.nextLine());
        assert.equal(event.space.id, spaceId);
        assert.equal(event.space.type, 'dm');
        assert.equal(event.space.phone, spaceId.slice('any;-;'.length));
      }
      assert.equal((await inject(req, { spaceId: approvedSpace, text: 'x' })).status, 400, 'not in this config');
    } finally { await consumer.close(); }
  }, { config: cfg });
});

test('send-mini-app rejections never leak the token or the full phone number', async () => {
  await runSidecar(miniEnabled, async ({ req, logs }) => {
    const r = await send(req, { spaceId: approvedSpace + ' ', url: approvedUrl });
    assert.equal(r.status, 400);
    assert.equal(r.body.includes('test-token'), false);
    assert.equal(r.body.includes(approvedSpace.slice('any;-;'.length)), false);
    assert.equal(logs().includes('test-token'), false);
    assert.equal(logs().includes(approvedSpace.slice('any;-;'.length)), false);
  });
});
