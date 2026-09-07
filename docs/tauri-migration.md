# Tauri Desktop Migration

Approved scope: replace the Electron desktop shell with Tauri; retain the Python backend, server-rendered frontend and existing Android application.

- [x] Implement Rust backend process ownership, startup timeout, logging and loopback navigation restrictions.
- [x] Preserve Electron's application data directory and add parent-exit cleanup to the bundled backend.
- [x] Replace desktop dependencies and installer configuration; update GitHub builds without changing Android behavior.
- [x] Test Rust lifecycle rules, bundled Python, desktop WebView startup and installer builds.
- [x] Document platform limitations and publish the verified desktop update.

Architecture: Tauri loads a bundled startup page, launches the PyInstaller onedir backend from application resources, waits for its announced loopback URL to respond, and navigates the WebView there. Rust retains the child handle. No remote page receives Tauri IPC capabilities. macOS uses WKWebView; Windows uses WebView2. Backend, assets and app-data remain local.

Verification: Rust unit tests cover URL validation and legacy-data path selection. Python tests cover parent-pipe cleanup. Native smoke tests launch the actual release executable, require the local page load event and ensure its backend exits on close. Existing queue/delete/transition regression tests remain required. Any memory comparison must measure the full process tree, including Python and WebView processes; installer size is not a memory benchmark.

## Results

- Release: `v0.2.0`, successful workflow `34116875823`, source commit `59e2db5`.
- macOS ARM64, macOS Intel and Windows x64: installer builds and native WebView/player initialization passed; the backend exited with the shell.
- Android v0.1.1: native WebView/Chaquopy architecture retained, concurrent startup race fixed and emulator startup passed.
- Local regression checks: 2 Rust tests, 4 embedded Python tests, 17 JavaScript tests passed; Clippy passed with warnings denied.
- WebKit browser checks at 1280px and 390px: audio playback, seeking, previous and next passed without script errors. Two actual Bilibili streams also played and switched successfully.
- Complete-process memory comparison has not been performed. macOS requires version 14 or newer because of bundled NumPy; Windows includes WebView2 offline installation support. Browser-local preferences do not migrate from Electron.
