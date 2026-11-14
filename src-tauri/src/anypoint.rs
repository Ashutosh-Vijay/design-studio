// Anypoint sign-in and calls (M3). The app holds no secret of its own: the user's own Connected App
// (BYOK) signs in through the browser (authorization code) or as itself (client credentials). Its secret
// and the refresh token live in the system keychain; the access token only in memory. The broker for
// "Sign in with Anypoint" (our Connected App, secret in Cloudflare) comes later in M3.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const SERVICE: &str = "Design Studio";
// What the user registers as the redirect URI in their Connected App (shown in the sign-in form).
// Where a direct sign-in comes back. Our Connected Apps register all four ports, so one busy port doesn't
// stop a sign-in; a user's own Connected App registers the first.
pub const PORTS: [u16; 4] = [8765, 8766, 8767, 8768];

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Connection {
  mode: String, // "anypoint" (our Connected App, through the broker), "code" (your own, browser sign-in) or "client" (your own, client credentials)
  client_id: String,
  host: String, // https://anypoint.mulesoft.com, or a regional host
  #[serde(default)]
  broker: String, // where "anypoint" mode signs in and refreshes, when it goes through the broker
  // "direct": "anypoint" mode signed in straight with Anypoint, with our public client for the region
  // (clients.json); empty: through the broker.
  #[serde(default)]
  via: String,
  // Read only: every call that could change Design Center or Exchange is refused in call(), before any
  // request is made. Missing in an old file means read only, the safe side.
  #[serde(default = "yes")]
  read_only: bool,
  // The business group picked in the project list (Design Center's org picker); empty is the user's own.
  #[serde(default)]
  org_id: String,
  #[serde(default)]
  org_name: String,
}
fn yes() -> bool { true }

// The sign-in broker holds our Connected App's secret (PLAN 2.1). The same broker answers on Cloudflare's own
// address too, for networks that block ashutosh-vijay.dev; whichever answers is used, and kept for refreshes.
pub const BROKERS: [&str; 2] = ["https://ashutosh-vijay.dev/design-studio/auth", "https://ashutosh-vijay.pages.dev/design-studio/auth"];
const UNREACHABLE: &str = "Couldn't reach the sign-in service";
fn broker_post(broker: &str, action: &str, body: Value) -> Result<Value, String> {
  let res = client().post(format!("{broker}/{action}")).json(&body).send().map_err(|e| format!("{UNREACHABLE}: {e}"))?;
  let status = res.status();
  // A company proxy that blocks the site answers with its own page, not the broker's JSON: that's unreachable too.
  let v: Value = match res.json() { Ok(v) => v, Err(_) if !status.is_success() => return Err(format!("{UNREACHABLE} ({status}).")), Err(_) => json!({}) };
  if status.is_success() { return Ok(v); }
  Err(match v["error"].as_str().unwrap_or("") {
    "not_configured" => "Sign in with Anypoint isn't available yet. Use your own Connected App for now.".into(),
    "region_unavailable" => "Sign in with Anypoint isn't set up for this region yet. Use your own Connected App.".into(),
    "invalid_grant" => "The sign-in has expired. Sign in again.".into(),
    "expired" => "The sign-in took too long. Try again.".into(),
    e => format!("The sign-in service answered {status}{}{e}.", if e.is_empty() { "" } else { ": " }),
  })
}

#[derive(Clone, Serialize)]
pub struct Me {
  username: String,
  user_id: String,
  org_id: String,
  org_name: String,
  host: String,
  mode: String,
  read_only: bool,
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
  lock: Mutex<HashMap<String, LockHold>>, // by window label: each window's project can hold its branch's lock
  // Held while the session is renewed: a refresh token works once (Anypoint rotates it), and a pull makes eight
  // calls at once, so the others wait here and then use the session the first one made.
  renewing: Mutex<()>,
  // Development builds only (anypoint_dev_deny): Anypoint products that answer 403 here as if this account had no
  // permission for them, to test every mix of access without a second account. Release builds never read it.
  deny: Mutex<Vec<String>>,
}

fn keychain(name: &str) -> Result<keyring::Entry, String> {
  keyring::Entry::new(SERVICE, name).map_err(|e| format!("The system keychain isn't available: {e}"))
}
fn conn_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
  Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("anypoint.json"))
}
// One client for every call: its connections stay open, so a pull of forty files makes one TLS handshake, not forty.
// It trusts the system's certificate store (Cargo.toml), so a company proxy that inspects TLS works as it does
// in the browser.
fn client() -> reqwest::blocking::Client {
  static CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();
  CLIENT.get_or_init(|| reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).build().expect("http client")).clone()
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
      host: host.into(), mode: mode.into(), read_only: true,
    });
  }
  let c = &v["client"];
  Ok(Me {
    username: c["name"].as_str().unwrap_or("Connected App").into(),
    user_id: c["client_id"].as_str().unwrap_or("").into(),
    org_id: c["org_id"].as_str().unwrap_or("").into(),
    org_name: String::new(), host: host.into(), mode: mode.into(), read_only: true,
  })
}

