// The file watcher and the recovery journal (ARCHITECTURE sections 3 and 9).
use serde::Serialize;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct WatchState(Mutex<Option<RecommendedWatcher>>);

const IGNORED: [&str; 4] = [".git", "node_modules", ".apidesigner", "target"];

fn rel(root: &Path, p: &Path) -> Option<String> {
  let r = p.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
  if r.is_empty() || IGNORED.iter().any(|d| r == *d || r.starts_with(&format!("{}/", d))) {
    return None;
  }
  Some(r)
}

// Watches the project folder and tells the webview which files changed on disk.
#[tauri::command]
pub fn watch_project(app: AppHandle, root: String) -> Result<(), String> {
  let root_path = PathBuf::from(&root);
  let app2 = app.clone();
  let base = root_path.clone();
  let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
    if let Ok(ev) = res {
      let paths: Vec<String> = ev.paths.iter().filter_map(|p| rel(&base, p)).collect();
      if !paths.is_empty() {
        let _ = app2.emit("fs-change", json!({ "paths": paths }));
      }
    }
  })
  .map_err(|e| e.to_string())?;
  watcher.watch(&root_path, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
  *app.state::<WatchState>().0.lock().unwrap() = Some(watcher); // replaces (and stops) the previous one
  Ok(())
}

// Recovery: unsaved text is journalled under .apidesigner/recovery/ every few seconds, so a crash
// or a power cut never loses typing. It's offered back the next time the project opens.
fn recovery_path(root: &str, path: &str) -> Result<PathBuf, String> {
  if path.contains("..") {
    return Err("Bad path".into());
  }
  Ok(PathBuf::from(root).join(".apidesigner").join("recovery").join(path))
}

#[tauri::command]
pub fn write_recovery(root: String, path: String, text: String) -> Result<(), String> {
  let p = recovery_path(&root, &path)?;
  if let Some(dir) = p.parent() {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  // The app's own folder ignores itself, so it never lands in the user's git repo.
  let ignore = PathBuf::from(&root).join(".apidesigner").join(".gitignore");
  if !ignore.exists() {
    let _ = fs::write(ignore, "*\n");
  }
  fs::write(p, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_recovery(root: String, path: String) -> Result<(), String> {
  let p = recovery_path(&root, &path)?;
  if p.exists() {
    fs::remove_file(p).map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[derive(Serialize)]
pub struct Recovered {
  path: String,
  text: String,
}

#[tauri::command]
pub fn list_recovery(root: String) -> Vec<Recovered> {
  let base = PathBuf::from(&root).join(".apidesigner").join("recovery");
  let mut out = Vec::new();
  fn walk(base: &Path, dir: &Path, out: &mut Vec<Recovered>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
      let p = e.path();
      if p.is_dir() {
        walk(base, &p, out);
      } else if let (Ok(text), Ok(r)) = (fs::read_to_string(&p), p.strip_prefix(base)) {
        out.push(Recovered { path: r.to_string_lossy().replace('\\', "/"), text });
      }
    }
  }
  walk(&base, &base, &mut out);
  out
}
