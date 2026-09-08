#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod policy;

use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct Runtime {
    child: Mutex<Option<Child>>,
    origin: Mutex<Option<String>>,
    closing: AtomicBool,
}

impl Runtime {
    fn stop(&self) {
        self.closing.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().unwrap().take() {
            // EOF asks Python to close its database and network sessions first.
            drop(child.stdin.take());
            for _ in 0..30 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn report_error(app: &tauri::AppHandle, error: &str) {
    eprintln!("BiliMusic: {error}");
    if let Some(window) = app.get_webview_window("main") {
        let text = serde_json::to_string(&format!("启动失败 / Startup failed\n{error}")).unwrap();
        let _ = window.eval(format!(
            "document.getElementById('status')?.replaceChildren({text})"
        ));
        let _ = window.set_title("BiliMusic - Startup failed");
    }
    if std::env::var_os("BM_DESKTOP_SMOKE").is_some() {
        app.exit(1);
    }
}

fn start_backend(app: &tauri::AppHandle, runtime: &Arc<Runtime>) -> Result<String, String> {
    let base = app.path().config_dir().map_err(|e| e.to_string())?;
    let root = std::env::var_os("BM_DESKTOP_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| policy::data_root(&base));
    fs::create_dir_all(root.join("data")).map_err(|e| e.to_string())?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("backend.log"))
        .map_err(|e| e.to_string())?;
    let backend_dir = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../backend/bilimusic-backend")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("backend")
    };
    let executable = backend_dir.join(if cfg!(windows) {
        "bilimusic-backend.exe"
    } else {
        "bilimusic-backend"
    });
    let mut command = Command::new(executable);
    command
        .args(["--data-dir"])
        .arg(root.join("data"))
        .arg("--watch-parent-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log.try_clone().map_err(|e| e.to_string())?));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child_guard = runtime.child.lock().unwrap();
    if runtime.closing.load(Ordering::SeqCst) {
        return Err("Application is closing".into());
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("{e}. Log: {}", root.join("backend.log").display()))?;
    if let Some(marker) = std::env::var_os("BM_DESKTOP_SMOKE") {
        let _ = fs::write(
            PathBuf::from(marker).with_extension("pid"),
            child.id().to_string(),
        );
    }
    let stdout = child.stdout.take().ok_or("Missing backend stdout")?;
    *child_guard = Some(child);
    drop(child_guard);
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut log = log;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = writeln!(log, "{line}");
            if let Some(url) = policy::backend_url(&line) {
                let _ = tx.send(url);
            }
        }
    });
    let origin = rx
        .recv_timeout(Duration::from_secs(120))
        .map_err(|e| format!("Backend did not announce its URL: {e}"))?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if let Ok(response) = client.get(format!("{origin}/openapi.json")).send() {
            if response.status().is_success() {
                *runtime.origin.lock().unwrap() = Some(origin.clone());
                return Ok(origin);
            }
        }
        let mut guard = runtime.child.lock().unwrap();
        let child = guard.as_mut().ok_or("Backend stopped")?;
        if let Some(code) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "Backend exited: {code}. See {}",
                root.join("backend.log").display()
            ));
        }
        drop(guard);
        thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "Backend startup timed out. See {}",
        root.join("backend.log").display()
    ))
}

fn main() {
    let runtime = Arc::new(Runtime::default());
    let setup_runtime = runtime.clone();
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            let navigation_runtime = setup_runtime.clone();
            let load_runtime = setup_runtime.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("BiliMusic")
                // 原生窗框（macOS 圆角 + 真·红绿灯），内容延伸到标题栏下（仿原生 App）
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .inner_size(1280.0, 850.0)
                .min_inner_size(800.0, 600.0)
                .on_navigation(move |url| {
                    let allowed = navigation_runtime.origin.lock().unwrap().clone();
                    if let Some(origin) = allowed {
                        if url.origin().ascii_serialization() == origin {
                            return true;
                        }
                        if matches!(url.scheme(), "http" | "https") {
                            let _ = open::that(url.as_str());
                        }
                        false
                    } else {
                        matches!(url.scheme(), "tauri" | "http" | "https")
                            && (url.host_str() == Some("tauri.localhost")
                                || url.scheme() == "tauri")
                    }
                })
                .on_new_window(|url, _| {
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = open::that(url.as_str());
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .on_page_load(move |window, payload| {
                    if payload.event() != tauri::webview::PageLoadEvent::Finished {
                        return;
                    }
                    let origin = load_runtime.origin.lock().unwrap().clone();
                    if origin.as_deref()
                        == Some(payload.url().origin().ascii_serialization().as_str())
                        && std::env::var_os("BM_DESKTOP_SMOKE").is_some()
                    {
                        let _ = window.eval("document.title = document.getElementById('app') && document.getElementById('audio') && window.BiliPlayer && window.playStream ? 'BILIMUSIC_SMOKE_READY' : 'BILIMUSIC_SMOKE_FAILED'");
                    }
                })
                .on_document_title_changed(|window, title| {
                    if let Some(marker) = std::env::var_os("BM_DESKTOP_SMOKE") {
                        if title == "BILIMUSIC_SMOKE_READY" {
                            let _ = fs::write(marker, "native-webview-ready");
                            window.app_handle().exit(0);
                        } else if title == "BILIMUSIC_SMOKE_FAILED" {
                            window.app_handle().exit(1);
                        }
                    }
                })
                .build()?;
            let handle = app.handle().clone();
            let state = setup_runtime.clone();
            thread::spawn(move || match start_backend(&handle, &state) {
                Ok(origin) => {
                    if let Some(window) = handle.get_webview_window("main") {
                        if let Err(error) = window.navigate(origin.parse().unwrap()) {
                            report_error(&handle, &error.to_string());
                        }
                    }
                    while !state.closing.load(Ordering::SeqCst) {
                        thread::sleep(Duration::from_secs(1));
                        let exited = state
                            .child
                            .lock()
                            .unwrap()
                            .as_mut()
                            .and_then(|child| child.try_wait().ok().flatten());
                        if let Some(status) = exited {
                            if !state.closing.load(Ordering::SeqCst) {
                                report_error(
                                    &handle,
                                    &format!("Backend exited: {status}. Restart BiliMusic."),
                                );
                            }
                            break;
                        }
                    }
                }
                Err(error) => {
                    state.stop();
                    report_error(&handle, &error);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize BiliMusic");
    application.run(move |_app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            runtime.stop();
        }
    });
}
