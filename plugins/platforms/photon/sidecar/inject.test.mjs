// POST /inject tests: gate, auth, strict body, text sanitization, rate limit,
// consumer-present check, and the exact adapter-shaped inbound event. The
// allowlist comes from the policy config file (temp copy per run, synthetic
// fixtures — see test-harness.mjs). Assertion messages never contain
// space-id values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSidecar, approvedSpace, approvedPhone, approvedUrl } from './test-harness.mjs';

const inject = (req, body, opts) => req('/inject', { body, ...opts });
const enabled = { PHOTON_INJECT_ENABLED: 'true' };

test('inject gate defaults closed and requires exact true', async () => {
  for (const gate of [undefined, '', '1', 'TRUE', 'yes']) {
    await runSidecar(gate === undefined ? {} : { PHOTON_INJECT_ENABLED: gate }, async ({ req }) => {
      const r = await inject(req, { spaceId: approvedSpace, text: 'hello' });
      assert.equal(r.status, 400, `gate=${gate}`);
    });
  }
});

test('inject requires the sidecar token and POST', async () => {
  await runSidecar(enabled, async ({ req }) => {
    assert.equal((await inject(req, { spaceId: approvedSpace, text: 'hi' }, { token: 'wrong' })).status, 401);
    assert.equal((await req('/inject', { method: 'GET' })).status, 405);
  });
});

test('inject accepts only exact allowlisted chat ids from the config', async () => {
  await runSidecar(enabled, async ({ req }) => {
    const variants = [
      'any;-;+' + '1000' + '0000000',      // different number
      approvedSpace + ' ',                 // trailing whitespace
      ' ' + approvedSpace,                 // leading whitespace
      approvedPhone,                       // bare E.164 is NOT accepted here
      'any;-;' + approvedPhone.slice(0, -1) + '0', // one digit off
      'some-group-guid', '', null, 42,
    ];
    for (let i = 0; i < variants.length; i++) {
      const r = await inject(req, { spaceId: variants[i], text: 'hi' });
      assert.equal(r.status, 400, `spaceId variant ${i} rejected`);
    }
  });
});

test('inject body must contain only spaceId and text', async () => {
  await runSidecar(enabled, async ({ req }) => {
    assert.equal((await inject(req, { spaceId: approvedSpace, text: 'hi', extra: 1 })).status, 400);
    assert.equal((await inject(req, { spaceId: approvedSpace })).status, 400);
    assert.equal((await inject(req, { text: 'hi' })).status, 400);
    assert.equal((await inject(req, {})).status, 400);
  });
});

test('inject validates and sanitizes text', async () => {
  await runSidecar(enabled, async ({ req }) => {
    const bad = [
      undefined, null, 42, '', '   ', '\n', 'a\nb', 'a\tb', 'a\x00b', 'a\x7fb',
      'a\u0085b', '\ufffc', 'x'.repeat(501),
    ];
    for (let i = 0; i < bad.length; i++) {
      const r = await inject(req, { spaceId: approvedSpace, text: bad[i] });
      assert.equal(r.status, 400, `text case ${i} rejected`);
    }
  });
});

test('inject pushes an adapter-shaped inbound event to the NDJSON consumer', async () => {
  await runSidecar(enabled, async ({ req, consume }) => {
    const consumer = await consume();
    try {
      const text = 'Mini app button pressed: add-one';
      const r = await inject(req, { spaceId: approvedSpace, text });
      assert.equal(r.status, 200);
      const okBody = JSON.parse(r.body);
      assert.equal(okBody.ok, true);
      assert.ok(typeof okBody.messageId === 'string' && okBody.messageId.length > 0);

      const line = await consumer.nextLine();
      const event = JSON.parse(line);
      // Exact shape normalizeEvent() produces and adapter.py _dispatch_inbound reads.
      assert.deepEqual(Object.keys(event).sort(),
        ['content', 'messageId', 'platform', 'sender', 'space', 'timestamp'].sort());
      assert.equal(event.messageId, okBody.messageId);
      assert.equal(event.platform, 'iMessage');
      assert.deepEqual(Object.keys(event.space).sort(), ['id', 'phone', 'type']);
      assert.equal(event.space.id, approvedSpace);
      assert.equal(event.space.type, 'dm');
      assert.equal(event.space.phone, approvedPhone);
      assert.deepEqual(event.sender, { id: approvedPhone });
      assert.deepEqual(event.content, { type: 'text', text });
      assert.ok(!Number.isNaN(Date.parse(event.timestamp)));
      assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // Second inject: unique messageId (adapter dedupes on it).
      const r2 = await inject(req, { spaceId: approvedSpace, text: 'Mini app button pressed: reset' });
      assert.equal(r2.status, 200);
      const event2 = JSON.parse(await consumer.nextLine());
      assert.notEqual(event2.messageId, event.messageId);
      assert.equal(event2.content.text, 'Mini app button pressed: reset');
    } finally { await consumer.close(); }
  });
});

