#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let native_messaging = std::env::args().skip(1).any(|argument| {
        argument == "--native-messaging-host"
            || argument.starts_with("chrome-extension://")
            || argument.starts_with("extension://")
            || argument.starts_with("moz-extension://")
    });
    if native_messaging {
        cacatools_desktop_lib::run_native_messaging_host();
        return;
    }
    cacatools_desktop_lib::run();
}
