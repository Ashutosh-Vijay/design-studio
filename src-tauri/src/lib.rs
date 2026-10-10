mod amf;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(std::sync::Arc::new(amf::Amf::default()))
    .setup(|app| {
      amf::start_in_background(app.handle());
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![open_project, read_text_file, save_text_file, amf::amf])
    .build(tauri::generate_context!())
    .expect("error while building API Designer Studio")
    .run(|app, event| {
      if let tauri::RunEvent::Exit = event {
        amf::stop(app);
      }
    });
}
