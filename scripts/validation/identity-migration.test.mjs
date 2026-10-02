import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const read = (path) => fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
const expectMatch = (text, pattern, message) => assert.ok(pattern.test(text), message);

test("Rust package and executable use the canonical CDM identity", () => {
  const cargo = read("src-tauri/Cargo.toml");
  expectMatch(cargo, /^name = "clear-download-manager"$/m, "desktop Cargo package is not renamed");
  expectMatch(cargo, /^name = "clear_download_manager_lib"$/m, "Rust library crate is not renamed");
  expectMatch(cargo, /authors = \["CacaPlay"\]/, "Rust publisher is not canonical");
});

test("production Tauri identifier and Store AUMID remain upgrade compatible", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(config.identifier, "lat.cacaplay.cacatools.downloadmanager");
  const storeConfig = JSON.parse(read("src-tauri/resources/extension/extension-config.json"));
  assert.equal(storeConfig.storeAppUserModelId, "CacaPlay.CacaToolsDownloadManager_b9fexpwkvxe1m!CacaTools");
});

test("database startup selects the canonical file through a tested legacy migration", () => {
  const lib = read("src-tauri/src/lib.rs");
  const db = read("src-tauri/src/db/mod.rs");
  expectMatch(lib, /migrate_legacy_database/, "startup does not invoke the migration");
  expectMatch(db, /fn migrate_legacy_database/, "database migration helper is missing");
  expectMatch(db, /clear-download-manager\.sqlite3/, "canonical database filename is missing");
  expectMatch(db, /fn migrates_legacy_database_without_losing_rows/, "row-preservation test is missing");
  expectMatch(db, /fn migration_refuses_conflicting_database_files/, "conflict safety test is missing");
});

test("CDM data-directory environment override takes precedence over its legacy alias", () => {
  const lib = read("src-tauri/src/lib.rs");
  expectMatch(lib, /CDM_DATA_DIR/, "canonical data-directory override is missing");
  expectMatch(lib, /CACATOOLS_DATA_DIR/, "legacy data-directory alias is not accepted");
  expectMatch(lib, /fn cdm_environment_path_override/, "path-override helper is missing");
  expectMatch(lib, /fn cdm_environment_override_prefers_primary/, "override priority test is missing");
});

test("the extension registers a canonical native host and a separate v1 compatibility alias", () => {
  const client = read("extension/sdk/cdm-native-client.js");
  const compatibility = read("extension/sdk/compatibility.js");
  const bridge = read("src-tauri/src/extension_bridge.rs");
  const hostCargo = read("extension/native-host/Cargo.toml");
  const hostMain = read("extension/native-host/src/main.rs");
  expectMatch(client, /from '\.\/compatibility\.js'/, "canonical extension client is missing");
  expectMatch(compatibility, /lat\.cacaplay\.cleardownloadmanager/, "new host is not canonical");
  expectMatch(bridge, /LEGACY_HOST_NAME/, "bridge does not register the old host alias");
  expectMatch(bridge, /clear-download-manager-native-host/, "bridge does not resolve the new host executable");
  expectMatch(bridge, /cacatools-native-host/, "bridge does not resolve the legacy host executable");
  expectMatch(hostCargo, /legacy-host-name/, "native-host crate has no legacy-name build feature");
  expectMatch(hostMain, /lat\.cacaplay\.cleardownloadmanager/, "host handshake does not identify the new host");
  expectMatch(hostMain, /CDM_APP_EXE/, "host app-path override is not canonical");
  expectMatch(hostMain, /CACATOOLS_APP_EXE/, "host app-path override does not accept the legacy alias");
});

test("Windows repair and uninstall keep both host registrations coherent", () => {
  const registration = read("scripts/register-extension-host-windows.ps1");
  const installer = read("src-tauri/windows/hooks.nsh");
  expectMatch(registration, /lat\.cacaplay\.cleardownloadmanager/, "repair omits the canonical host");
  expectMatch(registration, /lat\.cacaplay\.cacatools\.downloadmanager/, "repair omits the v1 host alias");
  expectMatch(registration, /clear-download-manager-native-host\.exe/, "repair omits the canonical host binary");
  expectMatch(registration, /cacatools-native-host\.exe/, "repair omits the compatibility host binary");
  expectMatch(installer, /clear-download-manager\.exe.*--background/, "startup registry does not point to the renamed executable");
  for (const browser of ["Google\\Chrome", "Microsoft\\Edge", "BraveSoftware\\Brave-Browser", "Chromium", "Mozilla"]) {
    assert.ok(installer.includes(`Software\\${browser}\\NativeMessagingHosts\\lat.cacaplay.cleardownloadmanager`), `uninstall omits the canonical ${browser} host`);
    assert.ok(installer.includes(`Software\\${browser}\\NativeMessagingHosts\\lat.cacaplay.cacatools.downloadmanager`), `uninstall omits the legacy ${browser} host`);
  }
});

test("local storage migration copies existing values before removing legacy keys", () => {
  const migration = read("app-ui/modules/runtime/storage-migration.js");
  const main = read("app-ui/main.js");
  const subwindow = read("app-ui/subwindow.js");
  const player = read("app-ui/player/player.js");
  expectMatch(migration, /function migrateLegacyStorageNamespace/, "local storage migration helper is missing");
  expectMatch(migration, /setItem/, "migration does not copy values");
  expectMatch(migration, /getItem/, "migration does not verify values");
  expectMatch(migration, /removeItem/, "migration does not remove safely copied aliases");
  expectMatch(main, /migrateLegacyStorageNamespace\(\)/, "main window does not run migration");
  expectMatch(subwindow, /migrateLegacyStorageNamespace\(\)/, "subwindow does not run migration");
  expectMatch(player, /migrateLegacyStorageNamespace\(\)/, "player does not run migration");
});
