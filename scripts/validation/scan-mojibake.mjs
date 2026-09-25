import fs from 'node:fs';
import path from 'node:path';

const roots = ['app-ui', 'src-tauri/src', 'index.html', 'dist'];
const patterns = [
  String.fromCodePoint(0xc3),
  String.fromCodePoint(0xc2),
  String.fromCodePoint(0xe2, 0x20ac),
  String.fromCodePoint(0xf0, 0x178),
  String.fromCodePoint(0xfffd)
];
const textExtensions = new Set(['.js', '.css', '.html', '.json', '.rs', '.toml', '.md', '.txt', '.svg']);
const files = [];
function collect(value) {
  if (!fs.existsSync(value)) return;
  const stat = fs.statSync(value);
  if (stat.isFile()) {
    if (value === 'index.html' || textExtensions.has(path.extname(value).toLowerCase())) files.push(value);
    return;
  }
  for (const entry of fs.readdirSync(value)) collect(path.join(value, entry));
}
for (const root of roots) collect(root);
const failures = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const pattern of patterns) {
    if (text.includes(pattern)) failures.push(`${file}: contiene una secuencia de codificación corrupta`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`OK: codificación UTF-8 validada en ${files.length} archivos.`);
