use std::env;

fn main() {
    if env::var_os("CARGO_FEATURE_QA_COMPONENT_MANAGER").is_some() {
        if env::var_os("CARGO_FEATURE_GITHUB_UPDATER").is_some() {
            panic!("QA component build rejected: the GitHub updater feature is production-only");
        }
        for (name, expected) in [
            (
                "CDM_QA_EXPECTED_IDENTIFIER",
                "lat.cacaplay.cacatools.downloadmanager.qa",
            ),
            (
                "CDM_QA_EXPECTED_COMPONENT_ENDPOINT",
                "http://127.0.0.1:49301/component-catalog-v1.json",
            ),
            (
                "CDM_QA_EXPECTED_COMPONENT_KEY_ID",
                "component-catalog-qa-20260927",
            ),
        ] {
            println!("cargo:rerun-if-env-changed={name}");
            let actual = env::var(name).unwrap_or_default();
            if actual != expected {
                panic!("QA component build rejected: {name} must equal its fixed QA value");
            }
        }
    }
    tauri_build::build()
}
