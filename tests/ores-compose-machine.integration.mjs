import assert from 'node:assert/strict';
import test from 'node:test';

const SHA = '5dbda2127357b4be87821902d36e4ce9560f6876';
const BASE = `https://raw.githubusercontent.com/ORESoftware/ores-interfaces/${SHA}/contracts/ores-compose-machine/v1`;
async function read(path) {
  const response = await fetch(`${BASE}/${path}`);
  assert.equal(response.status, 200, path);
  return response.text();
}
const [schemaText, tsp] = await Promise.all([read('authored.schema.json'), read('main.tsp')]);
const defs = JSON.parse(schemaText).$defs;

test('rebuild intent is an explicit required boolean rather than command text', () => {
  assert.equal(defs.EnsureRequest.properties.rebuild.type, 'boolean');
  assert.ok(defs.EnsureRequest.required.includes('rebuild'));
  assert.equal(defs.EnsureRequest.properties.command, undefined);
});

test('job and generation identifiers are lossless strings for browser mobile and Rust clients', () => {
  assert.equal(defs.EnqueueResponse.properties.job_id.type, 'string');
  assert.equal(defs.ActiveSystem.properties.generation.type, 'string');
  assert.equal(defs.EnqueueResponse.properties.job_id.pattern, '^[1-9][0-9]{0,19}$');
});

test('readiness permits no active system until orchestration reaches publish', () => {
  assert.equal(defs.ReadinessResponse.properties.ready.type, 'boolean');
  assert.equal(defs.ReadinessResponse.required.includes('active'), false);
  assert.match(tsp, /active\?:\s*ActiveSystem/);
});

test('public ingress is loopback or Unix-facing and does not expose device LAN or container addresses', () => {
  const p = new RegExp(defs.MachineIngress.properties.authority.pattern);
  assert.ok(p.test('127.0.0.1:44444'));
  assert.ok(p.test('/tmp/ores-compose/session/control.sock'));
  for (const value of ['192.168.1.20:8080', '10.0.0.2:8080', '172.17.0.2:8080']) assert.equal(p.test(value), false, value);
});

test('wire names stay snake_case and exclude auth credential transport', () => {
  assert.match(tsp, /schema_version/);
  assert.match(tsp, /job_id/);
  assert.doesNotMatch(tsp, /schemaVersion|jobId|accessToken|refreshToken|clientSecret/);
  for (const model of Object.values(defs)) {
    if (!model.properties) continue;
    for (const field of ['access_token','refresh_token','client_secret','authorization']) assert.equal(model.properties[field], undefined, field);
  }
});
