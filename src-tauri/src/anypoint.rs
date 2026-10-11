// Anypoint sign-in and calls (M3). The app holds no secret of its own: the user's own Connected App
// (BYOK) signs in through the browser (authorization code) or as itself (client credentials). Its secret
// and the refresh token live in the system keychain; the access token only in memory. The broker for
// "Sign in with Anypoint" (our Connected App, secret in Cloudflare) comes later in M3.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const SERVICE: &str = "API Designer Studio";
// What the user registers as the redirect URI in their Connected App (shown in the sign-in form).
pub const REDIRECT: &str = "http://localhost:8765/callback";

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Connection {
  mode: String, // "code" (browser sign-in) or "client" (client credentials)
  client_id: String,
  host: String, // https://anypoint.mulesoft.com, or a regional host
}

#[derive(Clone, Serialize)]
pub struct Me {
  username: String,
  user_id: String,
  org_id: String,
  org_name: String,
  host: String,
  mode: String,
}

struct Session {
  conn: Connection,
  access: String,
  expires: Instant,
  me: Me,
}

struct LockHold {
  project: String,
  branch: String,
  stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Anypoint {
  session: Mutex<Option<Session>>,
  lock: Mutex<Option<LockHold>>,
}

fn keychain(name: &str) -> Result<keyring::Entry, String> {
  keyring::Entry::new(SERVICE, name).map_err(|e| format!("The system keychain isn't available: {e}"))
}
fn conn_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
  Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("anypoint.json"))
}
fn random_hex() -> String {
  // Two values from the per-process random SipHash keys: enough for an OAuth state and nonce.
  let a = std::collections::hash_map::RandomState::new().build_hasher().finish();
  let b = std::collections::hash_map::RandomState::new().build_hasher().finish();
  format!("{a:016x}{b:016x}")
}
fn client() -> reqwest::blocking::Client {
  reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).build().expect("http client")
}

// Anypoint's token endpoint takes a JSON body (M0.3).
fn token_request(host: &str, body: Value) -> Result<Value, String> {
  let res = client().post(format!("{host}/accounts/api/v2/oauth2/token")).json(&body).send().map_err(|e| format!("Couldn't reach Anypoint: {e}"))?;
  let status = res.status();
  let v: Value = res.json().unwrap_or(json!({}));
  if !status.is_success() {
    let err = v["error"].as_str().unwrap_or("");
    let desc = v["error_description"].as_str().unwrap_or("");
    return Err(match err {
      "invalid_client" => "Anypoint didn't accept the client ID or secret.".to_string(),
      "invalid_grant" => "The sign-in has expired. Sign in again.".to_string(),
      "unauthorized_client" => "This Connected App isn't allowed that kind of sign-in. Check its grant types.".to_string(),
      _ => format!("Anypoint refused the sign-in ({status}{}{}).", if err.is_empty() { "" } else { ": " }, if desc.is_empty() { err } else { desc }),
    });
  }
  Ok(v)
}

// Who is signed in, and the org the Design Center headers name. A client-credentials token answers as the app.
fn fetch_me(host: &str, access: &str, mode: &str) -> Result<Me, String> {
  let res = client().get(format!("{host}/accounts/api/me")).bearer_auth(access).send().map_err(|e| e.to_string())?;
  let status = res.status();
  let v: Value = res.json().unwrap_or(json!({}));
  if !status.is_success() { return Err(format!("Anypoint answered {status} to who-am-I.")); }
  if let Some(u) = v.get("user").filter(|u| u.is_object()) {
    return Ok(Me {
      username: u["username"].as_str().unwrap_or("").into(),
      user_id: u["id"].as_str().unwrap_or("").into(),
      org_id: u["organizationId"].as_str().or(u["organization"]["id"].as_str()).unwrap_or("").into(),
      org_name: u["organization"]["name"].as_str().unwrap_or("").into(),
      host: host.into(), mode: mode.into(),
    });
  }
  let c = &v["client"];
  Ok(Me {
    username: c["name"].as_str().unwrap_or("Connected App").into(),
    user_id: c["client_id"].as_str().unwrap_or("").into(),
    org_id: c["org_id"].as_str().unwrap_or("").into(),
    org_name: String::new(), host: host.into(), mode: mode.into(),
  })
}

