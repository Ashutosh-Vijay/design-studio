// Spike: can the bundled AMF (JVM) run an Anypoint governance ruleset (a Validation Profile 1.0 document)?
//   javac -cp amf-server/target/amf-server-0.1-shaded.jar -d spikes/m6-governance/out spikes/m6-governance/Gov.java
//   java -cp "amf-server/target/amf-server-0.1-shaded.jar;spikes/m6-governance/out" Gov <ruleset.yaml> <api root file>
// Parses the ruleset with AMF's built-in Validation Profile dialect, registers it under the spec's own profile
// name, validates the API with it, and prints each result's rule, severity and message.
import amf.apicontract.client.scala.AMFConfiguration;
import amf.apicontract.client.scala.APIConfiguration$;
import amf.aml.client.scala.model.document.DialectInstance;
import amf.aml.internal.validate.custom.ParsedValidationProfile;
import amf.core.client.common.validation.ProfileName;
import amf.core.client.scala.AMFParseResult;
import amf.core.client.scala.validation.AMFValidationReport;
import amf.core.client.scala.validation.AMFValidationResult;
import amf.core.internal.validation.core.ValidationProfile;
import scala.concurrent.Await;
import scala.concurrent.duration.Duration;
import java.nio.file.Path;

public class Gov {
  static String url(String p) { String s = Path.of(p).toAbsolutePath().normalize().toString().replace('\\', '/'); return s.startsWith("/") ? "file://" + s : "file:///" + s; }
  public static void main(String[] a) throws Exception {
    AMFConfiguration api = APIConfiguration$.MODULE$.API();
    long t0 = System.nanoTime();
    AMFParseResult prof = Await.result(api.baseUnitClient().parse(url(a[0])), Duration.Inf());
    System.out.println("ruleset parsed as " + prof.baseUnit().getClass().getSimpleName() + ", problems: " + prof.results().size());
    for (int i = 0; i < Math.min(5, prof.results().size()); i++) System.out.println("  ruleset problem: " + prof.results().apply(i).message());
    ValidationProfile vp = ParsedValidationProfile.apply((amf.aml.client.scala.model.domain.DialectDomainElement) ((DialectInstance) prof.baseUnit()).encodes());
    System.out.println("profile '" + vp.name().profile() + "', " + vp.validations().size() + " validations");
    AMFParseResult spec = Await.result(api.baseUnitClient().parse(url(a[1])), Duration.Inf());
    ProfileName specProfile = spec.sourceSpec().id().startsWith("RAML") ? amf.core.client.common.validation.ProfileNames$.MODULE$.RAML10() : amf.core.client.common.validation.ProfileNames$.MODULE$.OAS30();
    System.out.println("spec " + spec.sourceSpec().id() + ", parse problems: " + spec.results().size());
    ValidationProfile asSpec = vp.copy(specProfile, vp.baseProfile(), vp.validations(), vp.severities(), vp.prefixes());
    AMFConfiguration cfg = APIConfiguration$.MODULE$.fromSpec(spec.sourceSpec()).withValidationProfile(asSpec);
    AMFValidationReport r = Await.result(cfg.baseUnitClient().validate(spec.baseUnit()), Duration.Inf());
    System.out.println("results: " + r.results().size() + " in " + (System.nanoTime() - t0) / 1_000_000 + " ms");
    scala.collection.Iterator<AMFValidationResult> it = r.results().iterator();
    java.util.Map<String, Integer> byRule = new java.util.TreeMap<>();
    while (it.hasNext()) { AMFValidationResult x = it.next(); String id = x.validationId().replaceAll(".*#", ""); byRule.merge(x.severityLevel() + " " + id, 1, Integer::sum); }
    byRule.forEach((k, v) -> System.out.println("  " + v + "x " + k));
  }
}
