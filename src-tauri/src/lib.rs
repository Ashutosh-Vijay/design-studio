mod amf;
mod anypoint;
mod mcp;
mod watch;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

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

// More files than any spec project has: the wrong folder was picked (a home folder, a whole drive).
const MAX_FILES: usize = 20_000;

fn walk(root: &Path, dir: &Path, out: &mut Vec<ProjectFile>, dirs: &mut Vec<String>) -> std::io::Result<()> {
  for entry in fs::read_dir(dir)? {
    // One entry that can't be read (a broken link, a folder without permission) is left out, not a reason to refuse the project.
    let Ok(entry) = entry else { continue };
    let path = entry.path();
    let name = entry.file_name().to_string_lossy().to_string();
    let Ok(meta) = fs::metadata(&path) else { continue };
    if out.len() > MAX_FILES { return Err(std::io::Error::other("too many files")); }
    if meta.is_dir() {
      if !SKIP_DIRS.contains(&name.as_str()) {
        dirs.push(path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/"));
        // An unreadable folder shows empty; only the file limit stops the walk.
        if walk(root, &path, out, dirs).is_err() && out.len() > MAX_FILES { return Err(std::io::Error::other("too many files")); }
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
    if first == "#%RAML 1.0" || first == "#%RAML 0.8" || head.contains("openapi:") || head.contains("swagger:") || head.contains("\"openapi\"") || head.contains("\"swagger\"") || head.contains("asyncapi:") || head.contains("\"asyncapi\"") {
      return Some(f.path.clone());
    }
  }
  None
}

// Off the main thread (async), like the zip commands below: a big folder never freezes the window.
#[tauri::command(async)]
fn open_project(root: String) -> Result<Project, String> {
  let root_path = PathBuf::from(&root);
  if !root_path.is_dir() {
    return Err(format!("{} isn't a folder, or it isn't there any more.", root));
  }
  let mut files = Vec::new();
  let mut dirs = Vec::new();
  if let Err(e) = walk(&root_path, &root_path, &mut files, &mut dirs) {
    return Err(if files.len() > MAX_FILES { format!("{} has more than {} files, so it doesn't look like a spec project. Open the folder that holds the specification.", root, MAX_FILES) } else { format!("Couldn't read {}: {}", root, e) });
  }
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
  let full = inside_make(&root, &path, true)?;
  // A mixed file keeps the ending most of its lines use.
  let crlf = fs::read(&full).map(|b| { let n = b.windows(2).filter(|w| *w == b"\r\n").count(); n > 0 && n * 2 >= b.iter().filter(|&&c| c == b'\n').count() }).unwrap_or(false);
  let lf = text.replace("\r\n", "\n");
  let out = if crlf { lf.replace('\n', "\r\n") } else { lf };
  write_whole(&full, out.as_bytes()).map_err(|e| format!("Couldn't save {}: {}", path, e))
}

// Written beside the file and renamed over it, so a crash or a full disk part way never leaves half a spec.
// The watcher ignores the .ds-tmp name (watch.rs).
fn write_whole(full: &Path, bytes: &[u8]) -> std::io::Result<()> {
  let tmp = full.with_file_name(format!(".{}.ds-tmp", full.file_name().unwrap_or_default().to_string_lossy()));
  // A folder that refuses the rename: written in place, as before.
  fs::write(&tmp, bytes).and_then(|_| fs::rename(&tmp, full)).or_else(|_| { let _ = fs::remove_file(&tmp); fs::write(full, bytes) })
}

// Files that aren't UTF-8 text (an image or a PDF in a Design Center project) travel through sync as this marker
// and their bytes in base64, so a pull writes them back byte for byte. sync.ts knows the marker too.
pub const B64: &str = "\u{0}b64:";
pub fn text_or_b64(bytes: Vec<u8>) -> String {
  use base64::Engine;
  String::from_utf8(bytes).unwrap_or_else(|e| format!("{B64}{}", base64::engine::general_purpose::STANDARD.encode(e.into_bytes())))
}

// A file exactly as it is on disk, for sync: text as text, anything else as the marker and base64.
#[tauri::command]
fn read_file_exact(root: String, path: String) -> Result<String, String> {
  let root_path = PathBuf::from(&root).canonicalize().map_err(|e| e.to_string())?;
  let full = root_path.join(&path).canonicalize().map_err(|_| format!("File not found: {}", path))?;
  if !full.starts_with(&root_path) { return Err(format!("{} is outside the project.", path)); }
  fs::read(&full).map(text_or_b64).map_err(|e| format!("Couldn't read {}: {}", path, e))
}

// A path relative to the project made of plain names only: no .., no drive or leading slash. Checked before
// any folder is made, so nothing is ever created outside the project.
fn plain_rel(path: &str) -> Result<(), String> {
  if path.is_empty() || !Path::new(path).components().all(|c| matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir)) {
    return Err(format!("{} is outside the project.", path));
  }
  Ok(())
}

// Inside the project, or an error. The file itself may not exist yet. Every part that exists is checked where it
// really is (links and junctions followed): the nearest existing folder before any folder is made (with make),
// then the folder, then the file if it's there, so a link inside the project can't lead a write outside it.
fn inside_make(root: &str, path: &str, make: bool) -> Result<PathBuf, String> {
  plain_rel(path)?;
  let root_path = PathBuf::from(root).canonicalize().map_err(|e| e.to_string())?;
  let full = root_path.join(path);
  let outside = || format!("{} is outside the project.", path);
  let mut at = full.parent().ok_or("Bad path")?.to_path_buf();
  while !at.exists() { match at.parent() { Some(p) => at = p.to_path_buf(), None => break } }
  if !at.canonicalize().map_err(|e| e.to_string())?.starts_with(&root_path) { return Err(outside()); }
  let parent = full.parent().ok_or("Bad path")?;
  if make { fs::create_dir_all(parent).map_err(|e| format!("Couldn't create the folder for {}: {}", path, e))?; }
  let parent = parent.canonicalize().map_err(|_| format!("The folder for {} doesn't exist.", path))?;
  if !parent.starts_with(&root_path) { return Err(outside()); }
  if full.exists() && !full.canonicalize().map_err(|e| e.to_string())?.starts_with(&root_path) { return Err(outside()); }
  Ok(full)
}
fn inside(root: &str, path: &str) -> Result<PathBuf, String> { inside_make(root, path, false) }

#[tauri::command]
fn rename_file(root: String, from: String, to: String) -> Result<(), String> {
  let src = inside(&root, &from)?;
  let dst = inside_make(&root, &to, true)?;
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
#[tauri::command(async)]
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
#[tauri::command(async)]
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
#[tauri::command(async)]
fn import_into(root: String, folder: String, sources: Vec<String>, overwrite: bool) -> Result<Imported, String> {
  let root_path = PathBuf::from(&root).canonicalize().map_err(|e| e.to_string())?;
  let dest = if folder.is_empty() { root_path.clone() } else { inside_make(&root, &folder, true)? };
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
  let full = inside_make(&root, &path, true)?;
  use base64::Engine;
  let bytes = match text.strip_prefix(B64) {
    Some(b) => base64::engine::general_purpose::STANDARD.decode(b).map_err(|e| format!("Couldn't write {}: {}", path, e))?,
    None => text.into_bytes(),
  };
  write_whole(&full, &bytes).map_err(|e| format!("Couldn't write {}: {}", path, e))
}

// Windows: each shows one project (or the start screen), and a project is open in one window only, so two
// windows never edit the same files. projects: window label -> its project root, compared as same_root does.
#[derive(Default)]
struct Windows {
  projects: std::sync::Mutex<std::collections::HashMap<String, String>>,
  next: std::sync::atomic::AtomicU64,
}
fn same_root(p: &str) -> String {
  let s = p.replace('\\', "/").trim_end_matches('/').to_string();
  if cfg!(target_os = "linux") { s } else { s.to_lowercase() } // Windows and macOS ignore case in paths
}
fn focus(w: &tauri::WebviewWindow) { let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus(); }
fn window_with(app: &tauri::AppHandle, root: &str, not: &str) -> Option<tauri::WebviewWindow> {
  let key = same_root(root);
  let label = app.state::<Windows>().projects.lock().unwrap().iter().find(|(l, r)| **r == key && l.as_str() != not).map(|(l, _)| l.clone())?;
  app.get_webview_window(&label)
}

// Another window with this project open comes to the front instead, and says so (true).
#[tauri::command]
fn project_window(app: tauri::AppHandle, window: tauri::Window, root: String) -> bool {
  window_with(&app, &root, window.label()).map(|w| focus(&w)).is_some()
}

// What this window has open now; None is the start screen.
#[tauri::command]
fn claim_project(app: tauri::AppHandle, window: tauri::Window, root: Option<String>) {
  let state = app.state::<Windows>();
  let mut m = state.projects.lock().unwrap();
  match root { Some(r) => { m.insert(window.label().to_string(), same_root(&r)); } None => { m.remove(window.label()); } }
}

// A new window, on the start screen or with a project (a window that already has it comes to the front).
// Async: building a window from a synchronous command deadlocks on Windows.
#[tauri::command]
async fn open_window(app: tauri::AppHandle, root: Option<String>) -> Result<(), String> { new_window(&app, root) }

fn new_window(app: &tauri::AppHandle, root: Option<String>) -> Result<(), String> {
  if let Some(w) = root.as_deref().and_then(|r| window_with(app, r, "")) { focus(&w); return Ok(()); }
  let label = format!("w{}", app.state::<Windows>().next.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1);
  // The project goes in the address (the page opens it); a reload keeps it.
  let url = match &root {
    Some(r) => format!("index.html?open={}", r.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{:02X}", b) }).collect::<String>()),
    None => "index.html".to_string(),
  };
  let light = light_theme(app);
  let b = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App(url.into()))
    .title("Design Studio for MuleSoft").inner_size(1280.0, 840.0).min_inner_size(1000.0, 600.0)
    .visible(false)
    .background_color(if light { tauri::window::Color(249, 248, 246, 255) } else { tauri::window::Color(10, 9, 7, 255) });
  // A Mac keeps its native title bar under our header, with the real traffic lights (as tauri.macos.conf.json
  // does for the first window); elsewhere the app draws its own buttons.
  #[cfg(target_os = "macos")]
  let b = b.decorations(true).title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true).traffic_light_position(tauri::LogicalPosition::new(16.0, 16.0));
  #[cfg(not(target_os = "macos"))]
  let b = b.decorations(false);
  b.build().map_err(|e| format!("Couldn't open a new window: {e}"))?;
  // The page shows the window after its first frame; this is the safety net.
  let (h, l) = (app.clone(), label.clone());
  std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(4)); if let Some(w) = h.get_webview_window(&l) { let _ = w.show(); } });
  amf::start_in_background(app, &label);
  Ok(())
}

