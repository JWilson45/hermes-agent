// Shared test harness: spawns the candidate sidecar with a mock spectrum-ts
// transport and a TEMP policy config file (0600). All chat ids and URLs here
// are SYNTHETIC test fixtures built by concatenation — never real recipient
// ids. Assertion messages use indexes, never space-id values.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Synthetic "approved" fixtures (the policy allowlist the tests install).
export const approvedSpace = 'any;-;+' + '1555' + '1234567';
export const approvedPhone = approvedSpace.slice('any;-;'.length);
export const approvedUrl = 'https://mini-app.example.ts.net:18443/';
export const defaultConfig = {
  allowedSpaces: [approvedSpace],
  allowedUrlPrefixes: [approvedUrl],
};
// Additional fake spaces/prefixes for policy-rotation tests.
export const fakeSpace = 'any;-;+' + '1555' + '7654321';
export const fakeSpace2 = ['any;-;+1555', '9876543'].join('');
export const fakePrefix = 'https://demo.example.ts.net:18443/';

export async function freePort() {
  const socket = net.createServer();
  await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise(r => socket.close(r));
  return port;
}

// runSidecar(env, fn, {config}) — config defaults to defaultConfig.
// Pass config:null to start with NO policy file (fail-closed tests).
// fn({req, consume, logs, setConfig, removeConfig, configPath, capturePath, port}).
export async function runSidecar(env, fn, { config = defaultConfig } = {}) {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photon-mini-app-test-'));
  const configPath = path.join(tmp, 'photon-mini-apps.json');
  const capturePath = path.join(tmp, 'sdk-capture.ndjson');
  let writes = 0;
  const writeConfig = (cfg) => {
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    fs.chmodSync(configPath, 0o600);
    // Guarantee the mtime cache key changes even for same-size rewrites.
    const st = fs.statSync(configPath);
    const t = new Date(st.mtimeMs + 1000 * (++writes));
    fs.utimesSync(configPath, t, t);
  };
  if (config !== null) writeConfig(config);
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-loader', './test-loader.mjs', 'index.mjs'], {
    cwd: here,
    env: {
      PATH: process.env.PATH,
      PHOTON_PROJECT_ID: 'fake', PHOTON_PROJECT_SECRET: 'fake',
      PHOTON_SIDECAR_TOKEN: 'test-token', PHOTON_SIDECAR_PORT: String(port),
      PHOTON_STREAM_SILENCE_PROBE_MS: '-1',
      PHOTON_MINI_APPS_CONFIG: configPath,
      MOCK_CAPTURE_FILE: capturePath,
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let logs = ''; child.stderr.on('data', b => { logs += b; });
  const req = async (urlPath, { method = 'POST', body, token = 'test-token' } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: { 'X-Hermes-Sidecar-Token': token, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.text() };
  };
  // Attach a GET /inbound consumer; returns {nextLine, close}.
  const consume = async () => {
    const controller = new AbortController();
    const r = await fetch(`http://127.0.0.1:${port}/inbound`, {
      headers: { 'X-Hermes-Sidecar-Token': 'test-token' },
      signal: controller.signal,
    });
    if (r.status !== 200) throw new Error('inbound attach failed: ' + r.status);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const queue = [];
    const waiters = [];
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue; // heartbeat
            const w = waiters.shift();
            if (w) w(line); else queue.push(line);
          }
        }
      } catch { /* aborted */ }
    })();
    return {
      nextLine(timeoutMs = 5000) {
        if (queue.length) return Promise.resolve(queue.shift());
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('no inbound line within timeout')), timeoutMs);
          waiters.push(line => { clearTimeout(t); resolve(line); });
        });
      },
      close() { controller.abort(); return pump.catch(() => {}); },
    };
  };
  try {
    for (let i = 0; i < 100 && !logs.includes('listening on'); i++) {
      if (child.exitCode !== null) throw Error('child exited early: ' + logs.slice(-400));
      await new Promise(r => setTimeout(r, 30));
    }
    if (!logs.includes('listening on')) throw Error('not listening');
    await fn({
      req, consume, logs: () => logs, port, configPath, capturePath,
      setConfig: writeConfig,
      removeConfig: () => { try { fs.unlinkSync(configPath); } catch {} },
      readCapture: () => fs.existsSync(capturePath)
        ? fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
        : [],
    });
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      // server.close() can wait on a lingering NDJSON socket until the next
      // heartbeat (25s); bound the graceful wait, then force-kill.
      await Promise.race([
        new Promise(r => child.once('exit', r)),
        new Promise(r => setTimeout(r, 2000)),
      ]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await new Promise(r => child.once('exit', r));
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}