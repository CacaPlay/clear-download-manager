import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'rights/asset-provenance.json'), 'utf8'));
const imageExtensions = new Set(['.png', '.svg', '.ico', '.icns', '.bmp', '.webp', '.jpg', '.jpeg', '.gif', '.avif', '.tiff']);
const allowedStatuses = new Set(['CLEAR', 'THIRD_PARTY_COMPATIBLE', 'NEEDS_ATTRIBUTION', 'NEEDS_REPLACEMENT', 'PENDING_RIGHTS', 'REPLACED']);
const failures = [];
const groups = [];
const groupAssets = new Map();
const ownerStatement = registry.ownerStatement || {};
const ownerStatementGroups = new Set(registry.ownerStatement?.groups || []);
const expectedOwnerStatementGroups = [
  'clear-brand-assets',
  'generated-tauri-platform-icons',
  'clear-product-file-type-icons',
  'clear-product-other-art',
];
const ownerEvidencePath = path.resolve(root, ownerStatement.evidencePath || '');
const ownerEvidenceIsInRoot = ownerEvidencePath.startsWith(`${root}${path.sep}`);
const actualOwnerEvidenceHash = ownerEvidenceIsInRoot && fs.existsSync(ownerEvidencePath)
  ? crypto.createHash('sha256').update(fs.readFileSync(ownerEvidencePath)).digest('hex')
  : null;
if (ownerStatement.status !== 'APPROVED'
  || !ownerStatement.approvedAt
  || !ownerStatement.approvedBy
  || !ownerEvidenceIsInRoot
  || actualOwnerEvidenceHash !== ownerStatement.evidenceSha256
  || expectedOwnerStatementGroups.some((id) => !ownerStatementGroups.has(id))) {
  failures.push('Approved owner statement must cover all four retained groups and match its recorded in-repository SHA-256.');
}

function collect(relative, results = []) {
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute)) return results;
  const stat = fs.statSync(absolute);
  if (stat.isFile()) {
    if (imageExtensions.has(path.extname(absolute).toLowerCase())) results.push(relative.replaceAll(path.sep, '/'));
    return results;
  }
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) collect(child, results);
    else if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) {
      results.push(child.replaceAll(path.sep, '/'));
    }
  }
  return results;
}

if (registry.schemaVersion !== 1 || !Array.isArray(registry.groups)) failures.push('asset-provenance.json: unsupported or malformed schema.');
for (const group of registry.groups || []) {
  if (!allowedStatuses.has(group.status)) failures.push(`${group.id || 'unnamed group'}: invalid rights classification.`);
  const assets = new Set(group.files || []);
  for (const prefix of group.pathPrefixes || []) {
    if (prefix.endsWith('/')) {
      for (const file of collect(prefix.slice(0, -1))) assets.add(file);
    } else if (fs.existsSync(path.join(root, prefix)) && imageExtensions.has(path.extname(prefix).toLowerCase())) {
      assets.add(prefix);
    } else if (!fs.existsSync(path.join(root, prefix))) {
      failures.push(`${group.id}: registered asset path is missing: ${prefix}`);
    }
  }
  for (const prefix of group.excludePathPrefixes || []) {
    if (prefix.endsWith('/')) {
      for (const file of collect(prefix.slice(0, -1))) assets.delete(file);
    } else {
      assets.delete(prefix);
    }
  }
  for (const file of group.files || []) {
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.existsSync(absolute)) failures.push(`${group.id}: registered evidence file is missing: ${file}`);
  }
  if (Number.isInteger(group.assetCount) && assets.size !== group.assetCount) {
    failures.push(`${group.id}: expected ${group.assetCount} assets, found ${assets.size}; review the inventory before changing the count.`);
  }
  if (['clear-brand-assets', 'generated-tauri-platform-icons', 'clear-product-art'].includes(group.id)) {
    if (group.clearanceScope !== 'DISTRIBUTION_RIGHTS_ONLY') {
      failures.push(`${group.id}: clearanceScope must be DISTRIBUTION_RIGHTS_ONLY.`);
    }
    if (group.ownerAttestationStatus !== 'CONFIRMED' && group.status !== 'PENDING_RIGHTS') {
      failures.push(`${group.id}: a first-party asset group cannot be cleared without a confirmed owner attestation.`);
    }
    if (group.ownerAttestationStatus === 'PENDING' && group.status !== 'PENDING_RIGHTS') {
      failures.push(`${group.id}: pending owner attestation must keep the group PENDING_RIGHTS.`);
    }
    if (group.attestationSubgroups) {
      let subgroupTotal = 0;
      for (const subgroup of group.attestationSubgroups) {
        const subgroupAssets = new Set(subgroup.files || []);
        for (const prefix of subgroup.pathPrefixes || []) {
          for (const file of collect(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix)) subgroupAssets.add(file);
        }
        if (subgroupAssets.size !== subgroup.assetCount) {
          failures.push(`${group.id}/${subgroup.id}: expected ${subgroup.assetCount} assets, found ${subgroupAssets.size}.`);
        }
        if (!['PENDING', 'CONFIRMED'].includes(subgroup.status)) {
          failures.push(`${group.id}/${subgroup.id}: invalid owner-attestation status.`);
        }
        if (subgroup.status === 'PENDING' && group.status !== 'PENDING_RIGHTS') {
          failures.push(`${group.id}: a pending subgroup must keep the parent family PENDING_RIGHTS.`);
        }
        subgroupTotal += subgroupAssets.size;
      }
      if (subgroupTotal !== group.assetCount) {
        failures.push(`${group.id}: subgroup counts total ${subgroupTotal}, expected ${group.assetCount}.`);
      }
    }
  }
  if (group.status === 'REPLACED' && (!group.replacement || !group.upstreamCommit)) {
    failures.push(`${group.id}: a replacement record needs the replacement identity and upstream commit.`);
  }
  for (const script of group.relatedGenerationScripts || []) {
    if (!fs.existsSync(path.join(root, script))) failures.push(`${group.id}: related generation script is missing: ${script}`);
  }
  groupAssets.set(group.id, assets);
  groups.push({ id: group.id, status: group.status, count: assets.size, missing: group.missing || [] });
}

