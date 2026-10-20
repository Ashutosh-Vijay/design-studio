mod amf;
mod anypoint;
mod mcp;
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
  dirs: Vec<String>, // every folder, empty ones too, relative with forward slashes
}

// Folders that are never part of a spec project.
const SKIP_DIRS: [&str; 5] = [".git", "node_modules", ".apidesigner", "target", ".idea"];

fn walk(root: &Path, dir: &Path, out: &mut Vec<ProjectFile>, dirs: &mut Vec<String>) -> std::io::Result<()> {
  for entry in fs::read_dir(dir)? {
    let entry = entry?;
    let path = entry.path();
    let name = entry.file_name().to_string_lossy().to_string();
    let meta = entry.metadata()?;
    if meta.is_dir() {
      if !SKIP_DIRS.contains(&name.as_str()) {
        dirs.push(path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/"));
        walk(root, &path, out, dirs)?;
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
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) {
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
    let first = head.lines().next().unwrap_or("").trim_start_matches('\u{feff}').trim();
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
  let mut dirs = Vec::new();
  walk(&root_path, &root_path, &mut files, &mut dirs).map_err(|e| format!("Couldn't read {}: {}", root, e))?;
  files.sort_by(|a, b| a.path.cmp(&b.path));
  let main = find_main(&root_path, &files);
  let name = root_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| root.clone());
  dirs.sort();
  Ok(Project { root, name, main, files, dirs })
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
  // Not UTF-8 (a Latin-1 file, an image): refused, since saving the decoded text back would replace characters.
  String::from_utf8(bytes).map_err(|_| format!("{} isn't UTF-8 text, so it can't be opened here.", path))
}

// Saves what the editor holds. The editor always works in LF; a file that used CRLF on disk
// gets CRLF back, so a save never turns every line into a diff. New files are LF.
#[tauri::command]
fn save_text_file(root: String, path: String, text: String) -> Result<(), String> {
  plain_rel(&path)?;
  let root_path = PathBuf::from(&root).canonicalize().map_err(|e| e.to_string())?;
  let full = root_path.join(&path);
  let parent = full.parent().ok_or("Bad path")?;
  fs::create_dir_all(parent).map_err(|e| format!("Couldn't create the folder for {}: {}", path, e))?;
  if !parent.canonicalize().map_err(|e| e.to_string())?.starts_with(&root_path) {
    return Err(format!("{} is outside the project.", path));
  }
  // A mixed file keeps the ending most of its lines use.
  let crlf = fs::read(&full).map(|b| { let n = b.windows(2).filter(|w| *w == b"\r\n").count(); n > 0 && n * 2 >= b.iter().filter(|&&c| c == b'\n').count() }).unwrap_or(false);
  let lf = text.replace("\r\n", "\n");
  let out = if crlf { lf.replace('\n', "\r\n") } else { lf };
  fs::write(&full, out).map_err(|e| format!("Couldn't save {}: {}", path, e))
}

// A path relative to the project made of plain names only: no .., no drive or leading slash. Checked before
// any folder is made, so nothing is ever created outside the project.
fn plain_rel(path: &str) -> Result<(), String> {
  if path.is_empty() || !Path::new(path).components().all(|c| matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir)) {
    return Err(format!("{} is outside the project.", path));
  }
  Ok(())
}

// Inside the project, or an error. The file itself may not exist yet.
fn inside(root: &str, path: &str) -> Result<PathBuf, String> {
  plain_rel(path)?;
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
  plain_rel(&to)?;
  if let Some(dir) = PathBuf::from(&root).join(&to).parent() {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  let dst = inside(&root, &to)?;
  // Only the letter case changes: on Windows and macOS that's the same file, not a clash.
  let same = dst.exists() && src.canonicalize().ok() == dst.canonicalize().ok();
  if dst.exists() && !same {
    return Err(format!("{} already exists.", to));
  }
  fs::rename(&src, &dst).map_err(|e| format!("Couldn't rename {}: {}", from, e))
}

#[tauri::command]
fn delete_file(root: String, path: String) -> Result<(), String> {
  let full = inside(&root, &path)?;
  trash::delete(&full).map_err(|e| format!("Couldn't move {} to the {}: {}", path, if cfg!(windows) { "Recycle Bin" } else { "Trash" }, e))
}

// Download as zip (the project menu): every file, Exchange dependencies included, as Design Center's
// Download Project gives it; the app's own .apidesigner folder and .git stay out.
#[tauri::command]
fn export_zip(root: String, dest: String) -> Result<usize, String> {
  let root_path = PathBuf::from(&root);
  let (mut files, mut dirs) = (Vec::new(), Vec::new());
  walk(&root_path, &root_path, &mut files, &mut dirs).map_err(|e| e.to_string())?;
  // The zip itself may be inside the project (an earlier download): never pack it into itself.
  let dest_abs = PathBuf::from(&dest).canonicalize().ok();
  files.retain(|f| dest_abs.is_none() || root_path.join(&f.path).canonicalize().ok() != dest_abs);
  let mut zw = zip::ZipWriter::new(fs::File::create(&dest).map_err(|e| format!("Couldn't write {}: {}", dest, e))?);
  let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
  for f in &files {
    zw.start_file(f.path.as_str(), opts).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut zw, &fs::read(root_path.join(&f.path)).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
  }
  zw.finish().map_err(|e| e.to_string())?;
  Ok(files.len())
}

// New folder (Files, +): inside the project only, and never over something that's there.
#[tauri::command]
fn create_dir(root: String, path: String) -> Result<(), String> {
  let full = inside(&root, &path)?;
  if full.exists() { return Err(format!("{} already exists.", path)); }
  fs::create_dir(&full).map_err(|e| format!("Couldn't make {}: {}", path, e))
}

#[derive(Serialize)]
struct ZipImport {
  root: String,
  files: usize,
  duplicates: Vec<String>, // entries that were in the zip more than once: the last copy wins
}

// Unpacks a zip into a folder: entries that would land outside it are skipped (zip-slip), and a name that
// appears twice (compared without case, as Windows and macOS do) is reported; the last copy wins.
// Used by the zip import and for Exchange dependencies.
pub fn unzip_into<R: std::io::Read + std::io::Seek>(reader: R, dest_path: &Path) -> Result<(usize, Vec<String>), String> {
  let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("That isn't a readable zip: {}", e))?;
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
  Ok((count, duplicates))
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
  let (count, duplicates) = unzip_into(file, &dest_path)?;
  Ok(ZipImport { root: dest, files: count, duplicates })
}

// Import (the project menu): files and zips from this computer into a folder of the open project. Without
// overwrite, nothing is written when something would be replaced; the names come back to ask about.
#[derive(Serialize)]
struct Imported { written: Vec<String>, existing: Vec<String> }
#[tauri::command]
fn import_into(root: String, folder: String, sources: Vec<String>, overwrite: bool) -> Result<Imported, String> {
  let root_path = PathBuf::from(&root).canonicalize().map_err(|e| e.to_string())?;
  let dest = root_path.join(&folder);
  if !dest.starts_with(&root_path) || folder.contains("..") { return Err(format!("{} is outside the project.", folder)); }
  let rel = |p: &Path| p.strip_prefix(&root_path).unwrap_or(p).to_string_lossy().replace('\\', "/");
  // Where each source lands: a file by its name, a zip by its entries.
  let mut targets: Vec<PathBuf> = Vec::new();
  for s in &sources {
    if s.to_lowercase().ends_with(".zip") {
      let mut z = zip::ZipArchive::new(fs::File::open(s).map_err(|e| format!("Couldn't open {}: {}", s, e))?).map_err(|e| format!("{} isn't a readable zip: {}", s, e))?;
      for i in 0..z.len() {
        let e = z.by_index(i).map_err(|e| e.to_string())?;
        if let Some(n) = e.enclosed_name() { if !e.is_dir() { targets.push(dest.join(n)); } }
      }
    } else {
      targets.push(dest.join(Path::new(s).file_name().ok_or("Bad file name")?));
    }
  }
  let existing: Vec<String> = targets.iter().filter(|t| t.exists()).map(|t| rel(t)).collect();
  if !overwrite && !existing.is_empty() { return Ok(Imported { written: vec![], existing }); }
  fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
  for s in &sources {
    if s.to_lowercase().ends_with(".zip") { unzip_into(fs::File::open(s).map_err(|e| e.to_string())?, &dest)?; }
    else {
      let to = dest.join(Path::new(s).file_name().unwrap());
      if to.exists() && Path::new(s).canonicalize().ok() == to.canonicalize().ok() { continue; } // already that file: copying would empty it
      fs::copy(s, &to).map_err(|e| format!("Couldn't copy {}: {}", s, e))?;
    }
  }
  Ok(Imported { written: targets.iter().map(|t| rel(t)).collect(), existing })
}

// Import from URL: one file's text (Design Center's "a URL, a single file"). http and https only, up to 10 MB.
#[tauri::command]
async fn fetch_url(url: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    if !(url.starts_with("https://") || url.starts_with("http://")) { return Err("Use an http or https address.".into()); }
    let r = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(30)).build().map_err(|e| e.to_string())?
      .get(&url).send().map_err(|e| format!("Couldn't fetch it: {e}"))?;
    if !r.status().is_success() { return Err(format!("The server answered {}.", r.status())); }
    if r.content_length().unwrap_or(0) > 10 * 1024 * 1024 { return Err("That file is over 10 MB.".into()); }
    let b = r.bytes().map_err(|e| e.to_string())?;
    if b.len() > 10 * 1024 * 1024 { return Err("That file is over 10 MB.".into()); }
    Ok(String::from_utf8_lossy(&b).to_string())
  }).await.map_err(|e| e.to_string())?
}

