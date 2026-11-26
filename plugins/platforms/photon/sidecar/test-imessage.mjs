// Mock spectrum-ts iMessage provider for tests. Accepts any https app URL
// (policy is enforced by the sidecar, not the mock) but still asserts the
// builder is a LIVE app card. Optionally appends each sent URL to
// MOCK_CAPTURE_FILE so tests can verify exactly what reached the SDK.
import fs from "node:fs";
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const scraperRequire = createRequire(require.resolve('open-graph-scraper'));
const undici = scraperRequire('undici');
export function imessage() {
  const space = {send:async builder => {
    if (process.env.MOCK_MODE === 'send-fail') throw Error('private-error-marker');
    const content = await builder.build();
    if (content.type !== 'app' || content.live !== true) throw Error('wrong payload');
    const url = await content.url();
    if (typeof url !== 'string' || !url.startsWith('https://')) throw Error('wrong payload');
    const originalFetch = globalThis.fetch;
    const originalUndiciFetch = undici.fetch;
    let outbound = 0;
    const forbidNetwork = async () => { outbound++; throw Error('network forbidden'); };
    globalThis.fetch = forbidNetwork;
    undici.fetch = forbidNetwork;
    let layout;
    try { layout = await content.layout(); } finally {
      globalThis.fetch = originalFetch;
      undici.fetch = originalUndiciFetch;
    }
    if (outbound !== 0 || layout.caption !== 'Mini app') throw Error('unsafe app layout');
    if (process.env.MOCK_CAPTURE_FILE) fs.appendFileSync(process.env.MOCK_CAPTURE_FILE, JSON.stringify({url}) + '\n');
    if (process.env.MOCK_MODE === 'send-no-result') return undefined;
    return {id:'mock-app-id'};
  }};
  return {space:{
    create:async () => { if (process.env.MOCK_MODE === 'resolve-fail') throw Error('private-error-marker'); return space; },
    get:async () => { if (process.env.MOCK_MODE === 'resolve-fail') throw Error('private-error-marker'); return space; },
  }};
}
imessage.config = () => ({});
export function effect() {}