fn start_session(app: &AppHandle, conn: Connection, tokens: &Value) -> Result<Me, String> {
  let access = tokens["access_token"].as_str().ok_or("Anypoint sent no access token.")?.to_string();
  let mut me = fetch_me(&conn.host, &access, &conn.mode)?;
  me.read_only = conn.read_only;
  if !conn.org_id.is_empty() { me.org_id = conn.org_id.clone(); me.org_name = conn.org_name.clone(); }
  if let Some(r) = tokens["refresh_token"].as_str() { keychain("refresh-token")?.set_password(r).map_err(|e| e.to_string())?; }
  let secs = tokens["expires_in"].as_u64().unwrap_or(3600);
  let state = app.state::<Arc<Anypoint>>();
  *state.session.lock().unwrap() = Some(Session { conn, access, expires: Instant::now() + Duration::from_secs(secs.saturating_sub(60)), me: me.clone() });
  Ok(me)
}

// A fresh access token: the one in memory, or a new one from the refresh token (browser sign-in) or the
// app's own credentials (client credentials). Also restores the session after a restart.
// Each broker in turn, starting with `first`, until one can be reached (any real answer, even an error,
// counts). Returns the answer and the broker that gave it.
fn broker_any(first: &str, action: &str, body: Value) -> Result<(Value, String), String> {
  let order: Vec<String> = std::iter::once(first.to_string()).chain(BROKERS.iter().map(|b| b.to_string()).filter(|b| b != first)).collect();
  for b in &order {
    match broker_post(b, action, body.clone()) {
      Err(e) if e.starts_with(UNREACHABLE) => continue,
      r => return r.map(|v| (v, b.clone())),
    }
  }
  Err(format!("{UNREACHABLE}. Your network may block it. Use your own Connected App instead: it talks only to Anypoint."))
}

// Our Connected Apps, one per Anypoint cloud: public on purpose (a desktop app can't keep a secret; every
// sign-in also needs PKCE and only comes back to localhost). Read from the design-studio-auth repo, kept as
// the last good copy, with the copy baked in at build time (src-tauri/clients.json) as the last resort.
const CLIENTS_URLS: [&str; 2] = [
  "https://raw.githubusercontent.com/Ashutosh-Vijay/design-studio-auth/main/clients.json",
  "https://cdn.jsdelivr.net/gh/Ashutosh-Vijay/design-studio-auth@main/clients.json",
];
const BAKED_CLIENTS: &str = include_str!("../clients.json");
fn clients(app: &AppHandle, fresh: bool) -> Value {
  let cache = app.path().app_config_dir().ok().map(|d| d.join("clients.json"));
  let cached = || cache.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok());
  if !fresh { if let Some(v) = cached() { return v; } }
  let quick = reqwest::blocking::Client::builder().timeout(Duration::from_secs(5)).build().expect("http client");
  for u in CLIENTS_URLS {
    if let Ok(v) = quick.get(u).send().and_then(|r| r.error_for_status()).and_then(|r| r.json::<Value>()) {
      if v["regions"].is_object() {
        if let Some(f) = &cache { if let Some(d) = f.parent() { let _ = std::fs::create_dir_all(d); } let _ = std::fs::write(f, v.to_string()); }
        return v;
      }
    }
  }
  cached().unwrap_or_else(|| serde_json::from_str(BAKED_CLIENTS).unwrap_or(json!({ "regions": {} })))
}
fn our_client(app: &AppHandle, region: &str, fresh: bool) -> Option<(String, String)> {
  let c = &clients(app, fresh)["regions"][region];
  Some((c["client_id"].as_str()?.to_string(), c["client_secret"].as_str()?.to_string()))
}
fn strong_random(n: usize) -> String {
  use base64::Engine;
  let mut b = vec![0u8; n];
  getrandom::getrandom(&mut b).expect("system random source");
  base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

// The broker's name for an Anypoint cloud, from its host (the broker keeps one Connected App per cloud).
fn region_of(host: &str) -> &'static str {
  for (code, h) in [("eu", "eu1.anypoint"), ("ca", "ca1.platform"), ("gb", "gb1.platform"), ("jp", "jp1.platform"), ("in", "in1.platform"), ("au", "au1.platform")] {
    if host.contains(h) { return code; }
  }
  "us"
}

// Which clouds "Sign in with Anypoint" works in: the ones the broker has a Connected App for.
#[tauri::command]
pub async fn anypoint_broker_regions(app: AppHandle) -> Result<Vec<String>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let mut out: Vec<String> = clients(&app, true)["regions"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    let quick = reqwest::blocking::Client::builder().timeout(Duration::from_secs(5)).build().expect("http client");
    for b in BROKERS {
      if let Ok(v) = quick.get(format!("{b}/regions")).send().and_then(|r| r.json::<Value>()) {
        for r in v["regions"].as_array().into_iter().flatten().filter_map(|x| x.as_str()) { if !out.iter().any(|o| o == r) { out.push(r.into()); } }
        break;
      }
    }
    if out.is_empty() { out.push("us".into()); }
    Ok(out)
  }).await.map_err(|e| e.to_string())?
}

