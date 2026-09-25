# Open-source rights review

**Review date:** 2026-09-25  
**Status:** PR #5 is **APPROVED for the reviewed diff**; global project-code GPL rights are **PASS** under the recorded owner declaration and evidence limits.  
**Scope:** public Git history and repository metadata; this report does not infer
rights from a commit, merge, or account name alone.

## Repository license history

- At `main` HEAD `0aafcfe`, the tracked `LICENSE.md` states that Clear Download
  Manager is proprietary and reserves rights to CacaPlay. GitHub's repository
  metadata reports `Other` / `NOASSERTION`, not a recognized open-source license.
- The current working tree contains uncommitted GPL-3.0-or-later preparation
  (`LICENSE.md`, `COPYING`, and related metadata). It is not evidence that every
  historical contribution is owned or cleared for relicensing.
- The project owner's stated target is GPL-3.0-or-later for Clear-authored code.
  The PR #5 rights record is now approved for its reviewed diff; this does not
  clear unrelated binary/runtime-source obligations or authorize publication.

## Contributors and surviving changes

| GitHub identity | Recorded activity | Current-tree result | Rights evidence |
| --- | --- | --- | --- |
| `CacaPlay` (commit-name aliases `Julio Angel` and `Ozelot`) | GitHub contributor API reports 91 contributions; local history has 91 commits attributed to this account across those aliases. | Main application, extension, build, and documentation history. | Attribution consistently maps to the repository owner account. The checked history has no contributor license agreement or DCO sign-off. This is account-level evidence, not independent proof of legal title to every historical line. |
| `dependabot[bot]` | Three commits on 2026-09-14: two GitHub Actions version updates and one `esbuild` dependency update. | Action references in four workflow files and dependency version metadata remain. | These are narrow dependency-maintenance edits, not substantive application features. Each commit has a `Signed-off-by` trailer for the bot account; that is not a human contributor attestation. |
| `devin-ai-integration[bot]`, PR #4 | PR opened and merged on 2026-09-20. Its commit is attributed by GitHub to `CacaPlay`; the commit signature is not verified and has no `Signed-off-by` trailer. | The PR removed `.cargo/config.toml` and a set of old validation scripts. Those deleted files are absent from current `main`. Its surviving changes are a short local build instruction in `CONTRIBUTING.md` and a manifest edit. | No substantive application-source addition from this PR remains in `main`. The surviving build instruction is not treated as an independent application-code contribution. |
| `devin-ai-integration[bot]`, PR #5 | Opened and merged on 2026-09-20. The public body says `Requested by: @CacaPlay` and links Devin session `0505a2fb68854e28a6468f1370f0da06`. GitHub renders CacaPlay and Devin bot as commit participants; the raw Git author and committer names are `Ozelot`, with a Devin `Co-Authored-By` trailer. | The four source files' original delta is +22/-7; the commit also changed four lines each way in `MANIFEST.sha256`, for a complete commit delta of +26/-11 across five files. Its behavior is now represented in current source by the explicit catalog contract below. | **APPROVED for GPL-3.0-or-later in the project rights register.** This uses the dated direct owner declaration, public Platform Terms and exact diff; the declaration is not independent proof and no account click-through log is claimed. |

The last column's former open-investigation label is superseded by the closure
below. The closure means the available owner-provided and public evidence is
sufficient to continue without further Devin/Gmail searches unless a concrete
contradiction appears. It is not a legal opinion or an absolute statement of
copyright transfer.

## Owner declaration and evidence boundary

On 2026-09-25, the repository owner directly declared that the account behind
session `0505a2fb68854e28a6468f1370f0da06` was a personal self-service account
created and controlled by the owner; was not Enterprise; had no owner-known
negotiated MSA, Order Form, custom agreement, or separate modification; and
continued to be used under self-service terms on the session date. The owner
also declared that they requested/authorized the Devin work, reviewed the exact
commit diff, and authorize GPL distribution of code they have rights to
license. The completed record is
[`rights/pr5-owner-review-draft.md`](../rights/pr5-owner-review-draft.md),
with its SHA-256 in `rights/release-rights.json`. These are direct owner
declarations, not independent external proof.

The public Git record establishes the following distinct facts:

- **Solicitant:** both PR #4 and PR #5 bodies say `Requested by: @CacaPlay`.
- **Task/session:** both bodies link the same Devin session URL. This links the
  public PR records to that session identifier, but does not identify the
  Devin account that operated it or partition the session's outputs between
  the two PRs.
