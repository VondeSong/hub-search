fn main() {
    // The GUI starts the full set of domain workers on the Windows main thread.
    // Their async state machines exceed MSVC's default 1 MiB stack during setup.
    // Reserve virtual stack space without increasing the initial committed size
    // or moving the native event loop away from the main thread.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bin=craft-search=/STACK:8388608");
    }
    // Windows embeds the ICO during the build-script resource compilation.
    // Re-run that step when branding assets change, even if Rust code does not.
    for icon in [
        "icon.ico",
        "icon.png",
        "32x32.png",
        "128x128.png",
        "128x128@2x.png",
    ] {
        println!("cargo:rerun-if-changed=icons/{icon}");
    }
    tauri_build::build()
}