fn access(app: &AppHandle) -> Result<(String, Me, String), String> {
  let state = app.state::<Arc<Anypoint>>();
  if let Some(s) = state.session.lock().unwrap().as_ref() {
    if Instant::now() < s.expires { return Ok((s.access.clone(), s.me.clone(), s.conn.host.clone())); }
  }
  let _renewing = state.renewing.lock().unwrap_or_else(|e| e.into_inner());
  // Renewed by another call while this one waited.
  if let Some(s) = state.session.lock().unwrap().as_ref() {
    if Instant::now() < s.expires { return Ok((s.access.clone(), s.me.clone(), s.conn.host.clone())); }
  }
  let conn: Connection = std::fs::read_to_string(conn_file(app)?).ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or("Not signed in to Anypoint.")?;
  let tokens = if conn.mode == "anypoint" && conn.via == "direct" {
    let refresh = keychain("refresh-token")?.get_password().map_err(|_| "Sign in again to continue.")?;
    let region = region_of(&conn.host);
    let go = |fresh: bool| -> Result<Value, String> {
      let (id, secret) = our_client(app, region, fresh).ok_or("Sign in again to continue.")?;
      token_request(&conn.host, json!({ "grant_type": "refresh_token", "client_id": id, "client_secret": secret, "refresh_token": refresh }))
    };
    // A rotated client shows up as invalid_client: read the current one and try once more.
    match go(false) { Err(e) if e.contains("client ID or secret") => go(true)?, r => r? }
  } else if conn.mode == "anypoint" {
    let refresh = keychain("refresh-token")?.get_password().map_err(|_| "Sign in again to continue.")?;
    broker_any(&conn.broker, "refresh", json!({ "refresh_token": refresh, "region": region_of(&conn.host) }))?.0
  } else if conn.mode == "client" {
    let secret = keychain("client-secret")?.get_password().map_err(|_| "The Connected App secret isn't in the keychain any more. Sign in again.")?;
    token_request(&conn.host, json!({ "grant_type": "client_credentials", "client_id": conn.client_id, "client_secret": secret }))?
  } else {
    let secret = keychain("client-secret")?.get_password().map_err(|_| "The Connected App secret isn't in the keychain any more. Sign in again.")?;
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

// The page the browser shows when a sign-in ends (or is finishing): the app's colours, light or dark as the system is.
fn signin_page(kind: &str, title: &str, msg: &str) -> String {
  let icon = match kind { "ok" => "<svg width=22 height=22 viewBox=\"0 0 24 24\" fill=none stroke=currentColor stroke-width=2.4 stroke-linecap=round stroke-linejoin=round><path d=\"M5 12.5l4.5 4.5L19 7.5\"/></svg>", "err" => "<svg width=20 height=20 viewBox=\"0 0 24 24\" fill=none stroke=currentColor stroke-width=2.4 stroke-linecap=round><path d=\"M6 6l12 12M18 6L6 18\"/></svg>", _ => "<span class=dots><i></i><i></i><i></i></span>" };
  "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>{title} - Design Studio</title><style>:root{color-scheme:light dark;--bg:oklch(98% .003 80);--card:#fff;--line:oklch(90% .004 80);--text:oklch(20% 0 0);--muted:oklch(44% 0 0);--ok:oklch(52% .14 155);--err:oklch(55% .18 20);--busy:oklch(55% .15 158)}@media(prefers-color-scheme:dark){:root{--bg:oklch(14% .004 80);--card:oklch(17% .004 80);--line:oklch(26% .004 80);--text:oklch(96% 0 0);--muted:oklch(72% 0 0);--ok:oklch(76% .15 155);--err:oklch(68% .18 20);--busy:oklch(72% .15 158)}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,\"Segoe UI\",sans-serif}main{width:100%;max-width:380px;padding:36px 28px 28px;text-align:center;background:var(--card);border:1px solid var(--line);border-radius:14px}.mark{width:48px;height:48px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;color:var(--c);background:color-mix(in oklch,var(--c) 15%,transparent)}h1{margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:-.01em}p{margin:0;color:var(--muted)}footer{margin-top:26px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}.dots{display:flex;gap:5px}.dots i{width:6px;height:6px;border-radius:50%;background:currentColor;animation:b 1s infinite alternate}.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}@keyframes b{from{opacity:.25}to{opacity:1}}@media(prefers-reduced-motion:reduce){.dots i{animation:none}}</style><main style=\"--c:var(--{kind})\"><div class=mark>{icon}</div><h1>{title}</h1><p>{msg}</p><footer>Design Studio for MuleSoft</footer></main>".replace("{kind}", kind).replace("{icon}", icon).replace("{title}", title).replace("{msg}", msg)
}

// Browser sign-in: open Anypoint's authorize page and wait on the loopback redirect for the code.
fn browser_sign_in(host: &str, client_id: &str, secret: &str, ports: &[u16]) -> Result<Value, String> {
  let (listener, port) = ports.iter().find_map(|p| TcpListener::bind(("127.0.0.1", *p)).ok().map(|l| (l, *p)))
    .ok_or_else(|| format!("Port {} is in use, so the sign-in can't finish. Close what uses it and try again.", ports.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", ")))?;
  let redirect = format!("http://localhost:{port}/callback");
  use sha2::Digest;
  use base64::Engine;
  let state = strong_random(16);
  // PKCE: only this run of the app knows the verifier, so a sign-in code is useless to anyone else.
  let verifier = strong_random(48);
  let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
  let url = format!("{host}/accounts/api/v2/oauth2/authorize?response_type=code&client_id={client_id}&redirect_uri={}&scope=full%20offline_access&state={state}&nonce={}&code_challenge={challenge}&code_challenge_method=S256",
    format!("http%3A%2F%2Flocalhost%3A{port}%2Fcallback"), strong_random(12));
  tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| format!("Couldn't open the browser: {e}"))?;
  // Give up after five minutes: wake the listener with a request of our own.
  let done = Arc::new(AtomicBool::new(false));
  { let done = done.clone(); std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(300)); if !done.load(Ordering::SeqCst) { let _ = std::net::TcpStream::connect(("127.0.0.1", port)).map(|mut s| s.write_all(b"GET /timeout HTTP/1.1\r\n\r\n")); } }); }
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
      reply(&mut stream, signin_page("busy", "Finishing the sign-in", "One moment.") + "<script>fetch(location.pathname+'?fromhash=1&'+location.hash.slice(1)).then(r=>r.text()).then(h=>{document.open();document.write(h);document.close()})</script>");
      continue;
    }
    if let Some(err) = error {
      reply(&mut stream, signin_page("err", "The sign-in didn't finish", "Go back to Design Studio to see why and try again."));
      done.store(true, Ordering::SeqCst);
      let desc = query_param(q, "error_description").unwrap_or_default();
      return Err(if err == "invalid_scope" { "The Connected App needs the Full Access and Background Access scopes.".into() } else { format!("Anypoint said: {err} {desc}") });
    }
    if query_param(q, "state").as_deref() != Some(state.as_str()) { reply(&mut stream, signin_page("err", "This sign-in link is out of date", "Start the sign-in again from Design Studio.")); continue; }
    reply(&mut stream, signin_page("ok", "You're signed in", "Design Studio is connected to Anypoint. You can close this tab."));
    done.store(true, Ordering::SeqCst);
    return token_request(host, json!({ "grant_type": "authorization_code", "code": code.unwrap(), "redirect_uri": redirect, "client_id": client_id, "client_secret": secret, "code_verifier": verifier }));
  }
  Err("The sign-in was interrupted.".into())
}

