import assert from 'node:assert/strict';
import test from 'node:test';
import { createComponentDiscoveryScheduler } from '../../app-ui/modules/updates/component-discovery.js';

test('component discovery checks immediately and every 15 minutes without overlap', async () => {
  const scheduled = [];
  let online = true;
  const calls = [];
  let finish;
  const scheduler = createComponentDiscoveryScheduler({
    check: () => { calls.push('check'); return new Promise((resolve) => { finish = resolve; }); },
    isOnline: () => online,
    setIntervalFn: (callback, ms) => { scheduled.push({ callback, ms }); return 1; },
    clearIntervalFn: () => {},
    addOnlineListener: () => {}, removeOnlineListener: () => {},
    intervalMs: 15 * 60 * 1000
  });
  scheduler.start();
  assert.equal(calls.length, 1);
  assert.equal(scheduled[0].ms, 15 * 60 * 1000);
  const overlap = scheduler.checkNow();
  assert.equal(calls.length, 1);
  finish(['verified']);
  assert.deepEqual(await overlap, ['verified']);
  scheduler.stop();
});

test('component discovery waits offline, retries on reconnect, and stops listeners', async () => {
  const listeners = new Map();
  let online = false;
  let checks = 0;
  let cleared = false;
  const scheduler = createComponentDiscoveryScheduler({
    check: async () => { checks++; return ['verified']; },
    isOnline: () => online,
    setIntervalFn: () => 2,
    clearIntervalFn: () => { cleared = true; },
    addOnlineListener: (listener) => listeners.set('online', listener),
    removeOnlineListener: (listener) => { if (listeners.get('online') === listener) listeners.delete('online'); }
  });
  scheduler.start();
  await Promise.resolve();
  assert.equal(checks, 0);
  online = true;
  await listeners.get('online')();
  assert.equal(checks, 1);
  scheduler.stop();
  assert.equal(cleared, true);
  assert.equal(listeners.size, 0);
});

test('component discovery backs off after failures and manual checks can retry', async () => {
  let now = 1000;
  let calls = 0;
  const scheduler = createComponentDiscoveryScheduler({
    check: async () => { calls++; if (calls === 1) throw new Error('offline'); return ['verified']; },
    now: () => now,
    setIntervalFn: () => 3, clearIntervalFn: () => {},
    addOnlineListener: () => {}, removeOnlineListener: () => {}
  });
  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  await scheduler.checkNow();
  assert.equal(calls, 2);
  scheduler.stop();
});
