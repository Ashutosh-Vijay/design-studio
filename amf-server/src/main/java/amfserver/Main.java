package amfserver;

import amf.apicontract.client.platform.AMFBaseUnitClient;
import amf.apicontract.client.platform.AMFConfiguration;
import amf.apicontract.client.platform.APIConfiguration;
import amf.apicontract.client.platform.OASConfiguration;
import amf.apicontract.client.platform.RAMLConfiguration;
import amf.core.client.common.transform.PipelineId;
import amf.core.client.platform.AMFResult;
import amf.core.client.common.remote.Content;
import amf.core.client.platform.AMFParseResult;
import amf.core.client.platform.model.document.BaseUnit;
import amf.core.client.platform.reference.CachedReference;
import amf.core.client.platform.reference.UnitCache;
import amf.core.client.platform.resource.FileResourceLoader;
import amf.core.client.platform.resource.HttpResourceLoader;
import amf.core.client.platform.resource.ResourceLoader;
import amf.core.client.platform.validation.AMFValidationReport;
import amf.core.client.platform.validation.AMFValidationResult;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/**
 * amf-server: AMF behind JSON lines on stdin/stdout (ARCHITECTURE section 4).
 *
 *   request  {id, op, ...}            reply {id, ok, ...} or {id, ok:false, error}
 *   open     {root, main}             the project and its root file (path relative to root)
 *   overlay  {files: {path: text}}    unsaved editor text, served before the disk; null removes one
 *   check    {mode: parse|validate}   problems from the parse phase, plus validation when asked (noCache:true skips the unit cache, for comparisons)
 *   convert  {path, to, syntax}       a spec file as OAS 3.0 / OAS 2.0 / RAML 1.0, YAML or JSON (Design Center's "Duplicate As")
 *
 * The first line out is {"event":"ready"}. AMF's own logging goes to stderr so it can never
 * corrupt the protocol. One worker: a check that is already outdated by a newer queued check is
 * answered {stale:true} without running.
 */
public class Main {
  static final ObjectMapper JSON = new ObjectMapper();
  static PrintStream out;
  static Path root;
  static String main;
  static final Map<String, String> overlays = new ConcurrentHashMap<>(); // key: absolute path, forward slashes

  public static void main(String[] args) throws Exception {
    out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
    System.setOut(System.err);
    send(JSON.createObjectNode().put("event", "ready").put("amf", "5.15.0"));

    BlockingDeque<JsonNode> queue = new LinkedBlockingDeque<>();
    Thread reader = new Thread(() -> {
      try (BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
        for (String line; (line = in.readLine()) != null; ) {
          if (line.isBlank()) continue;
          try { queue.put(JSON.readTree(line)); } catch (Exception e) { System.err.println("bad request: " + e.getMessage()); }
        }
      } catch (Exception e) { System.err.println("stdin closed: " + e.getMessage()); }
      System.exit(0); // the app went away
    });
    reader.setDaemon(true);
    reader.start();

    warmUp();

    while (true) {
      JsonNode req = queue.take();
      // A newer check makes this one pointless; skip ahead, but never past an open or overlay.
      while ("check".equals(req.path("op").asText()) && !queue.isEmpty() && "check".equals(queue.peekFirst().path("op").asText())) {
        send(reply(req).put("stale", true));
        req = queue.take();
      }
      try {
        handle(req);
      } catch (Throwable t) {
        ObjectNode r = JSON.createObjectNode().put("id", req.path("id").asLong()).put("ok", false).put("error", String.valueOf(t.getMessage()));
        send(r);
        t.printStackTrace();
      }
    }
  }

  static void handle(JsonNode req) throws Exception {
    switch (req.path("op").asText()) {
      case "open" -> {
        root = Paths.get(req.path("root").asText()).toAbsolutePath().normalize();
        main = req.path("main").asText();
        overlays.clear();
        unitCache.clear();
        send(reply(req));
      }
      case "overlay" -> {
        Iterator<Map.Entry<String, JsonNode>> it = req.path("files").fields();
        while (it.hasNext()) {
          Map.Entry<String, JsonNode> e = it.next();
          String key = abs(e.getKey());
          if (e.getValue().isNull()) overlays.remove(key); else overlays.put(key, e.getValue().asText());
        }
        send(reply(req));
      }
      case "check" -> send(check(req, "validate".equals(req.path("mode").asText())));
      case "convert" -> send(convert(req));
      default -> send(JSON.createObjectNode().put("id", req.path("id").asLong()).put("ok", false).put("error", "unknown op"));
    }
  }