// Sign in with Anypoint: the broker gives the login link, Anypoint sends the browser back through the
// broker to http://127.0.0.1:{port}/done with a sealed ticket, and only this app (it holds the verifier
// whose hash started it) can turn the ticket into tokens.
fn broker_sign_in(first: &str, region: &str) -> Result<(Value, String), String> {
  use base64::Engine;
  use sha2::Digest;
  let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Couldn't open a local port for the sign-in: {e}"))?;
  let port = listener.local_addr().map_err(|e| e.to_string())?.port();
  let verifier = strong_random(48);
  let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
  let (start, broker) = broker_any(first, "start", json!({ "challenge": challenge, "port": port, "region": region }))?;
  let broker = broker.as_str();
  let url = start["url"].as_str().ok_or("The sign-in service sent no link.")?;
  tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| format!("Couldn't open the browser: {e}"))?;
  let done = Arc::new(AtomicBool::new(false));
  { let done = done.clone(); std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(300)); if !done.load(Ordering::SeqCst) { let _ = std::net::TcpStream::connect(("127.0.0.1", port)).map(|mut s| s.write_all(b"GET /timeout HTTP/1.1\r\n\r\n")); } }); }
  for stream in listener.incoming() {
    let Ok(mut stream) = stream else { continue };
    let mut buf = [0u8; 16384];
    let n = stream.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]).to_string();
    let target = req.split_whitespace().nth(1).unwrap_or("/").to_string();
    let reply = |s: &mut std::net::TcpStream, body: String| { let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()); };
    if target.starts_with("/timeout") { return Err("No sign-in within five minutes.".into()); }
    if !target.starts_with("/done") { reply(&mut stream, String::new()); continue; }
    let q = target.split_once('?').map(|x| x.1).unwrap_or("");
    done.store(true, Ordering::SeqCst);
    if let Some(err) = query_param(q, "error") {
      reply(&mut stream, signin_page("err", "The sign-in didn't finish", "Go back to Design Studio to see why and try again."));
      return Err(if err == "access_denied" { "The sign-in was cancelled.".into() } else { format!("Anypoint said: {err} {}", query_param(q, "error_description").unwrap_or_default()) });
    }
    let ticket = query_param(q, "ticket").ok_or("The sign-in came back without a ticket.")?;
    let tokens = broker_post(broker, "collect", json!({ "ticket": ticket, "verifier": verifier }));
    reply(&mut stream, if tokens.is_ok() { signin_page("ok", "You're signed in", "Design Studio is connected to Anypoint. You can close this tab.") } else { signin_page("err", "The sign-in didn't finish", "Go back to Design Studio to see why and try again.") });
    return tokens.map(|t| (t, broker.to_string()));
  }
  Err("The sign-in was interrupted.".into())
}