fn start_session(app: &AppHandle, conn: Connection, tokens: &Value) -> Result<Me, String> {
  let access = tokens["access_token"].as_str().ok_or("Anypoint sent no access token.")?.to_string();
  let me = fetch_me(&conn.host, &access, &conn.mode)?;
  if let Some(r) = tokens["refresh_token"].as_str() { keychain("refresh-token")?.set_password(r).map_err(|e| e.to_string())?; }
  let secs = tokens["expires_in"].as_u64().unwrap_or(3600);
  let state = app.state::<Arc<Anypoint>>();
  *state.session.lock().unwrap() = Some(Session { conn, access, expires: Instant::now() + Duration::from_secs(secs.saturating_sub(60)), me: me.clone() });
  Ok(me)
}

// A fresh access token: the one in memory, or a new one from the refresh token (browser sign-in) or the
// app's own credentials (client credentials). Also restores the session after a restart.
fn access(app: &AppHandle) -> Result<(String, Me, String), String> {
  let state = app.state::<Arc<Anypoint>>();
  if let Some(s) = state.session.lock().unwrap().as_ref() {
    if Instant::now() < s.expires { return Ok((s.access.clone(), s.me.clone(), s.conn.host.clone())); }
  }
  let conn: Connection = std::fs::read_to_string(conn_file(app)?).ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or("Not signed in to Anypoint.")?;
  let secret = keychain("client-secret")?.get_password().map_err(|_| "The Connected App secret isn't in the keychain any more. Sign in again.")?;
  let tokens = if conn.mode == "client" {
    token_request(&conn.host, json!({ "grant_type": "client_credentials", "client_id": conn.client_id, "client_secret": secret }))?
  } else {
    let refresh = keychain("refresh-token")?.get_password().map_err(|_| "Sign in again to continue.")?;
    token_request(&conn.host, json!({ "grant_type": "refresh_token", "client_id": conn.client_id, "client_secret": secret, "refresh_token": refresh }))?
  };
  start_session(app, conn, &tokens)?;
  let s = state.session.lock().unwrap();
  let s = s.as_ref().unwrap();
  Ok((s.access.clone(), s.me.clone(), s.conn.host.clone()))
}

fn percent_decode(s: &str) -> String {
  let b = s.as_bytes(); let mut out = Vec::with_capacity(b.len()); let mut i = 0;
  while i < b.len() {
    if b[i] == b'%' && i + 2 < b.len() {
      if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) { out.push(v); i += 3; continue; }
    }
    out.push(if b[i] == b'+' { b' ' } else { b[i] }); i += 1;
  }
  String::from_utf8_lossy(&out).into()
}
fn query_param(q: &str, key: &str) -> Option<String> {
  q.split('&').find_map(|kv| { let (k, v) = kv.split_once('=').unwrap_or((kv, "")); (k == key).then(|| percent_decode(v)) })
}