test('inject accepts exactly 500 chars and unicode, rejects 501', async () => {
  await runSidecar(enabled, async ({ req, consume }) => {
    const consumer = await consume();
    try {
      const maxText = 'é'.repeat(500);
      const r = await inject(req, { spaceId: approvedSpace, text: maxText });
      assert.equal(r.status, 200);
      const event = JSON.parse(await consumer.nextLine());
      assert.equal(event.content.text, maxText);
      assert.equal((await inject(req, { spaceId: approvedSpace, text: 'é'.repeat(501) })).status, 400);
    } finally { await consumer.close(); }
  });
});

test('inject without an attached consumer returns 503 and does not queue', async () => {
  await runSidecar(enabled, async ({ req }) => {
    const r = await inject(req, { spaceId: approvedSpace, text: 'hi' });
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.body).ok, false);
  });
});

test('inject rate-limits to 10 per window and returns 429 after', async () => {
  await runSidecar(enabled, async ({ req, consume }) => {
    const consumer = await consume();
    try {
      for (let i = 0; i < 10; i++) {
        const r = await inject(req, { spaceId: approvedSpace, text: `press ${i}` });
        assert.equal(r.status, 200, `request ${i}`);
        await consumer.nextLine();
      }
      const r = await inject(req, { spaceId: approvedSpace, text: 'one too many' });
      assert.equal(r.status, 429);
      assert.equal(JSON.parse(r.body).ok, false);
    } finally { await consumer.close(); }
  });
});

test('inject rate limit window recovers (short-window config)', async () => {
  await runSidecar({ ...enabled, PHOTON_INJECT_RATE_LIMIT: '2', PHOTON_INJECT_RATE_WINDOW_MS: '400' }, async ({ req, consume }) => {
    const consumer = await consume();
    try {
      assert.equal((await inject(req, { spaceId: approvedSpace, text: 'a' })).status, 200);
      await consumer.nextLine();
      assert.equal((await inject(req, { spaceId: approvedSpace, text: 'b' })).status, 200);
      await consumer.nextLine();
      assert.equal((await inject(req, { spaceId: approvedSpace, text: 'c' })).status, 429);
      await new Promise(r => setTimeout(r, 500));
      assert.equal((await inject(req, { spaceId: approvedSpace, text: 'd' })).status, 200);
      await consumer.nextLine();
    } finally { await consumer.close(); }
  });
});

test('rejected injects do not consume rate-limit budget', async () => {
  await runSidecar({ ...enabled, PHOTON_INJECT_RATE_LIMIT: '2' }, async ({ req, consume }) => {
    const consumer = await consume();
    try {
      for (let i = 0; i < 5; i++) {
        assert.equal((await inject(req, { spaceId: 'wrong', text: 'x' })).status, 400);
      }
      assert.equal((await inject(req, { spaceId: approvedSpace, text: 'a' })).status, 200);
      await consumer.nextLine();
      assert.equal((await inject(req, { spaceId: approvedSpace, text: 'b' })).status, 200);
      await consumer.nextLine();
      assert.equal((await inject(req, { spaceId: approvedSpace, text: 'c' })).status, 429);
    } finally { await consumer.close(); }
  });
});

test('inject errors and logs never leak the token or the full phone number', async () => {
  await runSidecar(enabled, async ({ req, logs }) => {
    const r = await inject(req, { spaceId: approvedSpace, text: 'a\nb' });
    assert.equal(r.status, 400);
    assert.equal(r.body.includes('test-token'), false);
    assert.equal(r.body.includes(approvedPhone), false);
    assert.equal(logs().includes('test-token'), false);
    assert.equal(logs().includes(approvedPhone), false);
  });
});

test('existing mini-app send route still works (regression)', async () => {
  await runSidecar({ PHOTON_MINI_APPS: 'true' }, async ({ req }) => {
    const r = await req('/send-mini-app', { body: {
      spaceId: approvedSpace,
      url: approvedUrl,
    } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).messageId, 'mock-app-id');
  });
});