#[tauri::command]
pub async fn anypoint_connect(app: AppHandle, window: tauri::Window, mode: String, client_id: String, client_secret: String, host: String, broker: Option<String>, read_only: Option<bool>) -> Result<Me, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let host = host.trim_end_matches('/').to_string();
    // A different broker only in development, for testing against a local one.
    let mut broker = broker.filter(|_| cfg!(debug_assertions)).unwrap_or_else(|| BROKERS[0].to_string());
    let mut via = String::new();
    // A broker passed in (development tests) means the broker path, so local stand-ins can test it.
    let direct = if mode == "anypoint" && broker == BROKERS[0] { our_client(&app, region_of(&host), true) } else { None };
    let tokens = if let Some((id, secret)) = direct {
      via = "direct".into();
      browser_sign_in(&host, &id, &secret, &PORTS)?
    } else if mode == "anypoint" {
      let (t, b) = broker_sign_in(&broker, region_of(&host))?;
      broker = b;
      t
    } else if mode == "client" {
      token_request(&host, json!({ "grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret }))?
    } else {
      browser_sign_in(&host, &client_id, &client_secret, &PORTS[..1])?
    };
    let conn = Connection { broker: if mode == "anypoint" && via.is_empty() { broker } else { String::new() }, via, mode, client_id, host, read_only: read_only.unwrap_or(true), ..Default::default() };
    let me = start_session(&app, conn.clone(), &tokens)?;
    if conn.mode != "anypoint" { keychain("client-secret")?.set_password(&client_secret).map_err(|e| e.to_string())?; }
    let f = conn_file(&app)?;
    if let Some(d) = f.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::write(f, serde_json::to_string(&conn).unwrap()).map_err(|e| e.to_string())?;
    // Back from the browser: the window that asked comes to the front (the OS may only flash it in the taskbar).
    let _ = window.unminimize(); let _ = window.set_focus();
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
  // Signing out lets go of every window's lock while the session can still say so.
  { let app = app.clone(); let _ = tauri::async_runtime::spawn_blocking(move || release_on_exit(&app, None)).await; }
  for k in ["client-secret", "refresh-token"] { if let Ok(e) = keychain(k) { let _ = e.delete_credential(); } }
  let _ = std::fs::remove_file(conn_file(&app)?);
  *app.state::<Arc<Anypoint>>().session.lock().unwrap() = None;
  Ok(())
}

// Work in another business group (the project list's picker): the Design Center headers name it from now on.
#[tauri::command]
pub async fn anypoint_set_org(app: AppHandle, org_id: String, org_name: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let f = conn_file(&app)?;
    let mut conn: Connection = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or("Not signed in to Anypoint.")?;
    conn.org_id = org_id.clone(); conn.org_name = org_name.clone();
    std::fs::write(&f, serde_json::to_string(&conn).unwrap()).map_err(|e| e.to_string())?;
    if let Some(s) = app.state::<Arc<Anypoint>>().session.lock().unwrap().as_mut() { s.conn.org_id = org_id.clone(); s.conn.org_name = org_name.clone(); s.me.org_id = org_id; s.me.org_name = org_name; }
    Ok(())
  }).await.map_err(|e| e.to_string())?
}

// Turn read only on or off for the current connection (Settings). Kept with the connection.
#[tauri::command]
pub async fn anypoint_set_read_only(app: AppHandle, on: bool) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let f = conn_file(&app)?;
    let mut conn: Connection = std::fs::read_to_string(&f).ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or("Not signed in to Anypoint.")?;
    conn.read_only = on;
    std::fs::write(&f, serde_json::to_string(&conn).unwrap()).map_err(|e| e.to_string())?;
    if let Some(s) = app.state::<Arc<Anypoint>>().session.lock().unwrap().as_mut() { s.conn.read_only = on; s.me.read_only = on; }
    Ok(())
  }).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Reply { status: u16, json: Value, text: String }

// What a read-only connection may do: read (GET), and Design Center's status call, which only reports the
// lock and the branch's position. Everything else (save, delete, move, lock, publish, new branch) is a write.
fn is_read(method: &str, path: &str) -> bool {
  method == "GET" || (method == "POST" && path.starts_with("/designcenter/") && path.ends_with("/status"))
    // Exchange's Graph API takes its queries as POST; call_in refuses a mutation there before this is asked.
    || (method == "POST" && path == GRAPH)
}
const GRAPH: &str = "/graph/api/v2/graphql";

const DASHBOARD: [&str; 8] = ["/governance/xapi/", "/apigovernance/", "/apimanager/", "/accounts/api/organizations/", "/hybrid/", "/cloudhub/", "/amc/", "/armui/"];

