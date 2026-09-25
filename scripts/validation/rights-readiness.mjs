import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = path.join(root, 'rights', 'release-rights.json');
const manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const failures = [];
const sha256 = value => /^[a-f0-9]{64}$/i.test(String(value || ''));

if (manifest.schemaVersion !== 1) failures.push('release-rights.json: unsupported schemaVersion.');
if (manifest.targetLicense !== 'GPL-3.0-or-later') failures.push('targetLicense must remain GPL-3.0-or-later.');
const formalAction = manifest.formalActionRequired;
if (!formalAction || formalAction.id !== 'pr5-devin-output' || formalAction.doNotAutoApprove !== true) {
  failures.push('release-rights.json: PR #5 must retain an explicit, non-automatic owner-approval action.');
} else {
  const draftPath = typeof formalAction.draftPath === 'string' ? path.resolve(root, formalAction.draftPath) : '';
  const rightsRoot = `${path.resolve(root, 'rights')}${path.sep}`;
  if (!draftPath || !draftPath.startsWith(rightsRoot) || !fs.existsSync(draftPath)) {
    failures.push('PR #5 formal owner-review draft must exist under rights/.');
  }
}
for (const item of manifest.items || []) {
  if (item.status !== 'APPROVED') {
    if (item.investigationStatus === 'SUFFICIENTLY_SUPPORTED_CLOSED_FOR_FURTHER_INVESTIGATION') {
      failures.push(`${item.id || 'unnamed item'}: the evidence investigation is closed; formal GPL clearance remains ${item.formalClearanceStatus || item.status} and is not declared.`);
    } else {
      failures.push(`${item.id || 'unnamed item'}: title/relicensing review is ${item.status || 'missing'}; evidence from the rights holder is required.`);
    }
    continue;
  }
  const evidence = typeof item.evidencePath === 'string' ? path.resolve(root, item.evidencePath) : '';
  const evidenceRoot = `${path.resolve(root, 'rights')}${path.sep}`;
  if (!evidence || !evidence.startsWith(evidenceRoot) || !fs.existsSync(evidence)) {
    failures.push(`${item.id}: approved rights evidence must exist under rights/.`);
  } else if (!sha256(item.evidenceSha256) || crypto.createHash('sha256').update(fs.readFileSync(evidence)).digest('hex') !== item.evidenceSha256.toLowerCase()) {
    failures.push(`${item.id}: approved rights evidence SHA-256 is missing or mismatched.`);
  }
  if (!item.reviewedBy || !item.reviewedAt || Number.isNaN(Date.parse(item.reviewedAt))) {
    failures.push(`${item.id}: named reviewer and review date are required.`);
  }
}
if (manifest.status !== 'READY') failures.push(`overall rights status is ${manifest.status || 'missing'}, not READY.`);

if (formalAction?.ownerApprovalStatus === 'PENDING') {
  console.log(`PR #5 formal owner action remains PENDING: ${formalAction.draftPath}; no approval was recorded.`);
}

if (failures.length) {
  console.error('FIRST-PARTY RIGHTS READINESS BLOCKED: do not declare GPL-3.0-or-later clearance or publish.');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error('This gate requires a rights-holder/legal record; code reconstruction and account attribution are not proof of title.');
  process.exit(1);
}

console.log('First-party rights evidence is present and hash-matched; this gate does not give legal advice.');
