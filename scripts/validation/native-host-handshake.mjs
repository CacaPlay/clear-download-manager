import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyHandshake } from '../../extension/sdk/compatibility.js';

const executable = path.resolve(process.argv[2] || '');
assert.ok(fs.existsSync(executable), `No existe el host nativo: ${executable}`);

const messages = [{ action: 'ping' }, { action: 'capabilities' }];
const frames = messages.map((message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
});
const temporaryLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'cdm-native-host-smoke-'));
try {
  const result = spawnSync(executable, [], {
    input: Buffer.concat(frames),
    env: { ...process.env, LOCALAPPDATA: temporaryLocalAppData },
    encoding: 'buffer',
    timeout: 8000
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `El host terminó con ${result.status}: ${result.stderr?.toString('utf8') || ''}`);

  const output = result.stdout;
  const responses = [];
  let offset = 0;
  while (offset + 4 <= output.length) {
    const length = output.readUInt32LE(offset);
    offset += 4;
    assert.ok(length > 0 && offset + length <= output.length, 'El host devolvió un frame Native Messaging truncado.');
    responses.push(JSON.parse(output.subarray(offset, offset + length).toString('utf8')));
    offset += length;
  }
  assert.equal(offset, output.length, 'El host devolvió bytes no enmarcados.');
  assert.equal(responses.length, 2, 'El host debe responder ping y capabilities.');
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].host, 'lat.cacaplay.cacatools.downloadmanager');
  assert.equal(responses[0].protocolVersion, 1);
  assert.equal(responses[1].ok, true);
  assert.equal(responses[1].protocolVersion, 1);
  assert.ok(responses[1].actions.includes('get_status'));
  assert.ok(responses[1].actions.includes('browser_download_capture'));
  const bridge = verifyHandshake(responses[0], responses[1]);
  assert.equal(bridge.protocolVersion, 1);
  assert.equal(bridge.hostReportedVersion, '0.45.4');
} finally {
  fs.rmSync(temporaryLocalAppData, { recursive: true, force: true });
}

console.log('OK: el ejecutable del host nativo responde al protocolo 1 y expone las acciones requeridas por la extensión.');