// Which product a path belongs to, for anypoint_dev_deny. "-write" in a rule denies only what isn't a read.
fn denied(rules: &[String], method: &str, path: &str) -> Option<String> {
  let product = if path.contains("/publish/exchange") { "publish" }
    else if path.starts_with("/designcenter/") { "designcenter" }
    else if path.starts_with("/exchange/") || path == GRAPH { "exchange" }
    else if path.starts_with("/governance/xapi/") || path.contains("/entitlements/apiGovernance") { "governance" }
    else if path.starts_with("/apimanager/") { "apimanager" }
    else if ["/amc/", "/cloudhub/", "/hybrid/", "/armui/"].iter().any(|p| path.starts_with(p)) { "runtime" }
    else if path.starts_with("/accounts/api/organizations/") && path.contains("/environments") { "environments" }
    else { return None };
  let write = !is_read(method, path);
  // Publishing also takes the lock and writes in Design Center first: those stay allowed under "publish".
  rules.iter().find(|r| *r == product || (write && **r == format!("{product}-write")) || (product == "publish" && (*r == "designcenter" || *r == "designcenter-write"))).cloned()
}

fn call(app: &AppHandle, method: &str, path: &str, body: Option<&Value>) -> Result<Reply, String> { call_in(app, method, path, body, None, None) }
// org and env: Runtime Manager's calls name the business group and the environment in headers, not in the path.
fn call_in(app: &AppHandle, method: &str, path: &str, body: Option<&Value>, org: Option<&str>, env: Option<&str>) -> Result<Reply, String> {
  if cfg!(debug_assertions) {
    if let Some(rule) = denied(&app.state::<Arc<Anypoint>>().deny.lock().unwrap(), method, path) {
      // As Anypoint answers an account without the permission: Exchange's search and Graph API give an empty
      // list, the environments list comes back empty, everything else is a 403.
      let (status, json) = if rule.starts_with("exchange") && (path.starts_with("/exchange/api/v2/assets/search") || path == GRAPH) {
        (200, if path == GRAPH { json!({ "data": { "assets": [] } }) } else { json!([]) })
      } else if rule == "environments" { (200, json!({ "data": [], "total": 0 })) }
      else { (403, json!({ "message": format!("Forbidden (simulated in a development build: {rule})"), "status": 403 })) };
      return Ok(Reply { status, text: json.to_string(), json });
    }
  }
  // The Dashboard's calls (PLAN 6.2): governance, API Manager, the org's environments and its runtimes. Read only,
  // always: only GET goes out to these, whatever the connection's own read-only setting says.
  let dashboard = DASHBOARD.iter().any(|p| path.starts_with(p));
  if dashboard && method != "GET" { return Err(format!("The Dashboard only reads: {method} {path} was not sent.")); }
  // Exchange's Graph API: queries only, never a mutation.
  if path == GRAPH {
    let q = body.and_then(|b| b["query"].as_str()).unwrap_or("").to_lowercase();
    if method != "POST" || q.is_empty() || q.contains("mutation") || q.contains("subscription") { return Err("Only read queries go to Exchange's Graph API.".into()); }
  }
  let ok = dashboard || path == GRAPH || path.starts_with("/designcenter/") || path.starts_with("/exchange/") || path == "/accounts/api/me";
  if !ok { return Err(format!("Not an allowed Anypoint path: {path}")); }
  for attempt in 0..2 {
    let (token, me, host) = access(app)?;
    if me.read_only && !is_read(method, path) {
      return Err("This connection is read only, so nothing that would change Design Center was sent. Turn read only off in settings to push.".into());
    }
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut rq = client().request(m, format!("{host}{path}")).bearer_auth(&token).header("x-organization-id", org.unwrap_or(&me.org_id)).header("accept", "application/json");
    // A Connected App acting as itself (client credentials) has no user: Design Center answers "Invalid x-owner-id
    // header" to its client ID there, and works without the header (proven 2026-11-15).
    if me.mode != "client" { rq = rq.header("x-owner-id", &me.user_id); }
    if let Some(e) = env { rq = rq.header("X-ANYPNT-ENV-ID", e).header("X-ANYPNT-ORG-ID", org.unwrap_or(&me.org_id)); }
    if let Some(b) = body { rq = rq.json(b); }
    let res = rq.send().map_err(|e| format!("Couldn't reach Anypoint: {e}"))?;
    let status = res.status().as_u16();
    if status == 401 && attempt == 0 {
      // The token expired early: drop it and try once more with a fresh one.
      if let Some(s) = app.state::<Arc<Anypoint>>().session.lock().unwrap().as_mut() { s.expires = Instant::now(); }
      continue;
    }
    // A file that isn't text (an image in the project) comes back as the marker and base64, never decoded lossily.
    let text = crate::text_or_b64(res.bytes().map(|b| b.to_vec()).unwrap_or_default());
    let json = serde_json::from_str(&text).unwrap_or(Value::Null);
    return Ok(Reply { status, json, text });
  }
  Err("Anypoint keeps refusing the sign-in. Sign in again.".into())
}