- **GitHub attribution:** the PR #5 commit page renders CacaPlay and
  `devin-ai-integration[bot]` as participants. The raw commit object records
  `Ozelot` as author and committer and has a `Co-Authored-By: Devin AI` trailer.
  GitHub attribution, `Requested by`, and `Co-Authored-By` are provenance clues;
  none is a copyright assignment or relicensing instrument.
- **Merge/review:** GitHub records CacaPlay approving and merging PR #5.

The exact public patch has five files: the four source files listed below and
`MANIFEST.sha256`. The four source files total +22/-7; the manifest contributes
+4/-4, making the complete commit +26/-11. The evidence register records the
full patch hash and the terms-page hashes. No credentials, invoices, or other
private account documents have been placed in the repository. The owner
declaration remains a statement made in the 2026-09-24 conversation, not a
signed external artifact or independently verified fact.

## Cognition terms reviewed for the 2026-09-20 session date

The public pages disclose two possible contractual routes. The direct owner
declaration identifies the self-service route and denies an owner-known
Enterprise contract or overriding document; those account-specific facts are
not independently verified:

1. The current [Platform Terms of Service](https://cognition.com/legal/platform-terms-of-service)
   are dated June 30, 2026. Their notice says prior terms control for 30 days
   after posting and that continued access thereafter is governed by the
   updated terms. September 20 is beyond that transition period. Sections 1.2
   and 1.5 define Customer Data to include Outputs and define Output; §3.1 says
   Cognition assigns its rights in Output to Customer and Customer owns
   Customer Data, including Outputs, to the fullest extent permitted by law.
   The owner declares that the session's account was personal self-service and
   that service use continued after the transition period. The preamble and
   §12.4 therefore provide the stated applicability basis; no account-specific
   acceptance timestamp or log is claimed.
2. The linked [Master Services Agreement](https://cognition.com/legal/enterprise-terms-of-service)
   is dated June 8, 2026. Its introduction says it governs Cognition and the
   person/entity using the Services together with any applicable Order Form;
   §§1.4, 1.10, and 3.1 cover Customer Data, Output, and Customer ownership of
   Customer Data including Outputs. Section 12.12 gives this conflict order:
   Order Form, exhibits, AUP, then Terms. Therefore an applicable signed Order
   Form could control over the general MSA where they conflict.

The [April 3, 2025 Platform Terms](https://old.cognition.ai/terms-of-service)
are a historical self-serve version: their introduction excludes customers
with custom agreements and incorporates signed Order Forms into the Agreement.
Its §3.1 says Customer owns Customer Data, including Outputs, but does not
contain the current Platform Terms' express assignment sentence. That archived
page has no general Order Form precedence clause. It is not proof that it
governed the September 2026 session.

Thus, the 30-day transition after June 30 had elapsed by September 20. The
account/tier and absence of a separate agreement are supported by the direct
owner declaration; there is no independent click-through log, historical
billing record, or account-specific contract packet in the repository. The
Platform Terms and the owner's declaration together satisfy the project's
rights-record standard for the exact reviewed PR #5 diff, without claiming an
absolute legal conclusion. The retrieved HTML copies and hashes are recorded in
[`rights/pr5-evidence-register.json`](../rights/pr5-evidence-register.json)
with the current Platform Terms copy referenced in an external private archive.

## PR #5 rights-gate decision

| Gate | Status | Basis |
| --- | --- | --- |
| `PR5_PUBLIC_CHAIN` | **PASS** | PR body identifies `@CacaPlay`, links session `0505a2fb68854e28a6468f1370f0da06`, and public GitHub identifies the head commit and merge. This is an attribution chain only. |
| `PR5_EVIDENCE_ASSESSMENT` | **SUFFICIENTLY SUPPORTED / CLOSED FOR FURTHER INVESTIGATION** | Public PR/session chain, owner-provided same-mailbox welcome-email context, the CacaPlay organization plan screenshot, public Platform Terms, owner authorization, and exact patch were reviewed together. No further search is planned absent contradiction. |
| `ACCOUNT_TO_TERMS_CHAIN` | **PASS — DIRECT OWNER DECLARATION + PUBLIC TERMS** | The owner declared personal self-service use and continued access after the transition; no separate account click-through log is claimed. |
| `OUTPUT_RIGHTS` | **SUPPORTED BY §3.1 + OWNER AUTHORIZATION** | §§1.2, 1.5, and 3.1 cover Customer Data and Output ownership/assignment; the owner authorized GPL distribution of code they have rights to license. |
| `GPL_RELICENSING_READINESS` | **PASS for the reviewed PR #5 diff** | The completed, dated owner review is hash-recorded. The account facts and no-other-agreement statement remain owner declarations rather than independently verified external proof. Clear mark rights remain separate. |

No more Devin or Gmail evidence is needed for this task unless new evidence
contradicts the current record. Sensitive messages, screenshot details,
credentials, and account identifiers were not copied or hashed into the
repository. `check:rights` now recognizes the owner-reviewed PR #5 evidence;
source archive readiness is checked independently. This review does not clear
binary/GPL runtime-source obligations or authorize publication.

PR #4's substantive changes were repository cleanup and old validation-script
deletions; no substantive application-source addition from that PR remains in
`main`. This observation does not change the attribution record or the separate
PR #5 decision.

## PR #5 behavior contract and technical reconstruction

The runtime manifest and validation/download call sites establish this
host-independent contract:

1. The current catalog describes Windows binaries. Its artifact filenames are
   `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`, `deno.exe` and `aria2c.exe`, even
   when the catalog validator or release build runs on another OS.
2. A runtime executable name used to launch a program follows the host OS:
   `.exe` on Windows and no suffix on Unix-like hosts.
3. Manifest validation, yt-dlp endpoint validation and staged-file identity
   checks use the catalog filename. A download artifact's name must not be
   derived from the build host's launch convention.
4. `std::path::Path` is used only by Windows-only registry/Store bridge code;
   non-Windows builds retain `PathBuf` without an unused unconditional import.

The current working tree re-expresses this requirement as an explicit Windows
catalog mapping for all five `ToolId` values. A new unit test
(`artifact_names_are_windows_names_while_runtime_names_follow_host`) covers the
artifact/runtime-name split; the existing signed-manifest, wrong-artifact,
staged-file and Windows-gated import contracts remain in place. This is a
technical reconstruction from the catalog contract, not a legal conclusion.

| File | Original PR #5 delta | Behavior needed now | Current-tree disposition |
| --- | ---: | --- | --- |
| `src-tauri/src/app/runtime.rs` | +16 / -3 | Separate catalog filename from host launch filename and keep path fixtures host-aware. | Re-expressed as an exhaustive fixed-name mapping plus host-aware launch tests. |
| `src-tauri/src/extension_bridge.rs` | +3 / -1 | Keep Windows path APIs scoped to Windows code. | Windows-only signatures use fully qualified `std::path::Path`; no behavior change. |
| `src-tauri/src/tools/download.rs` | +2 / -2 | Validate downloaded and staged names against the Windows catalog. | Uses the reconstructed fixed-name mapping. |
| `src-tauri/src/tools/manifest.rs` | +1 / -1 | Reject artifact names that do not match the catalog. | Uses the reconstructed fixed-name mapping. |
| `MANIFEST.sha256` | +4 / -4 | Refresh hashes for the four changed source files. | Generated inventory only; not runtime behavior. |
| **Full commit** | **+26 / -11** | Four code files: +22/-7; manifest: +4/-4. |  |

The merged PR remains in reachable Git history. No history was rewritten. The
technical reconstruction alone does not establish rights; the direct owner
review and terms basis are separately recorded and hash-checked. The rights
manifest is now **READY** for project-authored code under the reviewed scope.
Do not store secrets or personal account credentials in the evidence folder.

Across reachable Git history, the only `Signed-off-by` trailers are the three
Dependabot bot trailers above. No human DCO sign-off or contributor license
agreement was found.

The GitHub PRs are [#4](https://github.com/CacaPlay/clear-download-manager/pull/4)
and [#5](https://github.com/CacaPlay/clear-download-manager/pull/5). Their merges
do not, by themselves, establish copyright transfer or relicensing consent.

## Evidence register and limit

The public-only register at
[`rights/pr5-evidence-register.json`](../rights/pr5-evidence-register.json)
records public URLs and hashes, the public GitHub facts, and the direct owner
declaration's path/hash. No private billing, account, or credential documents
are stored in the repository. The owner statement supplies the account-to-
self-service applicability basis for this project review, but is not
independently verified external evidence.

## Lightweight future contribution process

Adopt a DCO-style sign-off for future contributions after the rights review is
closed:

1. Keep each contributor's copyright; do not require assignment.
2. Require `git commit -s` so each commit carries a `Signed-off-by` statement
   under Developer Certificate of Origin 1.1.
3. Require contributors to confirm they authored the change or have authority to
   submit it under GPL-3.0-or-later, and to identify copied, generated, or
   third-party material with its source and license.
4. Apply the same recordkeeping to bot-generated PRs: identify the responsible
   human account and retain the applicable tool terms or an explicit rights
   confirmation.

This is a proposal only; no DCO enforcement or new contributor contract was
enabled during this phase.
