# Global rights review

**Review date:** 2026-09-25  
**Target code license:** GPL-3.0-or-later  
**Global result:** **PASS for the reviewed project-authored code scope**

This review separates GPL rights for project-authored code from permission to
distribute separately reserved brand and visual assets. The machine-readable
records are rights/global-rights-review.json,
rights/release-rights.json, and rights/asset-provenance.json.

## Findings

| Area | Status | Finding |
| --- | --- | --- |
| External human contributors | CLEAR for reviewed attribution history | No separate external human author was found. Account attribution is evidence of provenance, not independent proof of title to every line. |
| Bots | CLEAR for substantive first-party code | Three Dependabot commits are mechanical updates. PR #4 surviving changes are cleanup/build text and manifest metadata. PR #5 is recorded separately. |
| Third-party icon paths | THIRD_PARTY_COMPATIBLE, with notices | Local Lucide subset has upstream ISC terms and MIT terms for Feather-derived icons. Its ambiguous music vector was replaced with an official list-music path pinned to an upstream commit. |
| Generated code/metadata | CLEAR for identified outputs | SPDX/Cargo inventories are generated metadata, not executable product code. Tauri schema/build output under src-tauri/gen/ is excluded from the source manifest/archive. |
| Public test fixture | CLEAR | The test-only signing vector is marked public TEST ONLY beside its paired public key and is not bundled in an application/runtime. |
| Generated image inputs | Owner attestation APPROVED for distribution | The owner approved distribution for retained groups A, B, C1, and C2. External source files and full generation command/version are not preserved in this checkout; those omissions do not override the approved rights declaration. |
| Clear brand assets | CLEAR for distribution, 62 files | The owner explicitly approved distribution of the color/logo variants, extension identity, native derivatives, and installer artwork. Clear branding remains outside GPL. |
| Generated/framework icons | CLEAR for distribution, 8 files | The owner explicitly approved the retained icon family. Five obsolete purple logos were removed; current Tauri/MSIX configuration does not consume them. |
| Clear product art | CLEAR for distribution, 95 files | The owner explicitly approved retained file-type, news/support, player-control, and documentation art; two old placeholders were removed. |
| Owner attestation cross-cut | CLEAR, 165 images, not additive | The approval covers A+B+C and its SHA-256 is checked against the recorded attestation. This is not an additional 165 assets. |
| Removed assets | CLEAR for current-tree presence | The 73 graphics with REMOVE dispositions and two Android XML support files are absent. This does not clear copies outside the current tree. |
| PR #5 / Devin | PASS for the reviewed diff | The owner directly declared personal self-service use, no owner-known MSA/Order Form/custom modification, continued use after the transition, and authorized GPL distribution of code the owner may license. The exact owner review and its SHA-256 are recorded in `rights/release-rights.json`; account-specific click-through logs were not independently verified. |
| License and mark boundary | CLEAR as document treatment | LICENSE, NOTICE, TRADEMARKS, README, and source archive treat GPL as the code license and Clear marks/artwork as separate assets. The asset gate asks for distribution rights; it does not require the Clear logo to be GPL. |

## Rights decision

The direct owner declaration, the public Cognition Platform Terms dated
2026-06-30 (including §§1.2, 1.5, 3.1 and 12.4), the recorded public PR/diff
chain, and the owner's confirmation of continued self-service use after the
30-day transition satisfy the project's rights-record gate for the reviewed
PR #5 diff. This is not an independent legal opinion or account click-through
record. No other first-party code-rights item is pending in the current
register. The source-release gate passed for the inspected source-only archive
on 2026-09-25. Binary release and GPL runtime-source obligations remain
separate gates.

The PR #5 evidence investigation remains closed. Do not search Devin or Gmail
again unless contradictory evidence appears. This is a rights-readiness record,
not an absolute legal opinion.

## Gate separation

- check:rights addresses formal GPL source clearance for code contributions.
- check:asset-rights verifies the prior 28 file dispositions, the new obsolete
  families/paths, and their absence.
- check:asset-provenance verifies retained image inventory and distribution
  permission status, independently of whether the logo is GPL-licensed.
- Code-rights and asset-distribution records are approved for the reviewed
  source scope. The source-only archive passed its inspection; binary/GPL
  runtime-source readiness is separate.
