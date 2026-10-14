import assert from 'node:assert/strict';
import test from 'node:test';
import { runDocumentTransition, runSettingsCategoryTransition } from '../../app-ui/modules/motion/coordinator.js';

function installTransitionHarness(t) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const app = { removeAttribute() {} };
  globalThis.document = {
    documentElement: { dataset: { motionMode: 'on', motion: 'on' }, removeAttribute() {} },
    querySelector: selector => selector === '#app' ? app : null,
    startViewTransition(update) {
      const updateCallbackDone = Promise.resolve().then(update);
      return {
        updateCallbackDone,
        ready: Promise.resolve(),
        finished: updateCallbackDone.then(() => undefined),
        skipTransition() {}
      };
    }
  };
  globalThis.window = {};
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
}

test('document navigation reports render exceptions instead of silently leaving the old page active', async (t) => {
  installTransitionHarness(t);
  const expected = new Error('component page render failed');
  const reported = [];
  let attempts = 0;

  await runDocumentTransition(() => {
    attempts += 1;
    throw expected;
  }, { onError: error => reported.push(error) });

  assert.equal(attempts, 1, 'a failed render must not be executed twice');
  assert.deepEqual(reported, [expected]);
});

test('settings category navigation reports render exceptions to the app recovery surface', async (t) => {
  installTransitionHarness(t);
  const expected = new Error('settings page render failed');
  const reported = [];
  let attempts = 0;

  await runSettingsCategoryTransition(() => {
    attempts += 1;
    throw expected;
  }, 'down', { onError: error => reported.push(error) });

  assert.equal(attempts, 1, 'a failed render must not be executed twice');
  assert.deepEqual(reported, [expected]);
});