// Writes text exactly as given (no line-ending changes): files pulled from Design Center, and the
// sync metadata in .apidesigner/. Parent folders are made; never outside the project.
#[tauri::command]
fn write_file_exact(root: String, path: String, text: String) -> Result<(), String> {
  let root_path = PathBuf::from(&root);
  fs::create_dir_all(&root_path).map_err(|e| format!("Couldn't create {}: {}", root, e))?;
  plain_rel(&path)?;
  let root_path = root_path.canonicalize().map_err(|e| e.to_string())?;
  let full = root_path.join(&path);
  let parent = full.parent().ok_or("Bad path")?;
  fs::create_dir_all(parent).map_err(|e| format!("Couldn't create the folder for {}: {}", path, e))?;
  if !parent.canonicalize().map_err(|e| e.to_string())?.starts_with(&root_path) {
    return Err(format!("{} is outside the project.", path));
  }
  fs::write(&full, text).map_err(|e| format!("Couldn't write {}: {}", path, e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .manage(std::sync::Arc::new(amf::Amf::default()))
    .manage(watch::WatchState::default())
    .manage(std::sync::Arc::new(anypoint::Anypoint::default()))
    .manage(mcp::Mcp::default())
    .setup(|app| {
      // The window starts hidden and the page shows it after its first frame; this is the safety net.
      let h = app.handle().clone();
      std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(4)); if let Some(w) = tauri::Manager::get_webview_window(&h, "main") { let _ = w.show(); } });
      amf::start_in_background(app.handle());
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![open_project, read_text_file, save_text_file, write_file_exact, rename_file, delete_file, create_dir, export_zip, import_zip, import_into, fetch_url, amf::amf, watch::watch_project, watch::write_recovery, watch::clear_recovery, watch::list_recovery,
      anypoint::anypoint_connect, anypoint::anypoint_status, anypoint::anypoint_disconnect, anypoint::anypoint_api, anypoint::anypoint_hold_lock, anypoint::anypoint_release_lock, anypoint::anypoint_fetch_dependency, anypoint::anypoint_set_read_only, anypoint::anypoint_set_org, anypoint::anypoint_broker_regions,
      anypoint::anypoint_dev_session, mcp::mcp_start, mcp::mcp_stop, mcp::mcp_status, mcp::mcp_reply])
    .build(tauri::generate_context!())
    .expect("error while building Design Studio")
    .run(|app, event| {
      if let tauri::RunEvent::Exit = event {
        amf::stop(app);
        anypoint::release_on_exit(app);
      }
    });
}
