package spike;

import amf.apicontract.client.platform.AMFBaseUnitClient;
import amf.apicontract.client.platform.APIConfiguration;
import amf.apicontract.client.platform.model.domain.EndPoint;
import amf.apicontract.client.platform.model.domain.api.Api;
import amf.core.client.platform.AMFParseResult;
import amf.core.client.platform.model.document.BaseUnit;
import amf.core.client.platform.model.document.DeclaresModel;
import amf.core.client.platform.model.document.Document;
import amf.core.client.platform.model.domain.DomainElement;
import amf.core.client.platform.validation.AMFValidationReport;
import amf.core.client.platform.validation.AMFValidationResult;

import java.io.InputStream;
import java.lang.management.ManagementFactory;
import java.nio.file.*;
import java.util.*;
import java.util.regex.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * M0.1: how fast is AMF on real specs, do its problems make sense, and do model
 * elements carry source positions we can map back to the text.
 *
 *   java -jar target/amf-spike.jar <spec.zip> [<spec.zip> ...]
 */
public class Main {
  public static void main(String[] args) throws Exception {
    long jvmStart = ManagementFactory.getRuntimeMXBean().getStartTime();
    System.out.printf("JVM up to main: %d ms%n%n", System.currentTimeMillis() - jvmStart);

    for (String zip : args) {
      Path dir = extract(Paths.get(zip));
      String exchange = Files.readString(dir.resolve("exchange.json"));
      Matcher m = Pattern.compile("\"main\"\\s*:\\s*\"([^\"]+)\"").matcher(exchange);
      if (!m.find()) { System.out.println("no main in exchange.json: " + zip); continue; }
      Path main = dir.resolve(m.group(1));
      String url = main.toUri().toString();
      System.out.println("=== " + Paths.get(zip).getFileName() + "  (main: " + m.group(1) + ")");

      // Cold: first parse + validate in this JVM for this spec (the very first spec
      // also pays for loading AMF's classes).
      long[] times = run(url, true);
      System.out.printf("cold: parse %d ms, validate %d ms%n", times[0], times[1]);

      List<Long> warm = new ArrayList<>();
      for (int i = 0; i < 5; i++) { long[] t = run(url, false); warm.add(t[0] + t[1]); }
      Collections.sort(warm);
      System.out.printf("warm parse+validate (5 runs): min %d, median %d, max %d ms%n%n", warm.get(0), warm.get(2), warm.get(4));
    }
  }

  /** Parse + validate once with a fresh client; print details on the first run. */
  static long[] run(String url, boolean report) throws Exception {
    AMFBaseUnitClient client = APIConfiguration.API().baseUnitClient();
    long t0 = System.nanoTime();
    AMFParseResult parsed = client.parse(url).get();
    long t1 = System.nanoTime();
    BaseUnit unit = parsed.baseUnit();
    // The auto-detect configuration parses but cannot validate: validate with the
    // configuration for the spec it detected.
    AMFValidationReport report2 = APIConfiguration.fromSpec(parsed.sourceSpec()).baseUnitClient().validate(unit).get();
    long t2 = System.nanoTime();

    if (report) {
      System.out.println("spec: " + parsed.sourceSpec().id() + ", parse conforms: " + parsed.conforms() + ", validation conforms: " + report2.conforms());
      List<AMFValidationResult> all = new ArrayList<>(parsed.results());
      all.addAll(report2.results());
      Map<String, Integer> bySeverity = new TreeMap<>();
      for (AMFValidationResult r : all) bySeverity.merge(r.severityLevel(), 1, Integer::sum);
      System.out.println("problems: " + bySeverity);
      all.stream().limit(6).forEach(r -> System.out.println("  - [" + r.severityLevel() + "] " + oneLine(r.message())
          + "  @ " + r.location().map(Main::shortLoc).orElse("?") + " " + r.position()));

      if (unit instanceof Document) {
        DomainElement enc = ((Document) unit).encodes();
        if (enc instanceof Api) {
          List<EndPoint> eps = ((Api<?>) enc).endPoints();
          System.out.println("endpoints: " + eps.size());
          for (EndPoint ep : eps.subList(0, Math.min(3, eps.size()))) {
            System.out.println("  " + ep.path().value() + "  @ " + ep.annotations().location().map(Main::shortLoc).orElse("?") + " " + ep.annotations().lexical()
                + "  operations: " + ep.operations().size());
          }
        }
      }
      // A declaration from a library file: does it point into that file?
      for (BaseUnit ref : unit.references()) {
        if (ref instanceof DeclaresModel && !((DeclaresModel) ref).declares().isEmpty()) {
          DomainElement d = ((DeclaresModel) ref).declares().get(0);
          System.out.println("library declaration @ " + d.annotations().location().map(Main::shortLoc).orElse("?") + " " + d.annotations().lexical()
              + "  (" + ((DeclaresModel) ref).declares().size() + " declarations in " + shortLoc(ref.location()) + ")");
          break;
        }
      }
      System.out.println("references (files AMF loaded): " + countRefs(unit, new HashSet<>()));
    }
    return new long[] { (t1 - t0) / 1_000_000, (t2 - t1) / 1_000_000 };
  }

  static int countRefs(BaseUnit u, Set<String> seen) {
    for (BaseUnit r : u.references()) if (seen.add(r.location())) countRefs(r, seen);
    return seen.size();
  }

  static String shortLoc(String loc) { int i = loc.indexOf("spec-"); return i < 0 ? loc : loc.substring(loc.indexOf('/', i) + 1); }
  static String oneLine(String s) { s = s.replaceAll("\\s+", " "); return s.length() > 140 ? s.substring(0, 140) + "…" : s; }

  /** Unzip into a temp dir. Exchange zips can hold the same entry twice: last one wins. */
  static Path extract(Path zip) throws Exception {
    Path dir = Files.createTempDirectory("spec-");
    int dupes = 0;
    Set<String> seen = new HashSet<>();
    try (ZipInputStream in = new ZipInputStream(Files.newInputStream(zip))) {
      for (ZipEntry e; (e = in.getNextEntry()) != null; ) {
        if (e.isDirectory()) continue;
        if (!seen.add(e.getName())) dupes++;
        Path out = dir.resolve(e.getName()).normalize();
        Files.createDirectories(out.getParent());
        Files.copy(in, out, StandardCopyOption.REPLACE_EXISTING);
      }
    }
    if (dupes > 0) System.out.println("(zip had " + dupes + " duplicate entr" + (dupes == 1 ? "y" : "ies") + ")");
    return dir;
  }
}
