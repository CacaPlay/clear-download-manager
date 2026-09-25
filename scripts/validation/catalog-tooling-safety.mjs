import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const tauriRoot = join(root, "src-tauri");
const vectorRoot = join(tauriRoot, "tools", "catalog-test-vectors", "v1");
const allowedTestSeed = join(vectorRoot, "test-private-key.base64");
const failures = [];

function walk(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? walk(child) : [child];
  });
}

const phaseFiles = [
  join(tauriRoot, "src", "catalog_tooling.rs"),
  join(tauriRoot, "examples", "catalog-signer.rs"),
  join(tauriRoot, "examples", "catalog-verifier.rs"),
  ...walk(vectorRoot),
  join(root, "scripts", "validation", "catalog-tooling-cross-process.mjs"),
].filter((path) => path !== allowedTestSeed);

const secretPatterns = [
  /-----BEGIN [^-]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /TAURI_SIGNING_PRIVATE_KEY\s*[:=]\s*["'][^"']+["']/,
  /\btools-prod(?:uction)?[-_:A-Za-z0-9]*\b/i,
];
for (const path of phaseFiles) {
  const text = readFileSync(path, "utf8");
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) failures.push(`secret-like material in ${path}`);
  }
}

const fixtureSeed = readFileSync(allowedTestSeed, "utf8").trim();
if (fixtureSeed !== "QhkHKlyeEdOEIHGmD8gzlWcU4kuKVQm9cyzxaApEl14=") {
  failures.push("the explicit TEST ONLY seed allowlist changed");
}

const trustSource = readFileSync(join(tauriRoot, "src", "tools", "trust.rs"), "utf8");
if (!/fn production\(\) -> Self \{[\s\S]*?Self::empty\(\)[\s\S]*?\n\s*\}/.test(trustSource)) {
  failures.push("TrustedKeys::production() is not demonstrably empty");
}

const cargoToml = readFileSync(join(tauriRoot, "Cargo.toml"), "utf8");
for (const name of ["catalog-signer", "catalog-verifier"]) {
  const block = cargoToml.match(new RegExp(`\\[\\[example\\]\\][\\s\\S]*?name = "${name}"[\\s\\S]*?(?=\\n\\[|$)`));
  if (!block || !/required-features = \["maintainer-tooling"\]/.test(block[0])) {
    failures.push(`${name} is not feature-gated maintainer tooling`);
  }
}

const bundleInputs = [
  join(tauriRoot, "tauri.conf.json"),
  ...walk(join(tauriRoot, "resources")),
  ...walk(join(root, "app-ui")),
  ...walk(join(root, "dist")),
  ...walk(join(root, "extension")),
  ...walk(join(root, "extension-dist")),
  ...walk(join(root, "native-host")),
  ...readdirSync(root)
    .filter((name) => /^(?:CacaTools|Clear-Download-Manager)-Chrome-Extension-.*\.zip$/.test(name))
    .map((name) => join(root, name)),
];
for (const path of bundleInputs) {
  if (/catalog-signer|test-private-key\.base64|catalog-test-vectors/.test(path)) {
    failures.push(`maintainer tooling present in bundle/runtime path: ${path}`);
  }
  if (path.endsWith(".zip")) {
    const listing = spawnSync("tar", ["-tf", path], { encoding: "utf8", windowsHide: true });
    if (listing.status === 0 && /catalog-signer|test-private-key\.base64|catalog-test-vectors/.test(listing.stdout)) {
      failures.push(`maintainer tooling present in extension archive: ${path}`);
    }
    continue;
  }
  if (statSync(path).size >= 2_000_000) continue;
  const text = readFileSync(path, "utf8");
  if (/catalog-signer|test-private-key\.base64|catalog-test-vectors/.test(text)) {
    failures.push(`maintainer tooling referenced by bundle/runtime input: ${path}`);
  }
}

const metadata = JSON.parse(execFileSync(
  "cargo",
  ["metadata", "--locked", "--format-version", "1", "--no-deps"],
  { cwd: tauriRoot, encoding: "utf8", windowsHide: true },
));
const releaseDir = join(metadata.target_directory, "release");
for (const filename of ["catalog-signer.exe", "catalog-verifier.exe", "catalog-signer", "catalog-verifier"]) {
  if (existsSync(join(releaseDir, filename))) failures.push(`maintainer executable exists in release output: ${filename}`);
}
const appExecutable = join(releaseDir, "cacatools-desktop.exe");
if (existsSync(appExecutable)) {
  const appBytes = readFileSync(appExecutable);
  for (const marker of ["catalog-signer", "test-private-key", "test-only-catalog-v1"]) {
    if (appBytes.includes(Buffer.from(marker))) {
      failures.push(`maintainer marker present in normal release executable: ${marker}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(JSON.stringify({
  status: "PASS",
  productionTrustRoot: "EMPTY",
  testSeedAllowlist: "ONE EXPLICIT PUBLIC FIXTURE",
  maintainerFeature: "maintainer-tooling",
  releaseExecutablesPresent: false,
  normalReleaseMaintainerMarkers: false,
  bundleInputsReferenceSigner: false,
}, null, 2));