  // Unsaved editor text first, then the disk (AMF's own loaders).
  static final ResourceLoader OVERLAY = new ResourceLoader() {
    @Override public CompletableFuture<Content> fetch(String resource) {
      return CompletableFuture.completedFuture(new Content(overlays.get(pathOf(resource)), resource));
    }
    @Override public boolean accepts(String resource) {
      return resource.startsWith("file:") && overlays.containsKey(pathOf(resource));
    }
  };

  // withResourceLoader() appends after AMF's own file loader, which then answers first. Replace the list instead.
  static List<ResourceLoader> loaders() { return List.of(OVERLAY, new FileResourceLoader(), new HttpResourceLoader()); }

  // Parsed libraries and fragments, reused while none of the files they are built from has changed
  // (on disk or in the overlay). Only units whose files parsed without problems are kept, so the
  // problem list is the same with or without the cache.
  record Cached(BaseUnit unit, Map<String, String> stamps) {}
  static final Map<String, Cached> unitCache = new ConcurrentHashMap<>();
  static final UnitCache CACHE = url -> {
    Cached c = unitCache.get(pathOf(url));
    if (c == null || !c.stamps().entrySet().stream().allMatch(e -> e.getValue().equals(stamp(e.getKey())))) {
      return CompletableFuture.failedFuture(new Exception("not cached"));
    }
    return CompletableFuture.completedFuture(new CachedReference(url, c.unit()));
  };
  static String stamp(String path) {
    String o = overlays.get(path);
    if (o != null) return "o" + o.length() + ":" + o.hashCode();
    File f = new File(path);
    return f.exists() ? "f" + f.length() + ":" + f.lastModified() : "missing";
  }
  // Every file a unit is built from: itself and everything it references, all the way down.
  static void files(BaseUnit u, Set<String> into) {
    if (u.location() == null || !into.add(pathOf(u.location()))) return;
    for (BaseUnit r : u.references()) files(r, into);
  }
  static void remember(BaseUnit rootUnit, List<AMFValidationResult> results) {
    Set<String> bad = new HashSet<>();
    for (AMFValidationResult r : results) r.location().ifPresent(l -> bad.add(pathOf(l)));
    Set<String> seen = new HashSet<>();
    Deque<BaseUnit> todo = new ArrayDeque<>(rootUnit.references());
    while (!todo.isEmpty()) {
      BaseUnit u = todo.pop();
      if (u.location() == null || !seen.add(pathOf(u.location()))) continue;
      todo.addAll(u.references());
      Set<String> fs = new LinkedHashSet<>();
      files(u, fs);
      if (fs.stream().anyMatch(bad::contains)) continue; // a problem anywhere inside: parse it fresh each time
      Map<String, String> stamps = new HashMap<>();
      for (String f : fs) stamps.put(f, stamp(f));
      unitCache.put(pathOf(u.location()), new Cached(u, stamps));
    }
  }

  static ObjectNode check(JsonNode req, boolean validate) throws Exception {
    if (root == null) throw new IllegalStateException("no project open");
    long t0 = System.nanoTime();
    AMFConfiguration config = APIConfiguration.API().withResourceLoaders(loaders());
    if (!req.path("noCache").asBoolean()) config = config.withUnitCache(CACHE);
    AMFBaseUnitClient client = config.baseUnitClient();
    AMFParseResult parsed = client.parse(fileUrl(root.resolve(main))).get();
    long t1 = System.nanoTime();
    if (!req.path("noCache").asBoolean()) remember(parsed.baseUnit(), parsed.results());
    List<ObjectNode> problems = new ArrayList<>();
    for (AMFValidationResult r : parsed.results()) problems.add(problem(r, "parse"));
    String spec = parsed.sourceSpec() == null ? "" : parsed.sourceSpec().id();
    long t2 = t1;
    if (validate && parsed.sourceSpec() != null) {
      // The auto-detect configuration refuses to validate (M0.1): use the detected spec's own.
      AMFValidationReport report = APIConfiguration.fromSpec(parsed.sourceSpec()).withResourceLoaders(loaders()).baseUnitClient().validate(parsed.baseUnit()).get();
      t2 = System.nanoTime();
      Set<String> seen = new HashSet<>();
      for (ObjectNode p : problems) seen.add(key(p));
      for (AMFValidationResult r : report.results()) { ObjectNode p = problem(r, "validate"); if (seen.add(key(p))) problems.add(p); }
    }
    ObjectNode res = reply(req).put("spec", spec).put("parseMs", (t1 - t0) / 1_000_000).put("validateMs", (t2 - t1) / 1_000_000);
    ArrayNode arr = res.putArray("problems");
    problems.forEach(arr::add);
    return res;
  }

