//! Multiple app windows.
//!
//! Design: every window is an independent workspace. It has its own webview
//! (so its own tab set and frontend store) and its own backend sessions: a
//! session records the label of the window that opened it, and when a window is
//! destroyed its sessions are removed from `AppState` and their connections
//! closed. Sessions are never shared between windows.
//!
//! All windows are built by `build_window`, so each one gets the same
//! navigation guard; the CSP comes from `tauri.conf.json` and applies to every
//! webview. Secondary window labels are `window-<n>`, which the `default`
//! capability matches (`"windows": ["main", "window-*"]`).

use std::sync::atomic::{AtomicU32, Ordering};

use dbs_core::DbError;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::state::AppState;

pub const MAIN: &str = "main";
pub const NEW_WINDOW_MENU_ID: &str = "new-window";
const TITLE: &str = "Lord of the Rows";

static NEXT: AtomicU32 = AtomicU32::new(1);

/// The webview may only ever show bundled content.
pub fn is_app_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            matches!(url.host_str(), Some("tauri.localhost"))
                || (cfg!(debug_assertions) && matches!(url.host_str(), Some("localhost")) && url.port() == Some(5173))
        }
        _ => false,
    }
}

pub fn build_window<R: Runtime, M: Manager<R>>(manager: &M, label: &str) -> tauri::Result<WebviewWindow<R>> {
    WebviewWindowBuilder::new(manager, label, WebviewUrl::App("index.html".into()))
        .title(TITLE)
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .on_navigation(is_app_url)
        // Tauri's native file-drop handler swallows every drag event on macOS/Windows, which
        // breaks HTML5 drag-and-drop inside the app (moving connections into groups, reordering
        // tabs). The app never accepts dropped files (imports use the file dialog), so turn it off.
        .disable_drag_drop_handler()
        .build()
}

/// A fresh `window-<n>` label not used by any open window.
fn next_label<R: Runtime>(app: &AppHandle<R>) -> String {
    loop {
        let label = format!("window-{}", NEXT.fetch_add(1, Ordering::Relaxed));
        if app.get_webview_window(&label).is_none() {
            return label;
        }
    }
}

pub fn open_new_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<String> {
    let label = next_label(app);
    let w = build_window(app, &label)?;
    let _ = w.set_focus();
    Ok(label)
}

/// What a new window should start with ("Move to new window" / "Open in new window": which saved
/// connection to open, its database, and its query tabs). Kept here until that window asks for it
/// once with `take_window_handoff`; never persisted.
static HANDOFFS: LazyLock<Mutex<HashMap<String, serde_json::Value>>> = LazyLock::new(Default::default);
/// Query text is capped per tab by the frontend; this bounds the whole hand-off.
const MAX_HANDOFF_BYTES: usize = 4 * 1024 * 1024;

fn check_handoff(v: &serde_json::Value) -> Result<(), DbError> {
    if !v.is_object() {
        return Err(DbError::invalid("window hand-off must be an object"));
    }
    if serde_json::to_vec(v).map(|b| b.len()).unwrap_or(usize::MAX) > MAX_HANDOFF_BYTES {
        return Err(DbError::invalid("window hand-off is too large"));
    }
    Ok(())
}

/// Opens another app window. Without `handoff` it starts with an empty workspace and no sessions;
/// with one, the new window opens that connection and its tabs on start. Async so the window is
/// not created on the main thread while it is blocked (deadlocks on Windows).
#[tauri::command]
pub async fn open_window(app: AppHandle, handoff: Option<serde_json::Value>) -> Result<String, DbError> {
    if let Some(h) = &handoff {
        check_handoff(h)?;
    }
    let label = next_label(&app);
    if let Some(h) = handoff {
        HANDOFFS.lock().unwrap().insert(label.clone(), h);
    }
    match build_window(&app, &label) {
        Ok(w) => {
            let _ = w.set_focus();
            Ok(label)
        }
        Err(e) => {
            HANDOFFS.lock().unwrap().remove(&label);
            Err(DbError::internal(e.to_string()))
        }
    }
}

/// The hand-off for the calling window, once (later calls return nothing).
#[tauri::command]
pub fn take_window_handoff(window: tauri::Window) -> Option<serde_json::Value> {
    HANDOFFS.lock().unwrap().remove(window.label())
}

/// Disconnects every session owned by a window that has been destroyed.
pub fn on_window_destroyed<R: Runtime>(window: &tauri::Window<R>) {
    HANDOFFS.lock().unwrap().remove(window.label());
    let Some(st) = window.try_state::<AppState>() else { return };
    let sessions = st.take_window_sessions(window.label());
    if sessions.is_empty() {
        return;
    }
    tracing::info!(window = window.label(), count = sessions.len(), "closing sessions of destroyed window");
    tauri::async_runtime::spawn(async move {
        for s in sessions {
            let _ = s.conn.close().await;
        }
    });
}

/// macOS: the default app menu with "New Window" added to the File menu.
/// No accelerator is attached: the shortcut (Cmd+Shift+N, rebindable) is
/// handled by the webview so it never fires twice.
#[cfg(target_os = "macos")]
pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    let item = MenuItem::with_id(app, NEW_WINDOW_MENU_ID, "New Window", true, None::<&str>)?;
    let file = menu.items()?.into_iter().find_map(|k| match k {
        MenuItemKind::Submenu(s) if s.text().ok().as_deref() == Some("File") => Some(s),
        _ => None,
    });
    match file {
        Some(f) => f.prepend(&item)?,
        None => menu.append(&tauri::menu::Submenu::with_items(app, "File", true, &[&item])?)?,
    }
    Ok(menu)
}

#[cfg(test)]
mod tests {

    #[test]
    fn handoff_must_be_a_bounded_object() {
        assert!(check_handoff(&serde_json::json!({ "connectionId": "c1", "tabs": [] })).is_ok());
        assert!(check_handoff(&serde_json::json!(["not", "an", "object"])).is_err());
        let big = "x".repeat(MAX_HANDOFF_BYTES);
        assert!(check_handoff(&serde_json::json!({ "tabs": [{ "sql": big }] })).is_err());
    }
    use super::*;

    #[test]
    fn navigation_guard_allows_only_bundled_content() {
        let ok = |u: &str| is_app_url(&tauri::Url::parse(u).unwrap());
        assert!(ok("tauri://localhost/index.html"));
        assert!(ok("http://tauri.localhost/index.html"));
        assert!(!ok("https://example.com/"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("http://tauri.localhost.evil.com/"));
    }
}
