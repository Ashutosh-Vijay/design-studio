mod amf;
mod anypoint;
mod watch;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
struct ProjectFile {
  path: String, // relative to the project root, always with forward slashes
  size: u64,
}

#[derive(Serialize)]
struct Project {
  root: String,
  name: String,
  main: Option<String>, // the root file
  files: Vec<ProjectFile>,
}

// Folders that are never part of a spec project.
const SKIP_DIRS: [&str; 5] = [".git", "node_modules", ".apidesigner", "target", ".idea"];

fn walk(root: &Path, dir: &Path, out: &mut Vec<ProjectFile>) -> std::io::Result<()> {
  for entry in fs::read_dir(dir)? {
    let entry = entry?;
    let path = entry.path();
    let name = entry.file_name().to_string_lossy().to_string();
    let meta = entry.metadata()?;
    if meta.is_dir() {
      if !SKIP_DIRS.contains(&name.as_str()) {
        walk(root, &path, out)?;
      }
    } else {
      let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
      out.push(ProjectFile { path: rel, size: meta.len() });
    }
  }
  Ok(())
}

// The root file: exchange.json's "main" when it's there, as Design Center keeps it.
// Otherwise the first top-level spec (a RAML 1.0 API, not a fragment, or an OAS file).
fn find_main(root: &Path, files: &[ProjectFile]) -> Option<String> {
  if let Ok(text) = fs::read_to_string(root.join("exchange.json")) {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
      if let Some(main) = json.get("main").and_then(|m| m.as_str()) {
        let main = main.trim_start_matches('/').to_string();
        if files.iter().any(|f| f.path == main) {
          return Some(main);
        }
      }
    }
  }
  let top = files.iter().filter(|f| !f.path.contains('/'));
  for f in top {
    let lower = f.path.to_lowercase();
    if !(lower.ends_with(".raml") || lower.ends_with(".yaml") || lower.ends_with(".yml") || lower.ends_with(".json")) {
      continue;
    }
    let head: String = fs::read_to_string(root.join(&f.path)).unwrap_or_default().chars().take(400).collect();
    let first = head.lines().next().unwrap_or("").trim();
    if first == "#%RAML 1.0" || first == "#%RAML 0.8" || head.contains("openapi:") || head.contains("swagger:") || head.contains("\"openapi\"") || head.contains("\"swagger\"") {
      return Some(f.path.clone());
    }
  }
  None
}

#[tauri::command]
fn open_project(root: String) -> Result<Project, String> {
  let root_path = PathBuf::from(&root);
  if !root_path.is_dir() {
    return Err(format!("{} isn't a folder, or it isn't there any more.", root));
  }
  let mut files = Vec::new();
  walk(&root_path, &root_path, &mut files).map_err(|e| format!("Couldn't read {}: {}", root, e))?;
  files.sort_by(|a, b| a.path.cmp(&b.path));
  let main = find_main(&root_path, &files);
  let name = root_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| root.clone());
  Ok(Project { root, name, main, files })
}

#[tauri::command]
fn read_text_file(root: String, path: String) -> Result<String, String> {
  let root_path = PathBuf::from(&root).canonicalize().map_err(|e| e.to_string())?;
  let full = root_path.join(&path).canonicalize().map_err(|_| format!("File not found: {}", path))?;
  // Never read outside the open project, whatever path the webview sends.
  if !full.starts_with(&root_path) {
    return Err(format!("{} is outside the project.", path));
  }
  let bytes = fs::read(&full).map_err(|e| format!("Couldn't read {}: {}", path, e))?;
  Ok(String::from_utf8_lossy(&bytes).to_string())
}

// Saves what the editor holds. The editor always works in LF; a file that used CRLF on disk
// gets CRLF back, so a save never turns every line into a diff. New files are LF.
#[tauri::command]
fn save_text_file(root: String, path: String, text: String) -> Result<(), String> {
  let root_path = PathBuf::from(&root).canonicalize().map_err(|e| e.to_string())?;
  let full = root_path.join(&path);
  let parent = full.parent().ok_or("Bad path")?;
  fs::create_dir_all(parent).map_err(|e| format!("Couldn't create the folder for {}: {}", path, e))?;
  if !parent.canonicalize().map_err(|e| e.to_string())?.starts_with(&root_path) {
    return Err(format!("{} is outside the project.", path));
  }
  let crlf = fs::read(&full).map(|b| b.windows(2).any(|w| w == b"\r\n")).unwrap_or(false);
  let lf = text.replace("\r\n", "\n");
  let out = if crlf { lf.replace('\n', "\r\n") } else { lf };
  fs::write(&full, out).map_err(|e| format!("Couldn't save {}: {}", path, e))
}

