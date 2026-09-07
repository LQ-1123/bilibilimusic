# Tauri Desktop Migration

Approved scope: replace the Electron desktop shell with Tauri; retain the Python backend, server-rendered frontend and existing Android application.

- [x] Implement Rust backend process ownership, startup timeout, logging and loopback navigation restrictions.
- [x] Preserve Electron's application data directory and add parent-exit cleanup to the bundled backend.
- [x] Replace desktop dependencies and installer configuration; update GitHub builds without changing Android behavior.
- [ ] Test Rust lifecycle rules, bundled Python, desktop WebView startup and installer builds.
- [ ] Document platform limitations and publish the verified desktop update.

Architecture: Tauri loads a bundled startup page, launches the PyInstaller onedir backend from application resources, waits for its announced loopback URL to respond, and navigates the WebView there. Rust retains the child handle. No remote page receives Tauri IPC capabilities. macOS uses WKWebView; Windows uses WebView2. Backend, assets and app-data remain local.

Verification: Rust unit tests cover URL validation and legacy-data path selection. Python tests cover parent-pipe cleanup. Native smoke tests launch the actual release executable, require the local page load event and ensure its backend exits on close. Existing queue/delete/transition regression tests remain required. Any memory comparison must measure the full process tree, including Python and WebView processes; installer size is not a memory benchmark.
