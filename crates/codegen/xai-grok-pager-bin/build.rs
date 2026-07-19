use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-env-changed=GROK_VERSION");

    // MSVC executables default to a 1 MiB main-thread stack. Grok's clap and
    // layered configuration bootstrap can exceed that on Windows before ACP
    // starts, which presents in the desktop app as an auth-time freeze/crash.
    // Match the room normally available to main threads on Unix hosts.
    #[cfg(windows)]
    println!("cargo:rustc-link-arg-bin=xai-grok-pager=/STACK:8388608");

    let commit = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let version = std::env::var("GROK_VERSION")
        .or_else(|_| std::env::var("CARGO_PKG_VERSION"))
        .unwrap_or_else(|_| "0.0.0".to_string());

    println!(
        "cargo:rustc-env=VERSION_WITH_COMMIT={} ({})",
        version, commit
    );
}