// Inside the project, or an error. The file itself may not exist yet.
fn inside(root: &str, path: &str) -> Result<PathBuf, String> {
  let root_path = PathBuf::from(root).canonicalize().map_err(|e| e.to_string())?;
  let full = root_path.join(path);
  let parent = full.parent().ok_or("Bad path")?.canonicalize().map_err(|_| format!("The folder for {} doesn't exist.", path))?;
  if !parent.starts_with(&root_path) {
    return Err(format!("{} is outside the project.", path));
  }
  Ok(full)
}

#[tauri::command]
fn rename_file(root: String, from: String, to: String) -> Result<(), String> {
  let src = inside(&root, &from)?;
  let dst_rel = PathBuf::from(&root).join(&to);
  if let Some(dir) = dst_rel.parent() {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  let dst = inside(&root, &to)?;
  if dst.exists() {
    return Err(format!("{} already exists.", to));
  }
  fs::rename(&src, &dst).map_err(|e| format!("Couldn't rename {}: {}", from, e))
}

#[tauri::command]
fn delete_file(root: String, path: String) -> Result<(), String> {
  let full = inside(&root, &path)?;
  trash::delete(&full).map_err(|e| format!("Couldn't move {} to the Recycle Bin: {}", path, e))
}

#[derive(Serialize)]
struct ZipImport {
  root: String,
  files: usize,
  duplicates: Vec<String>, // entries that were in the zip more than once: the last copy wins
}

// Unpacks a Design Center or Exchange zip into a new folder. Exchange zips can hold the same
// entry twice (M0.1); the last one wins and the names are reported. Entries can't escape the folder.
#[tauri::command]
fn import_zip(zip_path: String, dest: String) -> Result<ZipImport, String> {
  let dest_path = PathBuf::from(&dest);
  if dest_path.exists() && fs::read_dir(&dest_path).map(|mut d| d.next().is_some()).unwrap_or(false) {
    return Err(format!("{} already has files in it. Pick an empty or new folder.", dest));
  }
  fs::create_dir_all(&dest_path).map_err(|e| format!("Couldn't create {}: {}", dest, e))?;
  let file = fs::File::open(&zip_path).map_err(|e| format!("Couldn't open {}: {}", zip_path, e))?;
  let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("That isn't a readable zip: {}", e))?;
  let mut seen = std::collections::HashSet::new();
  let mut duplicates = Vec::new();
  let mut count = 0;
  for i in 0..archive.len() {
    let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
    let Some(rel) = entry.enclosed_name() else { continue }; // zip-slip guard: skips ../ and absolute names
    if entry.is_dir() {
      continue;
    }
    let name = rel.to_string_lossy().replace('\\', "/");
    // Compared without case: on Windows and macOS two names that differ only in case are one file.
    if !seen.insert(name.to_lowercase()) {
      duplicates.push(name.clone());
    } else {
      count += 1;
    }
    let out = dest_path.join(&rel);
    if let Some(parent) = out.parent() {
      fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = fs::File::create(&out).map_err(|e| format!("Couldn't write {}: {}", name, e))?;
    std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
  }
  Ok(ZipImport { root: dest, files: count, duplicates })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .manage(std::sync::Arc::new(amf::Amf::default()))
    .manage(watch::WatchState::default())
    .manage(std::sync::Arc::new(anypoint::Anypoint::default()))
    .setup(|app| {
      amf::start_in_background(app.handle());
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![open_project, read_text_file, save_text_file, rename_file, delete_file, import_zip, amf::amf, watch::watch_project, watch::write_recovery, watch::clear_recovery, watch::list_recovery,
      anypoint::anypoint_connect, anypoint::anypoint_status, anypoint::anypoint_disconnect, anypoint::anypoint_api, anypoint::anypoint_hold_lock, anypoint::anypoint_release_lock,
      anypoint::anypoint_dev_session])
    .build(tauri::generate_context!())
    .expect("error while building API Designer Studio")
    .run(|app, event| {
      if let tauri::RunEvent::Exit = event {
        amf::stop(app);
        anypoint::release_on_exit(app);
      }
    });
}