// Browser sign-in: open Anypoint's authorize page and wait on the loopback redirect for the code.
fn browser_sign_in(host: &str, client_id: &str, secret: &str) -> Result<Value, String> {
  let listener = TcpListener::bind("127.0.0.1:8765").map_err(|_| "Port 8765 is in use, so the sign-in can't finish. Close what uses it and try again.".to_string())?;
  let state = random_hex();
  let url = format!("{host}/accounts/api/v2/oauth2/authorize?response_type=code&client_id={client_id}&redirect_uri={}&scope=full%20offline_access&state={state}&nonce={}",
    "http%3A%2F%2Flocalhost%3A8765%2Fcallback", random_hex());
  tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| format!("Couldn't open the browser: {e}"))?;
  // Give up after five minutes: wake the listener with a request of our own.
  let done = Arc::new(AtomicBool::new(false));
  { let done = done.clone(); std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(300)); if !done.load(Ordering::SeqCst) { let _ = std::net::TcpStream::connect("127.0.0.1:8765").map(|mut s| s.write_all(b"GET /timeout HTTP/1.1\r\n\r\n")); } }); }
  let page = |msg: &str| format!("<!doctype html><meta charset=utf-8><title>API Designer Studio</title><body style=\"font:15px system-ui;margin:3em\"><h2>{msg}</h2>");
  for stream in listener.incoming() {
    let Ok(mut stream) = stream else { continue };
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]).to_string();
    let target = req.split_whitespace().nth(1).unwrap_or("/").to_string();
    let reply = |s: &mut std::net::TcpStream, body: String| { let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()); };
    if target.starts_with("/timeout") { return Err("No sign-in within five minutes.".into()); }
    if !target.starts_with("/callback") { reply(&mut stream, String::new()); continue; }
    let q = target.split_once('?').map(|x| x.1).unwrap_or("");
    let (code, error) = (query_param(q, "code"), query_param(q, "error"));
    if code.is_none() && error.is_none() && query_param(q, "fromhash").is_none() {
      // Anypoint returns errors after #, which the browser keeps; this page sends them on.
      reply(&mut stream, page("Finishing the sign-in…") + "<script>fetch(location.pathname+'?fromhash=1&'+location.hash.slice(1)).then(()=>document.querySelector('h2').textContent='You can close this tab.')</script>");
      continue;
    }
    if let Some(err) = error {
      reply(&mut stream, page("The sign-in didn't finish. See API Designer Studio."));
      done.store(true, Ordering::SeqCst);
      let desc = query_param(q, "error_description").unwrap_or_default();
      return Err(if err == "invalid_scope" { "The Connected App needs the Full Access and Background Access scopes.".into() } else { format!("Anypoint said: {err} {desc}") });
    }
    if query_param(q, "state").as_deref() != Some(state.as_str()) { reply(&mut stream, page("This sign-in link is out of date. Start again from the app.")); continue; }
    reply(&mut stream, page("Signed in. You can close this tab and go back to API Designer Studio."));
    done.store(true, Ordering::SeqCst);
    return token_request(host, json!({ "grant_type": "authorization_code", "code": code.unwrap(), "redirect_uri": REDIRECT, "client_id": client_id, "client_secret": secret }));
  }
  Err("The sign-in was interrupted.".into())
}

#[tauri::command]
pub async fn anypoint_connect(app: AppHandle, mode: String, client_id: String, client_secret: String, host: String) -> Result<Me, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let host = host.trim_end_matches('/').to_string();
    let tokens = if mode == "client" {
      token_request(&host, json!({ "grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret }))?
    } else {
      browser_sign_in(&host, &client_id, &client_secret)?
    };
    let conn = Connection { mode, client_id, host };
    let me = start_session(&app, conn.clone(), &tokens)?;
    keychain("client-secret")?.set_password(&client_secret).map_err(|e| e.to_string())?;
    let f = conn_file(&app)?;
    if let Some(d) = f.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::write(f, serde_json::to_string(&conn).unwrap()).map_err(|e| e.to_string())?;
    Ok(me)
  }).await.map_err(|e| e.to_string())?
}

// Signed in? Ok(None) when not connected; Err when connected but the session can't be renewed.
#[tauri::command]
pub async fn anypoint_status(app: AppHandle) -> Result<Option<Me>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    if !conn_file(&app)?.exists() { return Ok(None); }
    access(&app).map(|(_, me, _)| Some(me))
  }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn anypoint_disconnect(app: AppHandle) -> Result<(), String> {
  let _ = anypoint_release_lock(app.clone()).await;
  for k in ["client-secret", "refresh-token"] { if let Ok(e) = keychain(k) { let _ = e.delete_credential(); } }
  let _ = std::fs::remove_file(conn_file(&app)?);
  *app.state::<Arc<Anypoint>>().session.lock().unwrap() = None;
  Ok(())
}

#[derive(Serialize)]
pub struct Reply { status: u16, json: Value, text: String }

fn call(app: &AppHandle, method: &str, path: &str, body: Option<&Value>) -> Result<Reply, String> {
  let ok = path.starts_with("/designcenter/") || path.starts_with("/exchange/") || path == "/accounts/api/me";
  if !ok { return Err(format!("Not an allowed Anypoint path: {path}")); }
  for attempt in 0..2 {
    let (token, me, host) = access(app)?;
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut rq = client().request(m, format!("{host}{path}")).bearer_auth(&token).header("x-organization-id", &me.org_id).header("x-owner-id", &me.user_id).header("accept", "application/json");
    if let Some(b) = body { rq = rq.json(b); }
    let res = rq.send().map_err(|e| format!("Couldn't reach Anypoint: {e}"))?;
    let status = res.status().as_u16();
    if status == 401 && attempt == 0 {
      // The token expired early: drop it and try once more with a fresh one.
      if let Some(s) = app.state::<Arc<Anypoint>>().session.lock().unwrap().as_mut() { s.expires = Instant::now(); }
      continue;
    }
    let text = res.text().unwrap_or_default();
    let json = serde_json::from_str(&text).unwrap_or(Value::Null);
    return Ok(Reply { status, json, text });
  }
  Err("Anypoint keeps refusing the sign-in. Sign in again.".into())
}