// One authorized Anypoint request (Design Center, Exchange, who-am-I), with the org and owner headers.
#[tauri::command]
pub async fn anypoint_api(app: AppHandle, method: String, path: String, body: Option<Value>, org: Option<String>, env: Option<String>) -> Result<Reply, String> {
  tauri::async_runtime::spawn_blocking(move || call_in(&app, &method, &path, body.as_ref(), org.as_deref(), env.as_deref())).await.map_err(|e| e.to_string())?
}

// Development only: products to answer 403 (designcenter, designcenter-write, publish, exchange, exchange-write,
// governance, apimanager, runtime, environments). An empty list turns it off. A release build refuses it.
#[tauri::command]
pub fn anypoint_dev_deny(app: AppHandle, products: Vec<String>) -> Result<(), String> {
  if !cfg!(debug_assertions) { return Err("Only in development builds.".into()); }
  *app.state::<Arc<Anypoint>>().deny.lock().unwrap() = products;
  Ok(())
}

// An Exchange dependency into exchange_modules/{group}/{asset}/{version}/, where Design Center's own
// zips put it. The asset's fragment zip comes from a signed download link, so that request has no token.
// With published: a version of this project as Exchange has it, with its dependencies (the "fat" zip),
// into .apidesigner/published/{version}/, for the Exchange panel's "what changed".
#[tauri::command]
pub async fn anypoint_fetch_dependency(app: AppHandle, root: String, group: String, asset: String, version: String, published: Option<bool>, into: Option<String>) -> Result<usize, String> {
  let published = published.unwrap_or(false);
  tauri::async_runtime::spawn_blocking(move || {
    // These become folder names: nothing that could climb out of exchange_modules.
    let safe = |s: &str| !s.is_empty() && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if !(safe(&group) && safe(&asset) && safe(&version)) { return Err(format!("{group}/{asset}/{version} isn't a dependency name this app can store.")); }
    let r = call(&app, "GET", &format!("/exchange/api/v2/assets/{group}/{asset}/{version}"), None)?;
    if r.status == 404 || r.status == 403 { return Err(format!("{asset} {version} isn't in Exchange, or this account can't see it.")); }
    if r.status >= 300 { return Err(format!("Exchange answered {} for {asset} {version}.", r.status)); }
    // The fragment's own files: not the "fat" zip (which nests its dependencies) and not the original upload.
    let files = r.json["files"].as_array().cloned().unwrap_or_default();
    let class = |f: &Value| f["classifier"].as_str().unwrap_or("").to_string();
    let format = r.json["originalFormat"].as_str().unwrap_or("raml").to_string();
    let fat = format!("fat-{format}");
    let zip = files.iter().find(|f| published && f["packaging"] == "zip" && class(f) == fat)
      .or_else(|| files.iter().find(|f| published && f["packaging"] == "zip" && class(f) == format))
      // The zip named after the asset's own type: raml-fragment for a fragment, ruleset for a ruleset (not its docs).
      .or_else(|| files.iter().find(|f| f["packaging"] == "zip" && r.json["type"].as_str().is_some_and(|t| class(f) == t)))
      .or_else(|| files.iter().find(|f| f["packaging"] == "zip" && !class(f).starts_with("fat-") && !class(f).starts_with("original-") && !class(f).is_empty()))
      .or_else(|| files.iter().find(|f| f["packaging"] == "zip"))
      .ok_or(format!("{asset} {version} has no files to download in Exchange."))?;
    let link = zip["externalLink"].as_str().ok_or("Exchange gave no download link.")?;
    let bytes = client().get(link).send().and_then(|r| r.error_for_status()).and_then(|r| r.bytes()).map_err(|e| format!("Couldn't download {asset} {version}: {e}"))?;
    // into: Import from Exchange, the asset's files into a folder of the project (checked like any path).
    let into = into.filter(|x| !x.is_empty());
    if let Some(x) = &into { if x.contains("..") || x.starts_with('/') || x.contains(':') { return Err(format!("{x} isn't a folder name this app can use.")); } }
    let dest = if let Some(x) = &into { std::path::PathBuf::from(&root).join(x) } else if published { std::path::PathBuf::from(&root).join(".apidesigner").join("published").join(&version) }
      else { std::path::PathBuf::from(&root).join("exchange_modules").join(&group).join(&asset).join(&version) };
    if dest.exists() { std::fs::remove_dir_all(&dest).map_err(|e| e.to_string())?; }
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    crate::unzip_into(std::io::Cursor::new(bytes), &dest).map(|(n, _)| n)
  }).await.map_err(|e| e.to_string())?
}

