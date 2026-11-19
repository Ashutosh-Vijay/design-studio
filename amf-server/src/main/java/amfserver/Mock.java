package amfserver;

import amf.apicontract.client.platform.APIConfiguration;
import amf.apicontract.client.platform.AMFConfiguration;
import amf.core.client.common.transform.PipelineId;
import amf.core.client.common.validation.ValidationMode;
import amf.core.client.platform.AMFParseResult;
import amf.core.client.platform.model.document.BaseUnit;
import amf.core.client.platform.model.domain.Shape;
import amf.shapes.client.platform.model.domain.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// The local mock (M5): answers every method of the open spec, unsaved edits included, with its examples or
// with values made from the types. Design Center's behavioural headers work the same (MS2-Delay,
// MS2-Example, MS2-Status-Code, MS2-Error-Rate, MS2-Randomize), so tests written against its mock run here.
// Requests are checked against the spec: a bad body or a missing required parameter gets a 400.
class Mock {
  static HttpServer server;
  static volatile boolean stale = true;
  static amf.apicontract.client.platform.model.domain.api.Api<?> api;
  static BaseUnit resolvedUnit;
  static AMFConfiguration config;
  static String basePath = "";
  static final Random RANDOM = new Random();

  static ObjectNode start(int port) throws IOException {
    if (server == null) {
      server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
      server.createContext("/", Mock::handle);
      server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(4));
      server.start();
    }
    stale = true;
    return Main.JSON.createObjectNode().put("port", server.getAddress().getPort());
  }
  static void stop() { if (server != null) { server.stop(0); server = null; } api = null; }

  // The spec as AMF resolves it (traits, resource types and inheritance applied), re-read after any change.
  static synchronized void load() throws Exception {
    if (!stale && api != null) return;
    AMFParseResult parsed = APIConfiguration.API().withResourceLoaders(Main.loaders()).baseUnitClient().parse(Main.fileUrl(Main.root.resolve(Main.main))).get();
    config = APIConfiguration.fromSpec(parsed.sourceSpec()).withResourceLoaders(Main.loaders());
    BaseUnit resolved = config.baseUnitClient().transform(parsed.baseUnit(), PipelineId.Default()).baseUnit();
    if (!(resolved instanceof amf.core.client.platform.model.document.Document d) || !(d.encodes() instanceof amf.apicontract.client.platform.model.domain.api.Api<?> a))
      throw new IllegalStateException("The root file isn't an API, so there's nothing to mock.");
    api = a; resolvedUnit = resolved;
    // The base URI's path (with {version} filled in) may come first in a request.
    basePath = "";
    if (!a.servers().isEmpty() && !a.servers().get(0).url().isNullOrEmpty()) {
      String u = a.servers().get(0).url().value().replace("{version}", a.version().isNullOrEmpty() ? "" : a.version().value());
      Matcher m = Pattern.compile("^[a-zA-Z]+://[^/]+(/.*)?$").matcher(u);
      basePath = m.matches() && m.group(1) != null ? m.group(1).replaceAll("/+$", "") : u.startsWith("/") ? u.replaceAll("/+$", "") : "";
    }
    stale = false;
  }

  static void handle(HttpExchange x) throws IOException {
    try {
      x.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
      x.getResponseHeaders().add("Access-Control-Allow-Headers", "*");
      x.getResponseHeaders().add("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
      x.getResponseHeaders().add("Access-Control-Expose-Headers", "*");
      if (x.getRequestMethod().equals("OPTIONS")) { x.sendResponseHeaders(204, -1); return; }
      try { load(); } catch (Exception e) { send(x, 500, err("The spec couldn't be read: " + e.getMessage())); return; }
      String delay = header(x, "MS2-Delay");
      if (delay != null) {
        String[] r = delay.split("-");
        long a = Long.parseLong(r[0].trim()), b = r.length > 1 ? Long.parseLong(r[1].trim()) : a;
        Thread.sleep(Math.min(10000, a + (b > a ? (long) (RANDOM.nextDouble() * (b - a)) : 0)));
      }
      String path = x.getRequestURI().getRawPath();
      if (!basePath.isEmpty() && path.startsWith(basePath)) path = path.substring(basePath.length());
      if (path.isEmpty()) path = "/";
      // The endpoint: an exact path beats one with parameters, and fewer parameters win.
      amf.apicontract.client.platform.model.domain.EndPoint ep = null; int best = Integer.MAX_VALUE; Map<String, String> uriParams = Map.of();
      for (var e : api.endPoints()) {
        String tpl = e.path().value();
        List<String> names = new ArrayList<>();
        Matcher pm = Pattern.compile("\\{([^}]+)\\}").matcher(tpl);
        StringBuilder re = new StringBuilder(); int last = 0;
        while (pm.find()) { re.append(Pattern.quote(tpl.substring(last, pm.start()))).append("([^/]+)"); names.add(pm.group(1)); last = pm.end(); }
        re.append(Pattern.quote(tpl.substring(last))).append("/?");
        Matcher mm = Pattern.compile(re.toString()).matcher(path);
        if (mm.matches() && names.size() < best) {
          best = names.size(); ep = e; Map<String, String> u = new HashMap<>();
          for (int i = 0; i < names.size(); i++) u.put(names.get(i), URLDecoder.decode(mm.group(i + 1), StandardCharsets.UTF_8));
          uriParams = u;
        }
      }
      if (ep == null) { send(x, 404, err("No resource in the spec matches " + path + (basePath.isEmpty() ? "" : " (after the base path " + basePath + ")") + ".")); return; }
      amf.apicontract.client.platform.model.domain.Operation op = null;
      for (var o : ep.operations()) if (o.method().value().equalsIgnoreCase(x.getRequestMethod())) op = o;
      if (op == null) { send(x, 405, err(ep.path().value() + " has no " + x.getRequestMethod() + " method in the spec.")); return; }

      // The request against the spec.
      byte[] in = x.getRequestBody().readAllBytes();
      List<String> problems = new ArrayList<>();
      Map<String, String> query = new HashMap<>();
      String rq = x.getRequestURI().getRawQuery();
      if (rq != null) for (String kv : rq.split("&")) { if (kv.isEmpty()) continue; String[] p = kv.split("=", 2); query.put(URLDecoder.decode(p[0], StandardCharsets.UTF_8), p.length > 1 ? URLDecoder.decode(p[1], StandardCharsets.UTF_8) : ""); }
      for (var r : op.requests()) {
        for (var p : r.queryParameters()) check(p, query.get(name(p)), "query parameter", problems);
        for (var p : r.headers()) check(p, header(x, name(p)), "header", problems);
        for (var p : r.uriParameters()) check(p, uriParams.get(name(p)), "URI parameter", problems);
        if (!r.payloads().isEmpty() && in.length > 0) {
          String ct = Optional.ofNullable(header(x, "Content-Type")).orElse("application/json").split(";")[0].trim();
          var pl = r.payloads().stream().filter(p -> !p.mediaType().isNullOrEmpty() && p.mediaType().value().equalsIgnoreCase(ct)).findFirst().orElse(r.payloads().get(0));
          if (pl.schema() != null && (ct.contains("json") || ct.contains("xml"))) {
            var report = config.elementClient().payloadValidatorFor(pl.schema(), ct, ValidationMode.StrictValidationMode()).syncValidate(new String(in, StandardCharsets.UTF_8));
            for (var res : report.results()) if (res.severityLevel().equals("Violation")) problems.add("body: " + res.message());
          }
        }
      }
      if (!problems.isEmpty()) { send(x, 400, err("The request doesn't match the spec.").set("problems", Main.JSON.valueToTree(problems))); return; }

      // The response: MS2-Status-Code, or an error at MS2-Error-Rate, or the first success.
      var responses = op.responses();
      String wanted = header(x, "MS2-Status-Code");
      String rate = header(x, "MS2-Error-Rate");
      amf.apicontract.client.platform.model.domain.Response resp = null;
      if (wanted != null) { for (var r : responses) if (r.statusCode().value().equals(wanted.trim())) resp = r; if (resp == null) { send(x, Integer.parseInt(wanted.trim()), Main.JSON.createObjectNode()); return; } }
      else if (rate != null && RANDOM.nextDouble() < Double.parseDouble(rate.trim())) {
        for (var r : responses) if (resp == null && r.statusCode().value().matches("[45]\\d\\d")) resp = r;
        if (resp == null) { send(x, 500, err("A random error, from MS2-Error-Rate.")); return; }
      } else {
        for (var r : responses) if (resp == null && r.statusCode().value().matches("2\\d\\d")) resp = r;
        if (resp == null && !responses.isEmpty()) resp = responses.get(0);
      }
      int code = resp == null ? 200 : Integer.parseInt(resp.statusCode().value().replaceAll("\\D", "").isEmpty() ? "200" : resp.statusCode().value());
      if (resp == null || resp.payloads().isEmpty()) { x.sendResponseHeaders(code == 204 ? 204 : code, -1); return; }
      String accept = Optional.ofNullable(header(x, "Accept")).orElse("*/*");
      var pl = resp.payloads().stream().filter(p -> !p.mediaType().isNullOrEmpty() && accept.contains(p.mediaType().value())).findFirst().orElse(resp.payloads().get(0));
      String media = pl.mediaType().isNullOrEmpty() ? "application/json" : pl.mediaType().value();
      boolean randomize = "true".equalsIgnoreCase(header(x, "MS2-Randomize"));
      JsonNode body = randomize ? null : example(pl.schema(), header(x, "MS2-Example"));
      if (body == null) body = make(pl.schema(), 0, new HashSet<>());
      // An example AMF kept only as text (a JSON example written as a string, or one it didn't read into a
      // structure) is the JSON itself, not a string holding it: sent as that JSON, not quoted and escaped.
      if (body.isTextual() && media.contains("json")) try { body = Main.JSON.readTree(body.asText()); } catch (Exception notJson) { /* plain text: stays a JSON string */ }
      x.getResponseHeaders().add("Content-Type", media);
      byte[] outBytes = (body.isTextual() && !media.contains("json") ? body.asText() : body.toPrettyString()).getBytes(StandardCharsets.UTF_8);
      x.sendResponseHeaders(code, outBytes.length);
      try (OutputStream o = x.getResponseBody()) { o.write(outBytes); }
    } catch (Exception e) {
      try { send(x, 500, err("The mock hit a problem: " + e)); } catch (Exception ignored) { /* the client went away */ }
    } finally { x.close(); }
  }

  static String name(amf.apicontract.client.platform.model.domain.Parameter p) { return p.parameterName().isNullOrEmpty() ? p.name().value() : p.parameterName().value(); }
  static String header(HttpExchange x, String n) { return x.getRequestHeaders().getFirst(n); }
  static ObjectNode err(String msg) { return Main.JSON.createObjectNode().put("error", msg); }
  static void send(HttpExchange x, int code, JsonNode body) throws IOException {
    byte[] b = body.toPrettyString().getBytes(StandardCharsets.UTF_8);
    x.getResponseHeaders().add("Content-Type", "application/json");
    x.sendResponseHeaders(code, b.length);
    try (OutputStream o = x.getResponseBody()) { o.write(b); }
  }
  // A parameter: present when required, and its value valid for its type.
  static void check(amf.apicontract.client.platform.model.domain.Parameter p, String value, String where, List<String> problems) {
    if (value == null) { if (p.required().value()) problems.add("missing required " + where + " " + name(p)); return; }
    if (p.schema() == null) return;
    var report = config.elementClient().payloadValidatorFor(p.schema(), "application/yaml", ValidationMode.ScalarRelaxedValidationMode()).syncValidate(value);
    for (var r : report.results()) if (r.severityLevel().equals("Violation")) problems.add(where + " " + name(p) + ": " + r.message());
  }

  // The payload's example: the named one (MS2-Example), else the first.
  static JsonNode example(Shape s, String named) {
    if (!(s instanceof AnyShape a) || a.examples().isEmpty()) return null;
    var ex = a.examples().get(0);
    if (named != null) for (var e : a.examples()) if (!e.name().isNullOrEmpty() && e.name().value().equals(named)) ex = e;
    if (ex.structuredValue() != null) return Main.dataJson(ex.structuredValue(), 0);
    return ex.value().isNullOrEmpty() ? null : Main.JSON.getNodeFactory().textNode(ex.value().value());
  }
  // A value made from a type: its example if it has one, else its first enum value or a plain value of its kind.
  static JsonNode make(Shape s, int depth, Set<String> seen) {
    var f = Main.JSON.getNodeFactory();
    if (s == null || depth > 8) return f.nullNode();
    if (s.isLink() && s.linkTarget().isPresent() && s.linkTarget().get() instanceof Shape t) s = t;
    if (s instanceof AnyShape a && !a.examples().isEmpty() && a.examples().get(0).structuredValue() != null) return Main.dataJson(a.examples().get(0).structuredValue(), 0);
    if (!s.values().isEmpty()) return Main.dataJson(s.values().get(0), 0);
    if (s.defaultValue() != null) return Main.dataJson(s.defaultValue(), 0);
    if (s instanceof NodeShape n) {
      ObjectNode o = Main.JSON.createObjectNode();
      if (!seen.add(n.id())) return o; // a type that contains itself: stop here
      for (var p : n.properties()) o.set(p.name().value(), make(p.range(), depth + 1, seen));
      seen.remove(n.id());
      return o;
    }
    if (s instanceof ArrayShape arr) { ArrayNode r = Main.JSON.createArrayNode(); r.add(make(arr.items(), depth + 1, seen)); return r; }
    if (s instanceof UnionShape u && !u.anyOf().isEmpty()) return make(u.anyOf().get(0), depth + 1, seen);
    if (s instanceof ScalarShape sc) {
      String t = sc.dataType().isNullOrEmpty() ? "" : sc.dataType().value();
      if (t.endsWith("#integer") || t.endsWith("#long")) return f.numberNode(sc.minimum().isNull() ? 1 : (long) Math.max(1, sc.minimum().value()));
      if (t.endsWith("#float") || t.endsWith("#double") || t.endsWith("#number")) return f.numberNode(sc.minimum().isNull() ? 1.5 : sc.minimum().value());
      if (t.endsWith("#boolean")) return f.booleanNode(true);
      if (t.endsWith("#date")) return f.textNode(java.time.LocalDate.now().toString());
      if (t.endsWith("#dateTime")) return f.textNode(java.time.OffsetDateTime.now().withNano(0).toString());
      if (t.endsWith("#dateTimeOnly")) return f.textNode(java.time.LocalDateTime.now().withNano(0).toString());
      if (t.endsWith("#time")) return f.textNode(java.time.LocalTime.now().withNano(0).toString());
      if (t.endsWith("#nil")) return f.nullNode();
      return f.textNode(s.name().isNullOrEmpty() || s.name().value().equals("schema") ? "string" : s.name().value());
    }
    return Main.JSON.createObjectNode();
  }
}
