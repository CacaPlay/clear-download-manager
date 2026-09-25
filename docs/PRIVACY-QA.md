# WebView and local storage QA

Status: **PENDING live, disposable-profile verification**. The automated
`npm run check:privacy-storage` gate checks source/config contracts only. It
does not launch WebView2 and does not inspect any existing profile.

## Automated checks

Run `npm run check:privacy-storage`. It checks the Tauri app-data path override,
SQLite location, absence of a hard-coded WebView profile path, localStorage
and image IndexedDB usage, the saved media-cookie fields and their path
validation, the extension's lack of the browser `cookies` permission, and the
documented persistence/cleanup boundaries.

## Manual checklist for an isolated QA account

Run only on a disposable Windows account/VM with a newly installed QA build.
Set `CACATOOLS_DATA_DIR` to a new empty temporary directory before launch. Let
Tauri/WebView2 use its default per-application profile inside that disposable
Windows account; never redirect it into a normal user profile. Record the
chosen paths and build version, not profile contents.

1. Launch once and confirm SQLite and the WebView2 UDF are created only inside
   the two disposable directories. Confirm no path resolves into a real
   account's `AppData`.
2. Set a non-secret appearance/language preference and a harmless
   `localStorage` sentinel from the QA WebView. Restart the app and check both
   values persist in the same disposable UDF.
3. Use a local test page served from loopback to set a dummy cookie and cache
   entry. Restart and check persistence; clear the disposable WebView profile
   through the OS/runtime test procedure and confirm they disappear. Do not use
   a real account cookie or visit an authenticated service.
4. Confirm there is no direct `sessionStorage` contract expected by Clear;
   test any provider frame storage separately and do not treat it as app-owned.
5. If checking the Brave-cookie feature, use a newly created browser profile
   with synthetic test data only. Observe the temporary extraction copy in the
   temp directory during the operation and after normal completion. Record
   whether forced termination leaves a copy; do not claim secure erasure.
6. Close Clear normally and confirm the app does not claim to erase the
   WebView UDF, SQLite history, yt-dlp cache, selected cookie file, or browser
   profile. These are documented as persistent unless separately deleted by
   an explicit product action.

Do not run this checklist against a daily-use profile. If a live runtime check
is unavailable, leave Privacy QA as PENDING rather than infer PASS from the
static test.
