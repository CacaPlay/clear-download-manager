import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeJobs } from '../../app-ui/download-manager/core/model.js';

function snapshot() {
  return {
    jobs: [
      { id: 1, title: 'Primera', status: 'completed', progress: 100, updated_at: '2026-01-01 00:00:01' },
      { id: 3, title: 'Tercera', status: 'failed', progress: 0, updated_at: '2026-01-01 00:00:09' }
    ],
    playlist_batches: [{
      batch_id: 1,
      added_order: 2,
      title: 'Segunda playlist',
      status: 'queued',
      total_items: 1,
      updated_at: '2026-01-01 00:00:02'
    }]
  };
}

const first = normalizeJobs(snapshot());
assert.deepEqual(first.map((job) => job.id), [3, -1000000001, 1]);

const afterStatusUpdate = snapshot();
afterStatusUpdate.jobs[0] = {
  ...afterStatusUpdate.jobs[0],
  status: 'failed',
  updated_at: '2026-01-01 00:01:00'
};
afterStatusUpdate.playlist_batches[0].status = 'running';
afterStatusUpdate.playlist_batches[0].updated_at = '2026-01-01 00:01:01';
assert.deepEqual(normalizeJobs(afterStatusUpdate).map((job) => job.id), [3, -1000000001, 1]);

const withPending = normalizeJobs(snapshot(), [{
  id: 'pending-4',
  title: 'Nueva',
  status: 'queued',
  progress: 0,
  __addedAt: 4
}]);
assert.equal(withPending.at(-1)?.title, 'Nueva');

for (const stylesheet of ['motion-tier1.css', 'motion-tier2.css']) {
  const css = fs.readFileSync(new URL(`../../app-ui/styles/${stylesheet}`, import.meta.url), 'utf8');
  assert.match(
    css,
    /\.floating-position-root > \.motion-inner \{[\s\S]*?opacity: 1;/,
    `${stylesheet}: floating menu must remain visible before motion mode initialization`
  );
}

console.log('download-order-stability: PASS');
