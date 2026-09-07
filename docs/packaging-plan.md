# Standalone Application Packaging

Goal: publish self-contained macOS DMG, Windows EXE and Android APK installers.

## Design

- Desktop: Electron displays the existing interface. A PyInstaller backend binds an ephemeral loopback port, stores data in the OS application-data directory and exits with the desktop application.
- Android: a Java activity displays a local WebView. Chaquopy embeds Python and runs the same FastAPI app on a loopback socket. No external server configuration is needed.
- CI: GitHub Actions builds macOS ARM64 and x64, Windows x64 and Android ARM64/x64. Build jobs upload artifacts; a final job publishes a tagged release only after all builds and package smoke tests pass.
- Desktop installers are unsigned until signing identities are supplied. Android uses a persistent signing key stored in repository secrets.
- Runtime dependencies exclude test tools and optional native Uvicorn accelerators. Audio analysis without a system decoder remains unavailable; online playback does not require it.

## Execution

- [ ] Implement and test embedded backend lifecycle and data-directory behavior.
- [ ] Implement Electron shell, PyInstaller build and installer configuration.
- [ ] Implement Android WebView, embedded Python and signing configuration.
- [ ] Add CI builds, startup smoke tests and Release publishing.
- [ ] Run builds, resolve packaging failures, document installation and publish verified artifacts.