const unknown = registry.unknownProvenance;
if (!unknown || unknown.status !== 'CLEAR' || unknown.notAdditive !== true || unknown.crossCutting !== true) {
  failures.push('unknownProvenance must record the cleared, non-additive cross-cutting union covered by the approved statement.');
} else {
  const unknownAssets = new Set();
  for (const id of unknown.groups || []) {
    for (const file of groupAssets.get(id) || []) unknownAssets.add(file);
  }
  if (unknownAssets.size !== unknown.assetCount) {
    failures.push(`unknownProvenance: expected ${unknown.assetCount} cross-cutting assets, found ${unknownAssets.size}.`);
  }
  if (unknownAssets.size !== 165) {
    failures.push(`unknownProvenance: current family union must be 165 retained image assets; found ${unknownAssets.size}.`);
  }
}

console.log('Asset provenance clearance scope: distribution rights only; Clear names and marks are not required to be GPL-licensed.');
console.log(`Owner statement: APPROVED by ${ownerStatement.approvedBy} on ${ownerStatement.approvedAt}; SHA-256 verified (${actualOwnerEvidenceHash}).`);
for (const group of groups) console.log(`${group.status}: ${group.id} (${group.count} inventoried assets)`);
if (unknown) console.log(`${unknown.status}: approved owner-statement cross-cut (${unknown.assetCount} assets, not additive to the family totals).`);
for (const group of groups.filter((entry) => entry.status === 'PENDING_RIGHTS')) {
  console.log(`PENDING_RIGHTS detail: ${group.id} still needs a separate distribution-rights decision.`);
}
for (const group of registry.groups || []) {
  for (const subgroup of group.attestationSubgroups || []) {
    console.log(`${subgroup.status}: ${subgroup.id} (${subgroup.assetCount} assets).`);
  }
}

const pending = groups.filter((group) => group.status === 'PENDING_RIGHTS');
if (failures.length) {
  console.error('ASSET PROVENANCE INVENTORY INVALID.');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
if (registry.status !== 'READY' || pending.length) {
  console.error(`ASSET PROVENANCE PENDING: ${pending.length} rights group(s) remain; retained assets are not cleared by the separate removal-disposition gate.`);
  process.exit(1);
}
console.log('Asset provenance inventory is complete and all retained groups are cleared.');
