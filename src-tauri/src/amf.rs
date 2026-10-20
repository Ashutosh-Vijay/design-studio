// amf-server process manager (ARCHITECTURE section 4), after DataWeave Studio's dw_server.rs:
// spawn the jar, wait for its ready line with a timeout, keep a tail of stderr for the error banner,
// route replies by id, and restart it (replaying open and overlays) if it dies.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

struct Proc {
  child: Child,
  stdin: ChildStdin,
}

#[derive(Default)]
pub struct Amf {
  proc: Mutex<Option<Proc>>,
  pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
  next_id: AtomicU64,
  stderr_tail: Arc<Mutex<Vec<String>>>,
  last_open: Mutex<Option<Value>>,
  overlays: Mutex<HashMap<String, Value>>,
  exits: Mutex<Vec<std::time::Instant>>,
  stopping: std::sync::atomic::AtomicBool,
}

fn status(app: &AppHandle, state: &str, detail: &str) {
  let _ = app.emit("amf-status", json!({ "state": state, "detail": detail }));
}

// Windows hands back install paths in the verbatim form (\\?\C:\...). Java opens the jar from it but its class
// loader can't, which surfaced as "Could not find or load main class amfserver.Main" in the installed app.
fn plain(p: PathBuf) -> PathBuf {
  p.to_str().and_then(|s| s.strip_prefix(r"\\?\")).map(PathBuf::from).unwrap_or(p)
}

fn find_jar(app: &AppHandle) -> Option<PathBuf> {
  // Release: bundled next to the app. Dev: the Maven build output.
  if let Ok(dir) = app.path().resource_dir() {
    let p = plain(dir.join("resources").join("amf-server").join("amf-server.jar"));
    if p.exists() {
      return Some(p);
    }
  }
  let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("amf-server").join("target").join("amf-server.jar");
  dev.exists().then_some(dev)
}

fn find_java(app: &AppHandle) -> PathBuf {
  let exe = if cfg!(windows) { "java.exe" } else { "java" };
  if let Ok(dir) = app.path().resource_dir() {
    let p = plain(dir.join("resources").join("jre").join("bin").join(exe));
    if p.exists() {
      return p;
    }
  }
  if let Ok(home) = std::env::var("JAVA_HOME") {
    let p = PathBuf::from(home).join("bin").join(exe);
    if p.exists() {
      return p;
    }
  }
  PathBuf::from(exe)
}

impl Amf {
  fn ensure_started(&self, app: &AppHandle) -> Result<(), String> {
    let mut guard = self.proc.lock().unwrap();
    if let Some(p) = guard.as_mut() {
      if p.child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
        return Ok(());
      }
    }
    *guard = None;
    status(app, "starting", "");
    let jar = find_jar(app).ok_or("The checking engine (amf-server.jar) is missing. In development, build it with mvn package in amf-server.")?;
    let java = find_java(app);
    let mut cmd = Command::new(&java);
    cmd.arg("-Xmx1g")
      .arg("-Dfile.encoding=UTF-8")
      .arg("-Dstdout.encoding=UTF-8")
      .arg("-Dsun.stdout.encoding=UTF-8")
      .arg("-Dsun.jnu.encoding=UTF-8")
      .arg("-jar")
      .arg(&jar)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped());
    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt;
      cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| {
      let msg = format!("Couldn't start Java ({}): {}. Install Java 17 or later, or set JAVA_HOME.", java.display(), e);
      status(app, "failed", &msg);
      msg
    })?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // stderr: keep the last lines for the error banner. An unread pipe would block the JVM.
    let tail = self.stderr_tail.clone();
    std::thread::spawn(move || {
      for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        let mut t = tail.lock().unwrap();
        t.push(line);
        if t.len() > 60 {
          t.remove(0);
        }
      }
    });

    // stdout: the ready line, then replies routed by id.
    let (ready_tx, ready_rx) = mpsc::channel::<()>();
    let pending = self.pending.clone();
    let app2 = app.clone();
    let tail2 = self.stderr_tail.clone();
    std::thread::spawn(move || {
      let mut ready = Some(ready_tx);
      for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("event").and_then(|e| e.as_str()) == Some("ready") {
          if let Some(tx) = ready.take() {
            let _ = tx.send(());
          }
          continue;
        }
        if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
          if let Some(tx) = pending.lock().unwrap().remove(&id) {
            let _ = tx.send(v);
          }
        }
      }
      // The process ended: fail whatever was waiting, and say so.
      pending.lock().unwrap().clear();
      let last = tail2.lock().unwrap().iter().rev().take(8).cloned().collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
      status(&app2, "stopped", &last);
      // Restart on its own (the project and unsaved text are replayed), unless it keeps dying:
      // three exits within a minute stops trying, and the banner stays up.
      let state = app2.state::<Arc<Amf>>().inner().clone();
      if state.stopping.load(Ordering::SeqCst) {
        return;
      }
      let now = std::time::Instant::now();
      let mut recent = state.exits.lock().unwrap();
      recent.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
      recent.push(now);
      if recent.len() >= 3 {
        status(&app2, "failed", &format!("The checking engine stopped 3 times in a minute, so it's off for now.\n{}", last));
        return;
      }
      drop(recent);
      std::thread::sleep(Duration::from_millis(800));
      let _ = state.ensure_started(&app2);
    });

    // Handshake with a timeout: endpoint security can block the JRE without an error (DataWeave Studio lesson).
    if ready_rx.recv_timeout(Duration::from_secs(30)).is_err() {
      let _ = child.kill();
      let last = self.stderr_tail.lock().unwrap().join("\n");
      let msg = format!("The checking engine didn't start within 30 seconds. {}", if last.is_empty() { "Security software may be blocking Java.".to_string() } else { last });
      status(app, "failed", &msg);
      return Err(msg);
    }
    *guard = Some(Proc { child, stdin });
    drop(guard);
    status(app, "ready", "");

    // After a restart, put back the project and the unsaved text.
    if let Some(open) = self.last_open.lock().unwrap().clone() {
      let _ = self.send_raw(open);
      let files: serde_json::Map<String, Value> = self.overlays.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
      if !files.is_empty() {
        let _ = self.send_raw(json!({ "op": "overlay", "files": files }));
      }
    }
    Ok(())
  }

  fn send_raw(&self, mut req: Value) -> Result<mpsc::Receiver<Value>, String> {
    let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    req["id"] = json!(id);
    let (tx, rx) = mpsc::channel();
    self.pending.lock().unwrap().insert(id, tx);
    let mut guard = self.proc.lock().unwrap();
    let p = guard.as_mut().ok_or("The checking engine isn't running")?;
    writeln!(p.stdin, "{}", req).and_then(|_| p.stdin.flush()).map_err(|e| e.to_string())?;
    Ok(rx)
  }

  pub fn request(&self, app: &AppHandle, op: &str, mut args: Value) -> Result<Value, String> {
    // Remember what a restart needs to replay.
    match op {
      "open" => {
        *self.last_open.lock().unwrap() = Some(json!({ "op": "open", "root": args["root"], "main": args["main"] }));
        self.overlays.lock().unwrap().clear();
      }
      "overlay" => {
        if let Some(files) = args.get("files").and_then(|f| f.as_object()) {
          let mut o = self.overlays.lock().unwrap();
          for (k, v) in files {
            if v.is_null() { o.remove(k); } else { o.insert(k.clone(), v.clone()); }
          }
        }
      }
      _ => {}
    }
    self.ensure_started(app)?;
    args["op"] = json!(op);
    let rx = self.send_raw(args)?;
    let reply = rx.recv_timeout(Duration::from_secs(120)).map_err(|_| "The checking engine didn't answer".to_string())?;
    if reply.get("ok").and_then(|o| o.as_bool()) == Some(false) {
      return Err(reply.get("error").and_then(|e| e.as_str()).unwrap_or("error").to_string());
    }
    Ok(reply)
  }
}

#[tauri::command]
pub async fn amf(app: AppHandle, op: String, args: Value) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<Arc<Amf>>().inner().clone();
    state.request(&app, &op, args)
  })
  .await
  .map_err(|e| e.to_string())?
}

// Start and warm up at launch, so the first check after opening a project is fast.
pub fn start_in_background(app: &AppHandle) {
  let app = app.clone();
  std::thread::spawn(move || {
    let state = app.state::<Arc<Amf>>().inner().clone();
    let _ = state.ensure_started(&app);
  });
}

pub fn stop(app: &AppHandle) {
  if let Some(state) = app.try_state::<Arc<Amf>>() {
    state.stopping.store(true, Ordering::SeqCst); // the app is closing: don't restart it
    if let Some(mut p) = state.proc.lock().unwrap().take() {
      let _ = p.child.kill();
    }
  }
}
