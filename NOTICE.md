# Clear Download Manager notices

The intended license for project-authored Clear Download Manager source code is
the GNU General Public License version 3 or any later version
(GPL-3.0-or-later); see COPYING for the complete version 3 text.

The PR #5 evidence review is **SUFFICIENTLY SUPPORTED / CLOSED FOR FURTHER
INVESTIGATION**; that is not an absolute legal conclusion or formal GPL
clearance. The owner’s formal review remains pending. Distribution permission
for retained visual assets also remains pending in
rights/asset-provenance.json and rights/release-rights.json. This local
preparation is not a public-release clearance.

Third-party components and separately authored material keep their own terms.
This notice does not change those terms or establish provenance for material
whose source has not yet been verified.

## Names, marks and artwork

The project source license does not grant rights to use the Clear Download
Manager, CacaPlay or CacaTools names, logos or other project branding as a
product name or endorsement. These names, marks, logos and artwork are reserved
and outside GPL absent a separate grant. The asset provenance gate checks
permission to distribute these assets; it does not require the Clear brand to
be GPL-licensed.

The grouped inventory in rights/asset-provenance.json currently records:

- 62 Clear brand and installer-art assets, including app-ui/assets/brand/,
  extension variants, color variants, and derivative sizes.
- 51 generated/framework platform icons under src-tauri/icons/, excluding
  src-tauri/icons/brand/.
- 97 product and documentation art assets.
- 210 image assets with provenance/owner confirmation pending across the three
  groups above. This is a cross-cutting count, not an additional group.

Their appearance in the source tree or an application package is not a grant
of permission to reuse them. If the owner cannot confirm a family, remove it
if unused, replace it if replaceable, or require manual owner review if
indispensable.

The 28 unused provider, document-type and store graphics listed in
docs/ASSET-MARKS-AUDIT.md were physically removed from this working tree on
2026-09-24. Their removal does not grant rights to copies retained in backups
or forks.

## Third-party components

The local icon subset is Lucide Icons; its upstream license details are in
app-ui/assets/icons/LICENSE and app-ui/assets/icons/NOTICE.md.

- app-ui/assets/icons/ contains a local Lucide icon subset under upstream ISC
  terms, with the upstream MIT exception for Feather-derived icons. Both
  license texts and source references are in that directory. The ambiguous
  custom music vector was replaced by the official Lucide list-music path,
  pinned to an upstream commit in its local notice.
- src-tauri/resources/bin/ contains separately licensed runtime tools when
  prepared for a Windows build. Their version-specific license texts, notices,
  source references and build information are under
  src-tauri/resources/licenses/. In particular, aria2 and the current
  FFmpeg/FFprobe build have copyleft obligations; consult their notices before
  redistributing binaries.
- Rust and npm dependencies retain their individual licenses. The lockfiles
  identify the resolved versions; generated dependency inventory and SBOM
  files accompany release builds where available.

The project-code license does not grant rights to third-party marks or override
any separate third-party license. The applicable third-party license text and
runtime notices remain under src-tauri/resources/licenses/.

See TRADEMARKS.md for the project’s name and brand boundary, and
docs/ASSET-MARKS-AUDIT.md for the asset inventory and unresolved provenance.

The active preparation UI uses a generic local link icon and host text.
Download links in the README are text-only. The inventory retains the removed
paths and their review evidence in docs/ASSET-MARKS-AUDIT.md.