// Settings, recent projects and panel sizes live in the webview's storage, which goes when its data is cleared
// (and differs between a development and an installed build). A copy is kept here, in the app's own folder, and
// given back when the storage comes up empty (src/main.tsx).
#[tauri::command]
fn prefs_load(app: tauri::AppHandle) -> String {
  tauri::Manager::path(&app).app_config_dir().ok().and_then(|d| fs::read_to_string(d.join("prefs.json")).ok()).unwrap_or_default()
}
#[tauri::command]
fn prefs_save(app: tauri::AppHandle, text: String) -> Result<(), String> {
  let dir = tauri::Manager::path(&app).app_config_dir().map_err(|e| e.to_string())?;
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  write_whole(&dir.join("prefs.json"), text.as_bytes()).map_err(|e| e.to_string())
}

fn light_theme(app: &tauri::AppHandle) -> bool {
  tauri::Manager::path(app).app_config_dir().ok().and_then(|d| fs::read_to_string(d.join("theme")).ok()).is_some_and(|t| t.trim() == "light")
}

// The theme's light or dark, for the window's colour on the next start (before the page can say).
#[tauri::command]
fn remember_theme(app: tauri::AppHandle, dark: bool) -> Result<(), String> {
  let dir = tauri::Manager::path(&app).app_config_dir().map_err(|e| e.to_string())?;
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  fs::write(dir.join("theme"), if dark { "dark" } else { "light" }).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Starting Design Studio again (the Start menu, the Dock) opens another window in this one.
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| { let _ = new_window(app, None); }))
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .manage(amf::Engines::default())
    .manage(Windows::default())
    .manage(watch::WatchState::default())
    .manage(std::sync::Arc::new(anypoint::Anypoint::default()))
    .manage(mcp::Mcp::default())
    .setup(|app| {
      // The window is painted in the theme's background from the first frame, so a slow load is never a white
      // flash: dark by default (tauri.conf.json), light when that was the theme last time (remember_theme).
      if light_theme(app.handle()) { if let Some(w) = tauri::Manager::get_webview_window(app.handle(), "main") { let _ = w.set_background_color(Some(tauri::window::Color(249, 248, 246, 255))); } }
      // The window starts hidden and the page shows it after its first frame; this is the safety net.
      let h = app.handle().clone();
      std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(4)); if let Some(w) = tauri::Manager::get_webview_window(&h, "main") { let _ = w.show(); } });
      amf::start_in_background(app.handle(), "main");
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![open_project, read_text_file, read_file_exact, save_text_file, write_file_exact, rename_file, delete_file, create_dir, export_zip, import_zip, import_into, fetch_url, amf::amf, watch::watch_project, watch::write_recovery, watch::clear_recovery, watch::list_recovery,
      anypoint::anypoint_connect, anypoint::anypoint_status, anypoint::anypoint_disconnect, anypoint::anypoint_api, anypoint::anypoint_hold_lock, anypoint::anypoint_release_lock, anypoint::anypoint_fetch_dependency, anypoint::anypoint_set_read_only, anypoint::anypoint_set_org, anypoint::anypoint_regions, anypoint::health_check, anypoint::health_secret,
      anypoint::anypoint_dev_session, anypoint::anypoint_dev_deny, remember_theme, prefs_load, prefs_save, open_window, project_window, claim_project, mcp::mcp_start, mcp::mcp_stop, mcp::mcp_status, mcp::mcp_reply])
    .on_window_event(|w, e| match e {
      // AI tools work in the window used last.
      tauri::WindowEvent::Focused(true) => { if !mcp::busy(w.app_handle()) { *w.app_handle().state::<mcp::Mcp>().target.lock().unwrap() = w.label().to_string(); } }
      // A closed window lets go of its project, its engine, its watcher and its lock.
      tauri::WindowEvent::Destroyed => {
        let (app, label) = (w.app_handle().clone(), w.label().to_string());
        app.state::<Windows>().projects.lock().unwrap().remove(&label);
        app.state::<watch::WatchState>().0.lock().unwrap().remove(&label);
        amf::stop(&app, Some(&label));
        { let mcp = app.state::<mcp::Mcp>(); let mut t = mcp.target.lock().unwrap(); if *t == label { *t = app.webview_windows().into_keys().find(|l| *l != label).unwrap_or_default(); *mcp.last_call.lock().unwrap() = None; } }
        std::thread::spawn(move || anypoint::release_on_exit(&app, Some(&label)));
      }
      _ => {}
    })
    .build(tauri::generate_context!())
    .expect("error while building Design Studio")
    .run(|app, event| {
      if let tauri::RunEvent::Exit = event {
        amf::stop(app, None);
        anypoint::release_on_exit(app, None);
      }
    });
}
