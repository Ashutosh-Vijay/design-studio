// The MCP server for AI tools (Claude, Copilot, Cursor): Streamable HTTP on 127.0.0.1, inside the app, as in
// DataWeave Studio. Unlike there, the tools themselves live in the webview (src/mcp.ts): the editor, the form
// splices, sync with Design Center and governance are all webview code, so a tool call is handed to the window
// and its answer comes back through mcp_reply. An AI then does exactly what a person can, through the same code,
// and its edits show in the editor as they happen.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rmcp::model::{CallToolRequestParams, CallToolResult, Content, Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

struct Running {
  shutdown: tokio::sync::oneshot::Sender<()>,
  port: u16,
  started: Instant,
}

#[derive(Default)]
pub struct Mcp {
  running: Mutex<Option<Running>>,
  pending: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<(bool, String)>>>,
  next: AtomicU64,
  requests: Arc<AtomicU64>,
  tools: Mutex<Vec<Value>>, // MCP tool definitions, as the webview gave them
  instructions: Mutex<String>,
}

#[derive(Clone)]
struct Bridge {
  app: AppHandle,
}

impl ServerHandler for Bridge {
  fn get_info(&self) -> ServerInfo {
    let mut info = ServerInfo::default();
    // Overriding get_info means advertising tools ourselves, or clients never ask for them.
    info.capabilities = ServerCapabilities::builder().enable_tools().build();
    let mut me = Implementation::from_build_env();
    me.name = "design-studio".into();
    me.version = self.app.package_info().version.to_string();
    info.server_info = me;
    info.instructions = Some(self.app.state::<Mcp>().instructions.lock().unwrap().clone());
    info
  }

  async fn list_tools(&self, _request: Option<PaginatedRequestParams>, _context: RequestContext<RoleServer>) -> Result<ListToolsResult, ErrorData> {
    let tools = self.app.state::<Mcp>().tools.lock().unwrap().clone();
    serde_json::from_value(json!({ "tools": tools })).map_err(|e| ErrorData::internal_error(e.to_string(), None))
  }

  async fn call_tool(&self, request: CallToolRequestParams, _context: RequestContext<RoleServer>) -> Result<CallToolResult, ErrorData> {
    let mcp = self.app.state::<Mcp>();
    mcp.requests.fetch_add(1, Ordering::Relaxed);
    let id = mcp.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    mcp.pending.lock().unwrap().insert(id, tx);
    let args = Value::Object(request.arguments.unwrap_or_default());
    if self.app.emit_to("main", "mcp-call", json!({ "id": id, "tool": request.name, "args": args })).is_err() {
      mcp.pending.lock().unwrap().remove(&id);
      return Ok(CallToolResult::error(vec![Content::text("Design Studio's window isn't open.")]));
    }
    // Publishing and pulling big projects take a while; ten minutes is the outer limit.
    let (ok, text) = match tokio::time::timeout(Duration::from_secs(600), rx).await {
      Ok(Ok(r)) => r,
      _ => {
        mcp.pending.lock().unwrap().remove(&id);
        (false, "Design Studio didn't answer in time.".to_string())
      }
    };
    Ok(if ok { CallToolResult::success(vec![Content::text(text)]) } else { CallToolResult::error(vec![Content::text(text)]) })
  }
}

// Only this computer, and never a web page: a Host that isn't loopback is DNS rebinding, and browsers put Origin
// on their requests while MCP clients don't (a page on localhost, like a local MCP inspector, is let through).
fn loopback(host: &str) -> bool {
  let name = if host.starts_with('[') { host.split(']').next().map(|h| format!("{}]", h)).unwrap_or_default() } else { host.split(':').next().unwrap_or("").to_string() };
  matches!(name.as_str(), "127.0.0.1" | "localhost" | "[::1]")
}
async fn guard(mut req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
  use axum::response::IntoResponse;
  let (host, origin, accept) = {
    let hd = req.headers();
    let get = |k: &str| hd.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    (get("host"), get("origin"), get("accept"))
  };
  if !loopback(&host) {
    return (axum::http::StatusCode::FORBIDDEN, "Refused: the Host header must be localhost or 127.0.0.1.").into_response();
  }
  if !origin.is_empty() && !loopback(origin.split("://").nth(1).unwrap_or("")) {
    return (axum::http::StatusCode::FORBIDDEN, "Refused: requests from a web page are not accepted.").into_response();
  }
  // rmcp answers 406 unless Accept lists both types; some clients send only one, so it's filled in.
  if !(accept.contains("application/json") && accept.contains("text/event-stream")) {
    req.headers_mut().insert(axum::http::header::ACCEPT, axum::http::HeaderValue::from_static("application/json, text/event-stream"));
  }
  next.run(req).await
}

#[tauri::command]
pub async fn mcp_start(app: AppHandle, port: u16, tools: Vec<Value>, instructions: String) -> Result<(), String> {
  let mcp = app.state::<Mcp>();
  if let Some(r) = mcp.running.lock().unwrap().take() { let _ = r.shutdown.send(()); }
  *mcp.tools.lock().unwrap() = tools;
  *mcp.instructions.lock().unwrap() = instructions;
  let a = app.clone();
  let service = StreamableHttpService::new(move || Ok(Bridge { app: a.clone() }), Arc::new(LocalSessionManager::default()), StreamableHttpServerConfig::default());
  let router = axum::Router::new().nest_service("/mcp", service).layer(axum::middleware::from_fn(guard));
  let listener = tokio::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], port)))
    .await
    .map_err(|e| format!("Couldn't use port {}: {}", port, e))?;
  let (tx, rx) = tokio::sync::oneshot::channel::<()>();
  tauri::async_runtime::spawn(async move {
    let _ = axum::serve(listener, router).with_graceful_shutdown(async move { let _ = rx.await; }).await;
  });
  *mcp.running.lock().unwrap() = Some(Running { shutdown: tx, port, started: Instant::now() });
  Ok(())
}

#[tauri::command]
pub fn mcp_stop(app: AppHandle) {
  if let Some(r) = app.state::<Mcp>().running.lock().unwrap().take() { let _ = r.shutdown.send(()); }
}

#[tauri::command]
pub fn mcp_status(app: AppHandle) -> Value {
  let mcp = app.state::<Mcp>();
  let r = mcp.running.lock().unwrap();
  json!({
    "running": r.is_some(),
    "port": r.as_ref().map(|r| r.port),
    "uptimeSecs": r.as_ref().map(|r| r.started.elapsed().as_secs()).unwrap_or(0),
    "requests": mcp.requests.load(Ordering::Relaxed),
  })
}

// The webview's answer to one tool call.
#[tauri::command]
pub fn mcp_reply(app: AppHandle, id: u64, ok: bool, result: String) {
  if let Some(tx) = app.state::<Mcp>().pending.lock().unwrap().remove(&id) { let _ = tx.send((ok, result)); }
}
