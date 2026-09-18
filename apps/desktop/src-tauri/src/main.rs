use std::sync::Arc;
use tauri::Manager;

struct HostState(Arc<llmup_gui::Host>);
enum DirectoryPicker {
    #[cfg(not(test))]
    Native,
    #[cfg(test)]
    Fixture(Option<std::path::PathBuf>),
}
impl DirectoryPicker {
    async fn pick(&self) -> Option<std::path::PathBuf> {
        match self {
            #[cfg(not(test))]
            Self::Native => rfd::AsyncFileDialog::new()
                .set_title("Choose workspace directory")
                .pick_folder()
                .await
                .map(|entry| entry.path().to_path_buf()),
            #[cfg(test)]
            Self::Fixture(path) => path.clone(),
        }
    }
}
fn picker_capability(entry: &str) -> String {
    let root_pattern = format!("{entry}{{}}");
    serde_json::json!({"identifier":"main-picker","windows":["main"],"local":false,"remote":{"urls":[root_pattern]},"permissions":["allow-select-workspace-directory"]}).to_string()
}
fn authorized_url(url: &url::Url, origin: &str) -> bool {
    url.origin().ascii_serialization() == origin
        && url.path() == "/"
        && url.query().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}
#[tauri::command]
async fn select_workspace_directory<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, HostState>,
    picker: tauri::State<'_, DirectoryPicker>,
) -> Result<Option<String>, String> {
    if window.label() != "main"
        || !authorized_url(
            &window.url().map_err(|_| "window unavailable")?,
            &state.0.origin(),
        )
    {
        return Err("directory picker is unavailable to this document".into());
    }
    Ok(picker
        .pick()
        .await
        .map(|path| path.to_string_lossy().into_owned()))
}
#[cfg(not(test))]
fn main() {
    let smoke = std::env::args().any(|argument| argument == "--smoke-test");
    let runtime = tokio::runtime::Runtime::new().expect("native async runtime");
    let config = llmup_runtime::state::Config::load().expect("native configuration");
    let listener = runtime
        .block_on(tokio::net::TcpListener::bind((
            std::net::Ipv4Addr::LOCALHOST,
            0,
        )))
        .expect("loopback listener");
    let host = llmup_gui::Host::new(
        &config.home,
        listener.local_addr().expect("listener address").port(),
    )
    .expect("native GUI host");
    host.desktop
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let serving = runtime.spawn(llmup_gui::serve(listener, host.clone()));
    let origin = host.origin();
    let entry = format!("{origin}/");
    let launch_host = host.clone();
    let app = tauri::Builder::default()
        .manage(HostState(host.clone()))
        .manage(DirectoryPicker::Native)
        .invoke_handler(tauri::generate_handler![select_workspace_directory])
        .setup(move |app| {
            app.add_capability(picker_capability(&entry))?;
            let script = format!("if(window===window.top && location.origin==={} && location.pathname==='/'){{Object.defineProperty(window,'llmupDesktop',{{value:Object.freeze({{selectWorkspaceDirectory:()=>window.__TAURI_INTERNALS__.invoke('select_workspace_directory')}}),writable:false,configurable:false}});}}",serde_json::to_string(&origin)?);
            let allowed = origin.clone();
            let navigation_app=app.handle().clone();
            let smoke_app=app.handle().clone();
            if smoke { tauri::async_runtime::spawn(async move { tokio::time::sleep(std::time::Duration::from_secs(20)).await; smoke_app.exit(1); }); }
            tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::External(entry.parse()?))
                .title("local-llmup").inner_size(1280.0,840.0).min_inner_size(760.0,540.0)
                .initialization_script(script)
                .on_navigation(move |url| {
                    if smoke && url.origin().ascii_serialization()==allowed && url.path().starts_with("/__native_smoke/") {
                        let passed=url.path()=="/__native_smoke/pass";
                        println!("Native WebView frontend/bridge smoke: {}",if passed{"passed"}else{"failed"});
                        navigation_app.exit(if passed{0}else{1});
                        return false;
                    }
                    authorized_url(url,&allowed)
                })
                .on_page_load(move |window,payload| {
                    if smoke && matches!(payload.event(),tauri::webview::PageLoadEvent::Finished) {
                        let _=window.eval("location.href='/__native_smoke/'+(document.title==='local-llmup' && document.querySelector('main') && document.querySelector('textarea') && typeof window.llmupDesktop?.selectWorkspaceDirectory==='function' && typeof window.__TAURI_INTERNALS__?.invoke==='function' ? 'pass':'fail')");
                    }
                })
                .on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny)
                .on_download(|_,_|false)
                .build()?;
            let closing = launch_host.clone();
            app.get_webview_window("main").expect("main window").on_window_event(move |event| { if matches!(event,tauri::WindowEvent::Destroyed) { closing.shutdown.cancel(); } });
            Ok(())
        })
        .build(tauri::generate_context!()).expect("Tauri application");
    app.run(move |_, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            host.shutdown.cancel();
        }
    });
    let _ = runtime.block_on(async {
        tokio::time::timeout(std::time::Duration::from_secs(10), serving).await
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn picker_ipc_is_scoped_to_the_launch_document_and_window() {
        let home = tempfile::tempdir().unwrap();
        let host = llmup_gui::Host::new(home.path(), 43210).unwrap();
        let entry = format!("{}/", host.origin());
        let app = tauri::test::mock_builder()
            .manage(HostState(host))
            .manage(DirectoryPicker::Fixture(Some(home.path().to_path_buf())))
            .invoke_handler(tauri::generate_handler![select_workspace_directory])
            .build(tauri::generate_context!())
            .unwrap();
        app.add_capability(picker_capability(&entry)).unwrap();
        let main = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External(entry.parse().unwrap()),
        )
        .build()
        .unwrap();
        let artifact = tauri::WebviewWindowBuilder::new(
            &app,
            "artifact",
            tauri::WebviewUrl::External(entry.parse().unwrap()),
        )
        .build()
        .unwrap();
        for (label, page_url, allowed) in [
            ("main", entry.as_str(), true),
            (
                "main",
                "http://127.0.0.1:43210/api/images/preview.svg",
                false,
            ),
            ("main", "http://127.0.0.1:43211/", false),
            ("main", "https://example.com/", false),
            ("artifact", entry.as_str(), false),
        ] {
            let webview = if label == "main" { &main } else { &artifact };
            let result = tauri::test::get_ipc_response(
                webview,
                tauri::webview::InvokeRequest {
                    cmd: "select_workspace_directory".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: page_url.parse().unwrap(),
                    body: tauri::ipc::InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            );
            if allowed {
                assert_eq!(
                    result.unwrap().deserialize::<Option<String>>().unwrap(),
                    Some(home.path().to_string_lossy().into_owned())
                );
            } else {
                assert!(
                    result.is_err(),
                    "privileged IPC must reject {label} at {page_url}"
                );
            }
        }
    }
    #[test]
    fn only_launch_root_can_navigate_or_invoke_picker() {
        let origin = "http://127.0.0.1:43210";
        assert!(authorized_url(
            &format!("{origin}/#chat").parse().unwrap(),
            origin
        ));
        for url in [
            "http://127.0.0.1:43210/api/images/image.svg",
            "http://127.0.0.1:43211/",
            "https://example.com/",
            "http://localhost:43210/",
            "http://127.0.0.1:43210/?next=evil",
        ] {
            assert!(!authorized_url(&url.parse().unwrap(), origin));
        }
    }
}
