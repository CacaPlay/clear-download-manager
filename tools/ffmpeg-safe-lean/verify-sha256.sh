#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'Usage: bash verify-sha256.sh <expected-lowercase-sha256> <file>\n' >&2
  exit 2
fi

expected=$1
file=$2

if [[ ! $expected =~ ^[a-f0-9]{64}$ ]]; then
  printf 'Invalid expected SHA-256: expected 64 lowercase hexadecimal characters.\n' >&2
  exit 2
fi

if [[ ! -f $file || -L $file ]]; then
  printf 'Source input is not a regular file: %s\n' "$file" >&2
  exit 2
fi

digest_output=$(sha256sum -- "$file")
actual=${digest_output%% *}
if [[ $actual != "$expected" ]]; then
  printf 'SHA-256 mismatch for %s\nExpected: %s\nActual:   %s\n' "${file##*/}" "$expected" "$actual" >&2
  exit 1
fi

printf 'SHA-256 verified: %s\n' "${file##*/}"
