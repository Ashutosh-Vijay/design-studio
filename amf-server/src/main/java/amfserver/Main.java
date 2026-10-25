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
  static final Map<String, amf.core.client.platform.model.domain.DomainElement> govIndex = new HashMap<>(); // the last governance graph's elements, for govLocate
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
        Mock.stale = true;
        send(reply(req));
      }
      case "overlay" -> {
        Iterator<Map.Entry<String, JsonNode>> it = req.path("files").fields();
        while (it.hasNext()) {
          Map.Entry<String, JsonNode> e = it.next();
          String key = abs(e.getKey());
          if (e.getValue().isNull()) overlays.remove(key); else overlays.put(key, e.getValue().asText());
        }
        Mock.stale = true;
        send(reply(req));
      }
      case "check" -> { Mock.stale = true; send(check(req, "validate".equals(req.path("mode").asText()))); }
      // The API as the docs show it: traits, resource types and inheritance applied (the mock's own copy).
      // Governance (PLAN 10.15): the API as AMF's graph for amf-custom-validator, which runs in the webview.
      // The Editing pipeline gives every element a short id (amf://id#N); the validator reports those ids, and
      // govLocate turns them back into files and lines from this same unit. Parsed fresh: the cached units
      // must not be transformed.
      case "governanceGraph" -> {
        AMFParseResult parsed = APIConfiguration.API().withResourceLoaders(loaders()).baseUnitClient().parse(fileUrl(root.resolve(main))).get();
        AMFConfiguration cfg = APIConfiguration.fromSpec(parsed.sourceSpec()).withResourceLoaders(loaders())
          .withRenderOptions(new amf.core.client.platform.config.RenderOptions().withGovernanceMode().withCompactUris());
        BaseUnit unit = cfg.baseUnitClient().transform(parsed.baseUnit(), PipelineId.Editing()).baseUnit();
        // Every element by id, taken before rendering (governance mode flattens the unit as it renders): each
        // unit's own elements (findById stays inside one unit and skips a library's declarations, so those are walked).
        govIndex.clear();
        Deque<BaseUnit> todo = new ArrayDeque<>(List.of(unit)); Set<String> seen = new HashSet<>();
        while (!todo.isEmpty()) {
          BaseUnit u = todo.pop(); if (!seen.add(u.id())) continue; todo.addAll(u.references());
          if (u instanceof amf.core.client.platform.model.document.DeclaresModel dm) for (var d : dm.declares()) collect(d, govIndex, 0);
          if (u instanceof amf.core.client.platform.model.document.EncodesModel em && em.encodes() != null) walkAll(em.encodes(), govIndex, 0);
        }
        send(reply(req).put("graph", cfg.baseUnitClient().render(unit, "application/ld+json")));
      }
      case "govLocate" -> {
        ObjectNode r = reply(req), at = r.putObject("at");
        for (JsonNode id : req.path("ids")) {
          var e = govIndex.get(id.asText());
          ObjectNode a = e == null ? null : at(e.annotations());
          if (a != null) at.set(id.asText(), a);
        }
        send(r);
      }
      case "resolvedModel" -> { Mock.load(); ObjectNode r = reply(req); r.set("model", model(Mock.resolvedUnit)); send(r); }
      // The local mock: on starts it (or says where it runs), off stops it.
      case "mock" -> {
        if (req.path("on").asBoolean(true)) { ObjectNode r = reply(req); r.setAll(Mock.start(req.path("port").asInt(0))); send(r); }
        else { Mock.stop(); send(reply(req)); }
      }
      // The model of a spec in another folder (a version published to Exchange), for "what changed".
      // Parsed fresh: no cache, and no overlays apply out there.
      case "modelOf" -> {
        if (root == null) throw new IllegalStateException("no project open");
        AMFParseResult parsed = APIConfiguration.API().withResourceLoaders(loaders()).baseUnitClient()
          .parse(fileUrl(Path.of(req.path("dir").asText()).resolve(req.path("main").asText()))).get();
        ObjectNode r = reply(req); r.set("model", model(parsed.baseUnit())); send(r);
      }
      case "convert" -> send(convert(req));
      case "jsonSchema" -> send(jsonSchema(req));
      case "lesson" -> send(lesson(req));
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
    // Read before validation, which may resolve the unit. The unresolved model keeps links to declarations
    // (AMF's Editing pipeline was tried: it expands them, losing "used by", and took 4.5 s on a big spec).
    ObjectNode model = null;
    if (req.path("model").asBoolean()) {
      long tm = System.nanoTime();
      model = model(parsed.baseUnit());
      model.put("ms", (System.nanoTime() - tm) / 1_000_000);
    }
    long t2 = t1;
    if (validate && parsed.sourceSpec() != null) {
      // The auto-detect configuration refuses to validate (M0.1): use the detected spec's own.
      // Validation resolves the unit in place (links become copies), and the parsed libraries are the ones the
      // cache keeps: so it gets a copy, or the next check's model would lose type-to-type links.
      AMFValidationReport report = APIConfiguration.fromSpec(parsed.sourceSpec()).withResourceLoaders(loaders()).baseUnitClient().validate(parsed.baseUnit().cloneUnit()).get();
      t2 = System.nanoTime();
      Set<String> seen = new HashSet<>();
      for (ObjectNode p : problems) seen.add(key(p));
      for (AMFValidationResult r : report.results()) { ObjectNode p = problem(r, "validate"); if (seen.add(key(p))) problems.add(p); }
    }
    ObjectNode res = reply(req).put("spec", spec).put("parseMs", (t1 - t0) / 1_000_000).put("validateMs", (t2 - t1) / 1_000_000);
    ArrayNode arr = res.putArray("problems");
    problems.forEach(arr::add);
    if (model != null) res.set("model", model);
    return res;
  }

  // The Academy's checks: a few files held in memory (never on disk, never the open project's), parsed and
  // validated like a project, with the model the lesson's goals are checked against. Requests run one at a
  // time, so the open project's root is borrowed for the paths and put back.
  static final Map<String, String> lessonFiles = new ConcurrentHashMap<>();
  static final ResourceLoader LESSON = new ResourceLoader() {
    @Override public CompletableFuture<Content> fetch(String resource) {
      String t = lessonFiles.get(pathOf(resource));
      return t == null ? CompletableFuture.failedFuture(new java.io.FileNotFoundException(rel(resource) + " isn't one of this lesson's files")) : CompletableFuture.completedFuture(new Content(t, resource));
    }
    @Override public boolean accepts(String resource) { return resource.startsWith("file:"); }
  };
  static ObjectNode lesson(JsonNode req) throws Exception {
    Path keepRoot = root; String keepMain = main;
    root = Paths.get(System.getProperty("java.io.tmpdir"), "design-studio-academy").toAbsolutePath().normalize();
    main = req.path("main").asText();
    try {
      lessonFiles.clear();
      req.path("files").fields().forEachRemaining(e -> lessonFiles.put(pathOf(fileUrl(root.resolve(e.getKey()))), e.getValue().asText()));
      List<ResourceLoader> only = List.of(LESSON);
      AMFParseResult parsed = APIConfiguration.API().withResourceLoaders(only).baseUnitClient().parse(fileUrl(root.resolve(main))).get();
      List<ObjectNode> problems = new ArrayList<>();
      for (AMFValidationResult r : parsed.results()) problems.add(problem(r, "parse"));
      ObjectNode model = model(parsed.baseUnit());
      if (parsed.sourceSpec() != null) {
        AMFValidationReport report = APIConfiguration.fromSpec(parsed.sourceSpec()).withResourceLoaders(only).baseUnitClient().validate(parsed.baseUnit().cloneUnit()).get();
        Set<String> seen = new HashSet<>();
        for (ObjectNode p : problems) seen.add(key(p));
        for (AMFValidationResult r : report.results()) { ObjectNode p = problem(r, "validate"); if (seen.add(key(p))) problems.add(p); }
      }
      ObjectNode res = reply(req).put("spec", parsed.sourceSpec() == null ? "" : parsed.sourceSpec().id());
      ArrayNode arr = res.putArray("problems");
      problems.forEach(arr::add);
      res.set("model", model);
      return res;
    } finally {
      root = keepRoot; main = keepMain; lessonFiles.clear();
    }
  }

  // A declared type as JSON Schema, by AMF (the Inspector's "Copy as JSON Schema"). Parsed without the unit
  // cache: rendering may resolve the shape, and cached units are shared between checks.
  static ObjectNode jsonSchema(JsonNode req) throws Exception {
    if (root == null) throw new IllegalStateException("no project open");
    AMFParseResult parsed = APIConfiguration.API().withResourceLoaders(loaders()).baseUnitClient().parse(fileUrl(root.resolve(main))).get();
    // By name and file: element ids can differ between two parses.
    String name = req.path("name").asText(), file = req.path("file").asText();
    Deque<BaseUnit> units = new ArrayDeque<>(List.of(parsed.baseUnit())); Set<String> seen = new HashSet<>();
    while (!units.isEmpty()) {
      BaseUnit u = units.pop();
      if (!seen.add(u.id())) continue;
      units.addAll(u.references());
      if (u instanceof amf.core.client.platform.model.document.DeclaresModel dm && rel(u.location()).equalsIgnoreCase(file)) for (var d : dm.declares()) {
        if (d instanceof amf.shapes.client.platform.model.domain.AnyShape s && name.equals(s.name().value())) return reply(req).put("text", APIConfiguration.API().elementClient().toJsonSchema(s));
      }
    }
    throw new IllegalArgumentException("That type isn't in the spec any more. Check again after the spec is read.");
  }

  // ---------- The API as AMF reads it, for the Inspector (op check with model:true) ----------
  // Endpoints, operations, parameters, bodies, responses and declared types, each with its file and
  // position, and the type names as the spec writes them. "Used by" comes from AMF's own links, so it
  // follows aliases, $refs and libraries exactly.
  static ObjectNode at(amf.core.client.platform.model.Annotations a) {
    var r = a.lexical();
    if (r == null || (r.start().line() == 0 && r.end().line() == 0)) return null;
    ObjectNode n = JSON.createObjectNode();
    n.put("file", a.location().map(Main::rel).orElse(main));
    n.putArray("r").add(r.start().line()).add(r.start().column()).add(r.end().line()).add(r.end().column());
    return n;
  }
  static void put(ObjectNode n, String key, amf.core.client.platform.model.StrField f) {
    if (f == null || f.isNullOrEmpty()) return;
    ObjectNode v = n.putObject(key).put("v", f.value());
    ObjectNode p = at(f.annotations()); if (p != null) v.set("at", p);
  }
  static String local(String uri) { return uri == null ? "" : uri.replaceAll(".*[#/]", ""); }

  // A shape's type in one word: Order, lib.Order, Order[], string, A | B.
  static String typeName(amf.core.client.platform.model.domain.Shape s, int depth) {
    if (s == null || depth > 6) return "";
    if (s.isLink()) {
      String label = s.linkLabel().isNullOrEmpty() ? "" : s.linkLabel().value();
      if (!label.isEmpty() && !label.startsWith("#") && !label.contains("/")) return label;
      return s.linkTarget().map(t -> t instanceof amf.core.client.platform.model.domain.Shape sh ? sh.name().value() : "").orElse(local(label));
    }
    if (s instanceof amf.shapes.client.platform.model.domain.ScalarShape sc) return local(sc.dataType().value()).replace("dateTime", "datetime").replace("long", "integer").replace("float", "number").replace("double", "number");
    if (s instanceof amf.shapes.client.platform.model.domain.ArrayShape a) { String i = typeName(a.items(), depth + 1); return (i.isEmpty() ? "any" : i) + "[]"; }
    if (s instanceof amf.shapes.client.platform.model.domain.UnionShape u) { List<String> xs = new ArrayList<>(); for (var x : u.anyOf()) xs.add(typeName(x, depth + 1)); return String.join(" | ", xs); }
    if (!s.inherits().isEmpty()) return typeName(s.inherits().get(0), depth + 1);
    if (s instanceof amf.shapes.client.platform.model.domain.FileShape) return "file";
    if (s instanceof amf.shapes.client.platform.model.domain.NilShape) return "nil";
    if (s instanceof amf.shapes.client.platform.model.domain.NodeShape) return "object";
    return "any";
  }

  // Every link to a declared type, wherever it sits: [targetId, where, position].
  static void links(amf.core.client.platform.model.domain.Shape s, String where, List<Object[]> out, Set<String> seen, int depth) {
    if (s == null || depth > 12) return;
    if (s.isLink()) { s.linkTarget().ifPresent(t -> out.add(new Object[]{ t.id(), where, at(s.annotations()) })); return; }
    if (!seen.add(s.id())) return;
    for (var i : s.inherits()) links(i, where, out, seen, depth + 1);
    if (s instanceof amf.shapes.client.platform.model.domain.ArrayShape a) links(a.items(), where, out, seen, depth + 1);
    if (s instanceof amf.shapes.client.platform.model.domain.UnionShape u) for (var x : u.anyOf()) links(x, where, out, seen, depth + 1);
    if (s instanceof amf.shapes.client.platform.model.domain.NodeShape n) for (var p : n.properties()) links(p.range(), where.isEmpty() ? p.name().value() : where + "." + p.name().value(), out, seen, depth + 1);
  }

  static ObjectNode payloads(List<? extends amf.shapes.client.platform.model.domain.operations.AbstractPayload> ps, String where, List<Object[]> refs, ArrayNode into) {
    for (var p : ps) {
      ObjectNode b = into.addObject().put("media", p.mediaType().isNullOrEmpty() ? "" : p.mediaType().value()).put("type", typeName(p.schema(), 0));
      ObjectNode a = at(p.annotations()); if (a != null) b.set("at", a);
      String ex = exampleText(p.schema()); if (ex != null) b.put("example", ex);
      links(p.schema(), where, refs, new HashSet<>(), 0);
    }
    return null;
  }

  // The API's own elements, for govLocate: endpoints, operations, requests, responses, payloads, parameters, their shapes.
  static void walkAll(amf.core.client.platform.model.domain.DomainElement e, Map<String, amf.core.client.platform.model.domain.DomainElement> into, int depth) {
    if (e == null || depth > 14) return;
    into.putIfAbsent(e.id(), e);
    if (e instanceof amf.apicontract.client.platform.model.domain.api.Api<?> api) { for (var x : api.endPoints()) walkAll(x, into, depth + 1); for (var x : api.servers()) into.putIfAbsent(x.id(), x); }
    if (e instanceof amf.apicontract.client.platform.model.domain.EndPoint ep) { for (var x : ep.operations()) walkAll(x, into, depth + 1); for (var x : ep.parameters()) walkAll(x, into, depth + 1); }
    if (e instanceof amf.apicontract.client.platform.model.domain.Operation op) { for (var x : op.requests()) walkAll(x, into, depth + 1); for (var x : op.responses()) walkAll(x, into, depth + 1); }
    if (e instanceof amf.apicontract.client.platform.model.domain.Request rq) { for (var x : rq.payloads()) walkAll(x, into, depth + 1); for (var g : List.of(rq.queryParameters(), rq.headers(), rq.uriParameters(), rq.cookieParameters())) for (var x : g) walkAll(x, into, depth + 1); }
    if (e instanceof amf.apicontract.client.platform.model.domain.Response rs) { for (var x : rs.payloads()) walkAll(x, into, depth + 1); for (var x : rs.headers()) walkAll(x, into, depth + 1); }
    if (e instanceof amf.apicontract.client.platform.model.domain.Payload pl) collect(pl.schema(), into, depth + 1);
    if (e instanceof amf.apicontract.client.platform.model.domain.Parameter pa) collect(pa.schema(), into, depth + 1);
  }

  // A declaration and what's inside it (properties, their ranges, items, union members), by id, for govLocate.
  static void collect(amf.core.client.platform.model.domain.DomainElement e, Map<String, amf.core.client.platform.model.domain.DomainElement> into, int depth) {
    if (e == null || depth > 12 || into.putIfAbsent(e.id(), e) != null) return;
    if (e instanceof amf.shapes.client.platform.model.domain.NodeShape n) for (var p : n.properties()) { collect(p, into, depth + 1); collect(p.range(), into, depth + 1); }
    if (e instanceof amf.shapes.client.platform.model.domain.ArrayShape arr) collect(arr.items(), into, depth + 1);
    if (e instanceof amf.shapes.client.platform.model.domain.UnionShape u) for (var x : u.anyOf()) collect(x, into, depth + 1);
  }

  // A shape's first example as the spec writes it (YAML or JSON text), following links; null if none.
  static String exampleText(amf.core.client.platform.model.domain.Shape s) {
    for (int i = 0; s != null && i < 6; i++) {
      if (s instanceof amf.shapes.client.platform.model.domain.AnyShape a && !a.examples().isEmpty()) {
        var e = a.examples().get(0);
        if (!e.value().isNullOrEmpty()) return e.value().value();
        if (e.structuredValue() != null) return dataJson(e.structuredValue(), 0).toPrettyString();
      }
      s = s.isLink() && s.linkTarget().isPresent() && s.linkTarget().get() instanceof amf.core.client.platform.model.domain.Shape t ? t : null;
    }
    return null;
  }
  // AMF's parsed data (examples, defaults) as JSON, typed by the scalar's data type.
  static JsonNode dataJson(amf.core.client.platform.model.domain.DataNode n, int depth) {
    if (n == null || depth > 30) return JSON.nullNode();
    if (n instanceof amf.core.client.platform.model.domain.ScalarNode sc) {
      String v = sc.value().isNullOrEmpty() ? null : sc.value().value(), t = sc.dataType().isNullOrEmpty() ? "" : sc.dataType().value();
      if (v == null || t.endsWith("#nil")) return JSON.nullNode();
      try {
        if (t.endsWith("#integer") || t.endsWith("#long")) return JSON.getNodeFactory().numberNode(Long.parseLong(v));
        if (t.endsWith("#float") || t.endsWith("#double") || t.endsWith("#number") || t.endsWith("#decimal")) return JSON.getNodeFactory().numberNode(new java.math.BigDecimal(v));
        if (t.endsWith("#boolean")) return JSON.getNodeFactory().booleanNode(Boolean.parseBoolean(v));
      } catch (NumberFormatException e) { /* keep it as text */ }
      return JSON.getNodeFactory().textNode(v);
    }
    if (n instanceof amf.core.client.platform.model.domain.ArrayNode a) { ArrayNode r = JSON.createArrayNode(); for (var x : a.members()) r.add(dataJson(x, depth + 1)); return r; }
    if (n instanceof amf.core.client.platform.model.domain.ObjectNode o) { ObjectNode r = JSON.createObjectNode(); for (var e : o.properties().entrySet()) r.set(e.getKey(), dataJson(e.getValue(), depth + 1)); return r; }
    return JSON.nullNode();
  }

  static ObjectNode model(BaseUnit unit) {
    ObjectNode m = JSON.createObjectNode();
    List<Object[]> refs = new ArrayList<>();
    if (unit instanceof amf.core.client.platform.model.document.Document doc && doc.encodes() instanceof amf.apicontract.client.platform.model.domain.api.Api<?> api) {
      put(m, "title", api.name()); put(m, "version", api.version()); put(m, "description", api.description());
      if (!api.servers().isEmpty()) put(m, "baseUri", api.servers().get(0).url());
      ArrayNode asec = m.putArray("securedBy"); for (var rq : api.security()) for (var sc : rq.schemes()) if (!sc.name().isNullOrEmpty()) asec.add(sc.name().value());
      ArrayNode docs = m.putArray("docs");
      for (var d : api.documentations()) docs.addObject().put("title", d.title().isNullOrEmpty() ? "" : d.title().value()).put("content", d.description().isNullOrEmpty() ? "" : d.description().value());
      ArrayNode eps = m.putArray("endpoints");
      for (var ep : api.endPoints()) {
        ObjectNode e = eps.addObject().put("path", ep.path().value());
        ObjectNode ea = at(ep.annotations()); if (ea != null) e.set("at", ea);
        put(e, "summary", ep.summary()); put(e, "description", ep.description());
        // A resource's `type:` is its resource type; its `is:` traits apply to every method in it.
        ArrayNode eis = e.putArray("is");
        for (var x : ep.extendsNode()) if (x instanceof amf.core.client.platform.model.domain.ParametrizedDeclaration pd) {
          if (pd.getClass().getSimpleName().contains("Trait")) eis.add(pd.name().value()); else e.put("resourceType", pd.name().value());
        }
        // The resource's own URI parameters ({bookId}), declared on the resource rather than a method.
        ArrayNode eparams = e.putArray("params");
        for (var p : ep.parameters()) eparams.addObject().put("name", p.name().value()).put("in", p.binding().isNullOrEmpty() ? "path" : p.binding().value()).put("required", p.required().value()).put("type", typeName(p.schema(), 0));
        ArrayNode esec = e.putArray("securedBy"); for (var rq : ep.security()) for (var sc : rq.schemes()) if (!sc.name().isNullOrEmpty()) esec.add(sc.name().value());
        ArrayNode ops = e.putArray("operations");
        for (var op : ep.operations()) {
          String where = op.method().value().toUpperCase() + " " + ep.path().value();
          ObjectNode o = ops.addObject().put("method", op.method().value());
          ObjectNode oa = at(op.annotations()); if (oa != null) o.set("at", oa);
          put(o, "summary", op.summary()); put(o, "description", op.description()); put(o, "operationId", op.operationId());
          ArrayNode tags = o.putArray("tags"); for (var t : op.tags()) tags.add(t.name().value());
          ArrayNode is = o.putArray("is"); for (var x : op.extendsNode()) if (x instanceof amf.core.client.platform.model.domain.ParametrizedDeclaration pd) is.add(pd.name().value());
          ArrayNode sec = o.putArray("securedBy"); for (var rq : op.security()) for (var sc : rq.schemes()) if (!sc.name().isNullOrEmpty()) sec.add(sc.name().value());
          ArrayNode params = o.putArray("parameters"), body = o.putArray("body");
          for (var rq : op.requests()) {
            for (var group : List.of(rq.queryParameters(), rq.headers(), rq.uriParameters(), rq.cookieParameters())) for (var p : group) {
              ObjectNode pn = params.addObject().put("name", p.parameterName().isNullOrEmpty() ? p.name().value() : p.parameterName().value())
                .put("in", p.binding().isNullOrEmpty() ? "" : p.binding().value()).put("required", p.required().value()).put("type", typeName(p.schema(), 0));
              if (!p.description().isNullOrEmpty()) pn.put("description", p.description().value());
              String pex = exampleText(p.schema()); if (pex != null) pn.put("example", pex);
              ObjectNode pa = at(p.annotations()); if (pa != null) pn.set("at", pa);
              links(p.schema(), where + " " + pn.path("name").asText(), refs, new HashSet<>(), 0);
            }
            // A queryString type (RAML) uses its types too, unions included.
            if (rq.queryString() != null) links(rq.queryString(), where + " queryString", refs, new HashSet<>(), 0);
            payloads(rq.payloads(), where + " body", refs, body);
          }
          ArrayNode rs = o.putArray("responses");
          for (var r : op.responses()) {
            ObjectNode rn = rs.addObject().put("code", r.statusCode().value());
            ObjectNode ra = at(r.annotations()); if (ra != null) rn.set("at", ra);
            put(rn, "description", r.description());
            ArrayNode rh = rn.putArray("headers"); for (var h : r.headers()) rh.add(h.name().value());
            payloads(r.payloads(), where + " " + r.statusCode().value(), refs, rn.putArray("body"));
          }
        }
      }
    }
    // Declared types: this file's, and every library's and fragment's the spec references.
    ArrayNode types = m.putArray("types");
    List<ObjectNode> typeNodes = new ArrayList<>();
    List<Object[]> templateRefs = new ArrayList<>();
    Deque<BaseUnit> units = new ArrayDeque<>(List.of(unit)); Set<String> seenUnits = new HashSet<>();
    ArrayNode files = m.putArray("files");
    // The other declarations, by name: traits, resource types, security schemes (with their type), annotation types.
    ArrayNode traits = m.putArray("traits"), rtypes = m.putArray("resourceTypes"), schemes = m.putArray("schemes"), annTypes = m.putArray("annotationTypes");
    while (!units.isEmpty()) {
      BaseUnit u = units.pop();
      if (!seenUnits.add(u.id())) continue;
      units.addAll(u.references());
      if (u.location() != null) {
        ObjectNode f = files.addObject().put("file", rel(u.location())).put("kind", u.getClass().getSimpleName());
        ArrayNode fr = f.putArray("refs"); for (BaseUnit r : u.references()) if (r.location() != null) fr.add(rel(r.location()));
      }
      if (!(u instanceof amf.core.client.platform.model.document.DeclaresModel dm)) continue;
      for (var d : dm.declares()) {
        // Traits and resource types are templates: AMF keeps their bodies as data nodes, so type names
        // used inside them are read from there (with their positions).
        if (d instanceof amf.core.client.platform.model.domain.AbstractDeclaration ad) {
          String kind = d.getClass().getSimpleName().equals("Trait") ? "trait " : "resource type ";
          (kind.startsWith("trait") ? traits : rtypes).add(ad.name().value());
          templateUses(ad.dataNode(), kind + ad.name().value(), null, templateRefs, 0);
          continue;
        }
        if (d instanceof amf.apicontract.client.platform.model.domain.security.SecurityScheme ss) { schemes.addObject().put("name", ss.name().value()).put("type", ss.type().isNullOrEmpty() ? "" : ss.type().value()); continue; }
        if (d instanceof amf.core.client.platform.model.domain.CustomDomainProperty cp) { annTypes.add(cp.name().value()); continue; }
        if (!(d instanceof amf.core.client.platform.model.domain.Shape s)) continue;
        // A type declared as `Name: !include fragment.raml` is a link: its shape is the fragment's.
        var body = s.isLink() && s.linkTarget().isPresent() && s.linkTarget().get() instanceof amf.core.client.platform.model.domain.Shape ft ? ft : s;
        ObjectNode t = types.addObject().put("id", s.id()).put("name", s.name().value()).put("type", typeName(body, 0));
        if (!body.description().isNullOrEmpty()) t.put("description", body.description().value());
        if (!body.values().isEmpty()) { ArrayNode en = t.putArray("enum"); for (var v : body.values()) if (v instanceof amf.core.client.platform.model.domain.ScalarNode sn) en.add(sn.value().value()); }
        String tex = exampleText(body); if (tex != null) t.put("example", tex);
        ObjectNode ta = at(s.annotations()); if (ta != null) t.set("at", ta);
        if (body instanceof amf.shapes.client.platform.model.domain.NodeShape n) {
          ArrayNode props = t.putArray("properties");
          for (var p : n.properties()) {
            ObjectNode pn = props.addObject().put("name", p.name().value()).put("type", typeName(p.range(), 0)).put("required", p.minCount().value() > 0);
            if (!p.range().description().isNullOrEmpty()) pn.put("description", p.range().description().value());
            ObjectNode pa = at(p.annotations()); if (pa != null) pn.set("at", pa);
          }
        }
        links(s, s.name().value(), refs, new HashSet<>(), 0);
        typeNodes.add(t);
      }
    }
    for (ObjectNode t : typeNodes) {
      ArrayNode used = t.putArray("usedBy");
      for (Object[] r : refs) if (t.path("id").asText().equals(r[0]) && !t.path("name").asText().equals(String.valueOf(r[1]))) {
        ObjectNode u = used.addObject().put("where", (String) r[1]); if (r[2] != null) u.set("at", (ObjectNode) r[2]);
      }
      // In a template a type is written bare when it's declared in the template's own file, else alias.Name.
      String name = t.path("name").asText(), file = t.path("at").path("file").asText();
      for (Object[] r : templateRefs) {
        String v = ((String) r[0]).replaceAll("\\[\\]$", "").replaceAll("\\?$", "");
        String bare = v.contains(".") ? v.substring(v.indexOf('.') + 1) : v;
        String tfile = r[2] == null ? main : ((ObjectNode) r[2]).path("file").asText();
        boolean here = v.contains(".") ? !file.equals(tfile) && bare.equals(name) : file.equals(tfile) && v.equals(name);
        if (here) { ObjectNode u = used.addObject().put("where", (String) r[1]); if (r[2] != null) u.set("at", (ObjectNode) r[2]); }
      }
    }
    return m;
  }

  // Type names in a template body: values of type:, items: and "name: Type" entries, each a candidate
  // [value, where, position], matched against the declared types afterwards.
  static void templateUses(amf.core.client.platform.model.domain.DataNode n, String where, String key, List<Object[]> out, int depth) {
    if (n == null || depth > 20) return;
    if (n instanceof amf.core.client.platform.model.domain.ScalarNode s) {
      if (s.value().isNullOrEmpty() || (key != null && Set.of("description", "displayName", "example", "pattern", "usage", "title").contains(key))) return;
      for (String part : s.value().value().split("\\|")) { String v = part.trim(); if (v.matches("[A-Za-z_][\\w.-]*(\\[\\])?")) out.add(new Object[]{ v, where, at(s.annotations()) }); }
    } else if (n instanceof amf.core.client.platform.model.domain.ObjectNode o) {
      for (var e : o.properties().entrySet()) if (!e.getKey().equals("examples") && !e.getKey().equals("example")) templateUses(e.getValue(), where, e.getKey(), out, depth + 1);
    } else if (n instanceof amf.core.client.platform.model.domain.ArrayNode a) {
      if (!"is".equals(key)) for (var x : a.members()) templateUses(x, where, key, out, depth + 1);
    }
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
  // ("Design Studio"). Hand it a plain file:// URL with the path as it is.
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
