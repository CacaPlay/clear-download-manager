import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const tauriRoot = join(root, "src-tauri");
const vectorRoot = join(tauriRoot, "tools", "catalog-test-vectors", "v1");
const temporary = mkdtempSync(join(tmpdir(), "cdm-catalog-tooling-"));
const keyId = "test-only-catalog-v1";

function cargo(example, args, expectSuccess = true) {
  const result = spawnSync(
    "cargo",
    ["run", "--locked", "--quiet", "--features", "maintainer-tooling", "--example", example, "--", ...args],
    { cwd: tauriRoot, encoding: "utf8", windowsHide: true },
  );
  if ((result.status === 0) !== expectSuccess) {
    throw new Error(
      `${example} ${args[0]} returned ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function equalFile(actual, expected, label) {
  if (!readFileSync(actual).equals(readFileSync(expected))) {
    throw new Error(`${label} differs from the frozen v1 vector`);
  }
}

try {
  const generated = [];
  for (const run of ["first", "second"]) {
    const paths = {
      envelope: join(temporary, `${run}-envelope.json`),
      payload: join(temporary, `${run}-payload.json`),
      signature: join(temporary, `${run}-signature.base64`),
      publicKey: join(temporary, `${run}-public-key.base64`),
    };
    cargo("catalog-signer", [
      "sign",
      "--input", join(vectorRoot, "envelope.json"),
      "--key-file", join(vectorRoot, "test-private-key.base64"),
      "--output", paths.envelope,
      "--canonical-output", paths.payload,
      "--signature-output", paths.signature,
      "--public-key-output", paths.publicKey,
    ]);
    cargo("catalog-verifier", [
      "verify",
      "--input", paths.envelope,
      "--public-key-file", paths.publicKey,
      "--key-id", keyId,
    ]);
    equalFile(paths.envelope, join(vectorRoot, "envelope.json"), `${run} envelope`);
    equalFile(paths.payload, join(vectorRoot, "payload.canonical.json"), `${run} payload`);
    equalFile(paths.signature, join(vectorRoot, "signature.base64"), `${run} signature`);
    equalFile(paths.publicKey, join(vectorRoot, "test-public-key.base64"), `${run} public key`);
    generated.push(paths);
  }

  for (const field of ["envelope", "payload", "signature", "publicKey"]) {
    equalFile(generated[0][field], generated[1][field], `cross-run ${field}`);
  }
  const payload = readFileSync(generated[0].payload);
  const sha = createHash("sha256").update(payload).digest("hex");
  const expectedSha = readFileSync(join(vectorRoot, "payload.canonical.sha256"), "utf8").trim();
  if (sha !== expectedSha) throw new Error("canonical SHA-256 mismatch");

  const original = JSON.parse(readFileSync(join(vectorRoot, "envelope.json"), "utf8"));
  const rejects = [
    ["byte", { ...original, issuedAt: "2026-09-09T00:00:00Z" }, keyId],
    ["manifest", { ...original, manifest: { ...original.manifest, manifestId: "test-golden-catalog-v1-tampered" } }, keyId],
    ["sequence", { ...original, sequence: 43 }, keyId],
    ["signature", { ...original, signature: `A${original.signature.slice(1)}` }, keyId],
  ];
  for (const [label, value, expectedKey] of rejects) {
    const path = join(temporary, `tampered-${label}.json`);
    writeFileSync(path, JSON.stringify(value));
    cargo("catalog-verifier", [
      "verify", "--input", path,
      "--public-key-file", join(vectorRoot, "test-public-key.base64"),
      "--key-id", expectedKey,
    ], false);
  }
  cargo("catalog-verifier", [
    "verify", "--input", join(vectorRoot, "envelope.json"),
    "--public-key-file", join(vectorRoot, "test-public-key.base64"),
    "--key-id", "unknown-test-key",
  ], false);

  console.log(JSON.stringify({
    status: "PASS",
    runs: 2,
    verifierProcesses: 2,
    canonicalSha256: sha,
    tamperRejections: ["byte", "manifest", "sequence", "signature", "unknown-key"],
  }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
