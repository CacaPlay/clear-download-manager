const OPTIONAL_RUNTIME_FILES = new Set([
  'aria2c.exe',
  'deno.exe',
  'ffmpeg.exe',
  'ffprobe.exe',
  'yt-dlp.exe',
]);

const OPTIONAL_DISTRIBUTION_FILES = new Set([
  'component-catalog-v1.json',
  'component-catalog-v1.json.sig',
]);

export function inspectCorePackageFiles(files) {
  const failures = [];
  for (const entry of files) {
    const relative = typeof entry === 'string' ? entry : entry?.path;
    if (typeof relative !== 'string' || relative.length === 0) {
      failures.push('Core package inventory contains an invalid file path.');
      continue;
    }
    const normalized = relative.replaceAll('\\', '/');
    const basename = normalized.split('/').at(-1).toLowerCase();
    if (OPTIONAL_RUNTIME_FILES.has(basename)) {
      failures.push(`Core package must not include optional runtime ${basename}.`);
    }
    if (basename.endsWith('.cdmcomponent')) {
      failures.push(`Core package must not embed optional component package ${basename}.`);
    }
    if (OPTIONAL_DISTRIBUTION_FILES.has(basename)) {
      failures.push(`Core package must not embed mutable distribution metadata ${basename}.`);
    }
  }
  return { failures };
}
