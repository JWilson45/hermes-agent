import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSidecar, approvedSpace } from './test-harness.mjs';

test('legacy injection flag cannot create synthetic inbound messages', async () => {
  await runSidecar({ PHOTON_INJECT_ENABLED: 'true' }, async ({ req, consume }) => {
    const consumer = await consume();
    try {
      const response = await req('/inject', { body: { spaceId: approvedSpace, text: 'act' } });
      assert.equal(response.status, 404);
      await assert.rejects(consumer.nextLine(150), /no inbound line/);
    } finally { await consumer.close(); }
  });
});