  // AMF's Compatibility pipeline, as Design Center's Download as / Duplicate As. Not guaranteed valid; the result is checked like any file.
  static ObjectNode convert(JsonNode req) throws Exception {
    if (root == null) throw new IllegalStateException("no project open");
    String path = req.path("path").asText(), to = req.path("to").asText();
    AMFParseResult parsed = APIConfiguration.API().withResourceLoaders(loaders()).baseUnitClient().parse(fileUrl(root.resolve(path))).get();
    AMFConfiguration target = switch (to) {
      case "oas30" -> OASConfiguration.OAS30();
      case "oas20" -> OASConfiguration.OAS20();
      case "raml10" -> RAMLConfiguration.RAML10();
      default -> throw new IllegalArgumentException("unknown target " + to);
    };
    var client = target.withResourceLoaders(loaders()).baseUnitClient();
    AMFResult converted = client.transform(parsed.baseUnit(), PipelineId.Compatibility());
    String text = client.render(converted.baseUnit(), "json".equals(req.path("syntax").asText()) ? "application/json" : "application/yaml");
    return reply(req).put("text", text).put("conforms", converted.conforms());
  }

  static String key(ObjectNode p) { return p.path("file").asText() + ":" + p.path("line").asInt() + ":" + p.path("col").asInt() + ":" + p.path("message").asText(); }

  static ObjectNode problem(AMFValidationResult r, String phase) {
    ObjectNode p = JSON.createObjectNode();
    String sev = r.severityLevel();
    p.put("severity", "Violation".equals(sev) ? "error" : "Warning".equals(sev) ? "warning" : "info");
    String file = r.location().map(Main::rel).orElse(main);
    String msg = r.message() == null ? "" : r.message().trim();
    // The OS text for a missing file comes through mangled on Windows (M0.1); say it ourselves.
    if (msg.startsWith("File Not Found: ")) msg = "File not found: " + rel(msg.substring(16).replaceAll("\\s*\\(.*\\)\\s*$", "").trim());
    else if (msg.contains("NoSuchFileException") || msg.contains("FileNotFoundException") || msg.contains("cannot find the file") || msg.contains("No such file")) {
      String missing = msg.replaceAll("(?s).*?(?:file:/+)?([^\\s'\"]+\\.(?:raml|json|yaml|yml|xsd|xml))(?s).*", "$1");
      msg = "File not found: " + rel(missing);
    }
    p.put("message", msg.replaceAll("\\s+", " "));
    p.put("file", file);
    var pos = r.position();
    p.put("line", pos.start().line()).put("col", pos.start().column()).put("endLine", pos.end().line()).put("endCol", pos.end().column());
    p.put("code", r.validationId() == null ? "" : r.validationId().replaceAll(".*#", ""));
    p.put("phase", phase);
    return p;
  }

  // file:///A:/x/y.raml, file://A:/x/y.raml or /A:/x/y.raml -> A:/x/y.raml
  static String pathOf(String resource) {
    String s = resource;
    try { if (s.startsWith("file:")) s = Paths.get(new URI(s.replace(" ", "%20"))).toString(); } catch (Exception e) { s = s.replaceFirst("^file:/*", ""); }
    s = s.replace('\\', '/');
    if (s.matches("^/[A-Za-z]:/.*")) s = s.substring(1);
    return s;
  }
  // AMF's file loader doesn't decode %20, so Path.toUri() breaks on folders with spaces
  // ("API Designer Studio"). Hand it a plain file:// URL with the path as it is.
  static String fileUrl(Path p) {
    String s = p.toAbsolutePath().normalize().toString().replace('\\', '/');
    return s.startsWith("/") ? "file://" + s : "file:///" + s;
  }

  static String abs(String rel) { return root.resolve(rel).normalize().toString().replace('\\', '/'); }
  static String rel(String resource) {
    String p = pathOf(resource), r = root.toString().replace('\\', '/') + "/";
    return p.toLowerCase().startsWith(r.toLowerCase()) ? p.substring(r.length()) : p;
  }

  static ObjectNode reply(JsonNode req) { return JSON.createObjectNode().put("id", req.path("id").asLong()).put("ok", true); }
  static synchronized void send(JsonNode n) { out.println(n.toString()); }

  // Pays AMF's class loading (about 2 s, M0.1) before the user opens anything.
  static void warmUp() {
    try {
      Path dir = Files.createTempDirectory("amf-warm");
      Path spec = dir.resolve("warm.raml");
      Files.writeString(spec, "#%RAML 1.0\ntitle: warm\n/x:\n  get:\n    responses:\n      200:\n        body:\n          application/json:\n            type: string\n");
      Path prevRoot = root; String prevMain = main;
      root = dir; main = "warm.raml";
      check(JSON.createObjectNode().put("id", -1), true);
      root = prevRoot; main = prevMain;
      Files.deleteIfExists(spec); Files.deleteIfExists(dir);
    } catch (Throwable t) { System.err.println("warm-up failed: " + t); }
  }
}