// One authorized Anypoint request (Design Center, Exchange, who-am-I), with the org and owner headers.
#[tauri::command]
pub async fn anypoint_api(app: AppHandle, method: String, path: String, body: Option<Value>) -> Result<Reply, String> {
  tauri::async_runtime::spawn_blocking(move || call(&app, &method, &path, body.as_ref())).await.map_err(|e| e.to_string())?
}

// Take the branch's lock and keep it alive (locks lapse after about a minute) until released.
#[tauri::command]
pub async fn anypoint_hold_lock(app: AppHandle, project: String, branch: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let base = format!("/designcenter/api-designer/projects/{project}/branches/{branch}");
    let r = call(&app, "POST", &format!("{base}/acquireLock"), Some(&json!({})))?;
    let me = access(&app)?.1;
    let owner = r.json["name"].as_str().unwrap_or("").to_string();
    if r.status >= 300 || r.json["locked"] == json!(false) || (!owner.is_empty() && owner != me.username) {
      return Err(if owner.is_empty() { format!("Couldn't lock the branch ({}).", r.status) } else { format!("{owner} is editing this branch in Design Center, so it's locked. Try again when they're done.") });
    }
    let stop = Arc::new(AtomicBool::new(false));
    { let (app, stop, base) = (app.clone(), stop.clone(), base.clone());
      std::thread::spawn(move || loop {
        for _ in 0..30 { std::thread::sleep(Duration::from_secs(1)); if stop.load(Ordering::SeqCst) { return; } }
        let _ = call(&app, "POST", &format!("{base}/keepAlive"), Some(&json!({})));
      }); }
    *app.state::<Arc<Anypoint>>().lock.lock().unwrap() = Some(LockHold { project, branch, stop });
    Ok(())
  }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn anypoint_release_lock(app: AppHandle) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let held = app.state::<Arc<Anypoint>>().lock.lock().unwrap().take();
    if let Some(h) = held {
      h.stop.store(true, Ordering::SeqCst);
      call(&app, "POST", &format!("/designcenter/api-designer/projects/{}/branches/{}/releaseLock", h.project, h.branch), Some(&json!({})))?;
    }
    Ok(())
  }).await.map_err(|e| e.to_string())?
}

// On exit, never leave a branch locked.
pub fn release_on_exit(app: &AppHandle) {
  let held = app.try_state::<Arc<Anypoint>>().and_then(|s| s.lock.lock().unwrap().take());
  if let Some(h) = held {
    h.stop.store(true, Ordering::SeqCst);
    let _ = call(app, "POST", &format!("/designcenter/api-designer/projects/{}/branches/{}/releaseLock", h.project, h.branch), Some(&json!({})));
  }
}

// Development only: start a session from a saved refresh token, so tests can run without a browser.
// A release build refuses it.
#[tauri::command]
pub async fn anypoint_dev_session(app: AppHandle, client_id: String, client_secret: String, refresh_token: String, host: String) -> Result<Me, String> {
  if !cfg!(debug_assertions) { return Err("Not available.".into()); }
  tauri::async_runtime::spawn_blocking(move || {
    let tokens = token_request(&host, json!({ "grant_type": "refresh_token", "client_id": client_id, "client_secret": client_secret, "refresh_token": refresh_token }))?;
    let conn = Connection { mode: "code".into(), client_id, host };
    let me = start_session(&app, conn.clone(), &tokens)?;
    keychain("client-secret")?.set_password(&client_secret).map_err(|e| e.to_string())?;
    let f = conn_file(&app)?;
    if let Some(d) = f.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::write(f, serde_json::to_string(&conn).unwrap()).map_err(|e| e.to_string())?;
    Ok(me)
  }).await.map_err(|e| e.to_string())?
}
