// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|argument| argument == "--mesa-core") {
        if let Err(error) = ccode_lib::background_core::run() { eprintln!("{error}"); std::process::exit(1); }
        return;
    }
    ccode_lib::run()
}