// Take the branch's lock and keep it alive (locks lapse after about a minute) until released.
#[tauri::command]
pub async fn anypoint_hold_lock(app: AppHandle, window: tauri::Window, project: String, branch: String) -> Result<(), String> {
  let win = window.label().to_string();
  // Encoded once, as sync.ts does for its calls: a branch can have / or spaces in its name.
  let branch: String = branch.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{:02X}", b) }).collect();
  tauri::async_runtime::spawn_blocking(move || {
    // Already held (Lock while I edit, then Push): nothing to do. Held on another branch: let that one go first.
    let held = app.state::<Arc<Anypoint>>().lock.lock().unwrap().remove(&win);
    if let Some(h) = held {
      if h.project == project && h.branch == branch { app.state::<Arc<Anypoint>>().lock.lock().unwrap().insert(win, h); return Ok(()); }
      h.stop.store(true, Ordering::SeqCst);
      let _ = call(&app, "POST", &format!("/designcenter/api-designer/projects/{}/branches/{}/releaseLock", h.project, h.branch), Some(&json!({})));
    }
    let base = format!("/designcenter/api-designer/projects/{project}/branches/{branch}");
    let r = call(&app, "POST", &format!("{base}/acquireLock"), Some(&json!({})))?;
    let me = access(&app)?.1;
    let owner = r.json["name"].as_str().unwrap_or("").to_string();
    if r.status >= 300 || r.json["locked"] == json!(false) || (!owner.is_empty() && owner != me.username) {
      return Err(if owner.is_empty() { format!("Couldn't lock the branch ({}).", r.status) } else { format!("{owner} is editing this branch in Design Center, so it's locked. Try again when they're done.") });
    }
    let stop = Arc::new(AtomicBool::new(false));
    { let (app, stop, base, win) = (app.clone(), stop.clone(), base.clone(), win.clone());
      std::thread::spawn(move || {
        let mut missed = 0;
        loop {
          for _ in 0..30 { std::thread::sleep(Duration::from_secs(1)); if stop.load(Ordering::SeqCst) { return; } }
          let kept = call(&app, "POST", &format!("{base}/keepAlive"), Some(&json!({}))).map(|r| r.status < 300).unwrap_or(false);
          missed = if kept { 0 } else { missed + 1 };
          // Two in a row (a minute): the lock has lapsed in Design Center. Stop pretending, and tell the window.
          if missed >= 2 {
            if stop.load(Ordering::SeqCst) { return; }
            app.state::<Arc<Anypoint>>().lock.lock().unwrap().remove(&win);
            let _ = tauri::Emitter::emit_to(&app, &win, "lock-lost", json!({ "win": win }));
            return;
          }
        }
      }); }
    app.state::<Arc<Anypoint>>().lock.lock().unwrap().insert(win, LockHold { project, branch, stop });
    Ok(())
  }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn anypoint_release_lock(app: AppHandle, window: tauri::Window) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let held = app.state::<Arc<Anypoint>>().lock.lock().unwrap().remove(window.label());
    if let Some(h) = held {
      h.stop.store(true, Ordering::SeqCst);
      call(&app, "POST", &format!("/designcenter/api-designer/projects/{}/branches/{}/releaseLock", h.project, h.branch), Some(&json!({})))?;
    }
    Ok(())
  }).await.map_err(|e| e.to_string())?
}

// On exit (None) or as a window closes (its label), never leave a branch locked.
pub fn release_on_exit(app: &AppHandle, label: Option<&str>) {
  let held: Vec<LockHold> = app.try_state::<Arc<Anypoint>>().map(|s| { let mut m = s.lock.lock().unwrap(); match label { Some(l) => m.remove(l).into_iter().collect(), None => m.drain().map(|(_, v)| v).collect() } }).unwrap_or_default();
  for h in held {
    h.stop.store(true, Ordering::SeqCst);
    // At most a few seconds: closing mustn't hang on a slow network (the lock expires by itself in a minute anyway).
    let (tx, rx) = std::sync::mpsc::channel();
    let app = app.clone();
    std::thread::spawn(move || {
      let _ = call(&app, "POST", &format!("/designcenter/api-designer/projects/{}/branches/{}/releaseLock", h.project, h.branch), Some(&json!({})));
      let _ = tx.send(());
    });
    let _ = rx.recv_timeout(Duration::from_secs(4));
  }
}

// Development only: start a session from a saved refresh token, so tests can run without a browser.
// A release build refuses it.
#[tauri::command]
pub async fn anypoint_dev_session(app: AppHandle, client_id: String, client_secret: String, refresh_token: String, host: String) -> Result<Me, String> {
  if !cfg!(debug_assertions) { return Err("Not available.".into()); }
  tauri::async_runtime::spawn_blocking(move || {
    let tokens = token_request(&host, json!({ "grant_type": "refresh_token", "client_id": client_id, "client_secret": client_secret, "refresh_token": refresh_token }))?;
    let conn = Connection { mode: "code".into(), client_id, host, broker: String::new(), read_only: false, ..Default::default() };
    let me = start_session(&app, conn.clone(), &tokens)?;
    keychain("client-secret")?.set_password(&client_secret).map_err(|e| e.to_string())?;
    let f = conn_file(&app)?;
    if let Some(d) = f.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    std::fs::write(f, serde_json::to_string(&conn).unwrap()).map_err(|e| e.to_string())?;
    Ok(me)
  }).await.map_err(|e| e.to_string())?
}
