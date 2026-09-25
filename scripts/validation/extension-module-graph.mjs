import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.CDM_EXTENSION_ROOT || 'extension');
const toKey = (file) => path.relative(root, file).replaceAll('\\', '/');
const errors = [];
const modules = new Map();

function exactPath(file) {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  let current = root;
  for (const part of relative.split(path.sep)) {
    const entries = fs.readdirSync(current);
    if (!entries.includes(part)) return false;
    current = path.join(current, part);
  }
  return true;
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  const withExtension = path.extname(candidate) ? candidate : `${candidate}.js`;
  if (!fs.existsSync(withExtension) || !fs.statSync(withExtension).isFile()) {
    errors.push(`${toKey(fromFile)} importa un archivo inexistente: ${specifier}`);
    return null;
  }
  if (!exactPath(withExtension)) {
    errors.push(`${toKey(fromFile)} usa una ruta con mayúsculas/minúsculas incorrectas: ${specifier}`);
    return null;
  }
  return withExtension;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function parseImports(source) {
  const clean = stripComments(source);
  const imports = [];
  const fromPattern = /\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/g;
  for (const match of clean.matchAll(fromPattern)) {
    const clause = match[1].trim();
    const names = [];
    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) {
      for (const item of named[1].split(',')) {
        const token = item.trim();
        if (!token) continue;
        names.push((token.split(/\s+as\s+/)[0] || '').trim());
      }
    }
    const withoutNamed = clause.replace(named?.[0] || '', '').replace(/,\s*$/, '').trim();
    if (withoutNamed && !withoutNamed.startsWith('*')) names.push('default');
    imports.push({ specifier: match[2], names });
  }
  const sideEffectPattern = /\bimport\s*['"]([^'"]+)['"]\s*;?/g;
  for (const match of clean.matchAll(sideEffectPattern)) imports.push({ specifier: match[1], names: [] });
  return imports;
}

function parseExports(source) {
  const clean = stripComments(source);
  const exports = new Set();
  for (const match of clean.matchAll(/\bexport\s+(?:(?:async|function|class)\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) exports.add(match[1]);
  for (const match of clean.matchAll(/\bexport\s*\{([\s\S]*?)\}\s*(?:from\s*['"][^'"]+['"])?\s*;?/g)) {
    for (const item of match[1].split(',')) {
      const token = item.trim();
      if (!token) continue;
      exports.add((token.split(/\s+as\s+/).pop() || '').trim());
    }
  }
  return exports;
}

function load(file) {
  const key = toKey(file);
  if (modules.has(key)) return modules.get(key);
  const source = fs.readFileSync(file, 'utf8');
  const record = { file, key, source, imports: [], exports: parseExports(source) };
  modules.set(key, record);
  record.imports = parseImports(source).map(({ specifier, names }) => ({
    specifier,
    names,
    target: resolveImport(file, specifier)
  }));
  return record;
}

const sdkDir = path.join(root, 'sdk');
const sdkEntries = fs.readdirSync(sdkDir).filter((file) => file.endsWith('.js')).map((file) => path.join(sdkDir, file));
const entryFiles = [path.join(root, 'sidepanel.js'), path.join(root, 'service-worker.js'), ...sdkEntries];
for (const file of entryFiles) load(file);

for (const record of modules.values()) {
  for (const imported of record.imports) {
    if (!imported.target) continue;
    const target = load(imported.target);
    for (const name of imported.names) {
      if (name !== 'default' && !target.exports.has(name)) {
        errors.push(`${record.key} importa { ${name} } desde ${target.key}, pero ese símbolo no está exportado`);
      }
      if (name === 'default' && !target.exports.has('default')) {
        errors.push(`${record.key} importa el export default desde ${target.key}, pero ese símbolo no está exportado`);
      }
    }
  }
}

const visiting = new Set();
const visited = new Set();
function visit(record, stack = []) {
  if (visiting.has(record.key)) {
    const start = stack.indexOf(record.key);
    errors.push(`ciclo de módulos detectado: ${[...stack.slice(start), record.key].join(' -> ')}`);
    return;
  }
  if (visited.has(record.key)) return;
  visiting.add(record.key);
  for (const imported of record.imports) if (imported.target) visit(load(imported.target), [...stack, record.key]);
  visiting.delete(record.key);
  visited.add(record.key);
}
for (const record of modules.values()) visit(record);

if (errors.length) {
  console.error(errors.map((error) => `FALLO: ${error}`).join('\n'));
  process.exit(1);
}
console.log(`OK: grafo ES-module coherente (${modules.size} módulos; imports con exports verificados).`);
