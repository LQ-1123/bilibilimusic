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
            // #25：宽限 0.5s 即可（实测后端 stdin EOF 后 0.33s 退出）；原来 30×100ms 会让退出卡满 3s
            for _ in 0..5 {
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
        let _ = window.set_title("启动失败");
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
        // #26：绑 0.0.0.0 固定端口（端口被占自动回退 loopback），手机端可在局域网发现本机
        .arg("--lan")
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
            // #23：Overlay 标题栏会把窗口标题画在顶部正中 → 置空去掉那行文字
            let window_builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("")
                    .inner_size(1280.0, 850.0)
                    // #26：最小尺寸必须让宽度 > 900px（style.css 的响应式断点），否则会滑进手机布局
                    // 410 = 370（用户要求）+ 40（Overlay 下 .sidebar 的 padding-top 让位区）
                    .min_inner_size(1260.0, 410.0);
            // 原生窗框（macOS 圆角 + 真·红绿灯），内容延伸到标题栏下（仿原生 App）。
            // title_bar_style 是 macOS 专属 API：Windows/Linux 保持系统装饰，避免跨平台编译失败。
            #[cfg(target_os = "macos")]
            let window_builder = window_builder.title_bar_style(tauri::TitleBarStyle::Overlay);
            window_builder
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
