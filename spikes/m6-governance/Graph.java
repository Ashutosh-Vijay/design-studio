// Spike: the API's AMF graph as JSON-LD, the input amf-custom-validator takes.
//   java -cp "amf-server/target/amf-server-0.1-shaded.jar;spikes/m6-governance/out" Graph <api root file> <out.jsonld> [pipeline]
import amf.apicontract.client.platform.AMFConfiguration;
import amf.apicontract.client.platform.APIConfiguration;
import amf.core.client.common.transform.PipelineId;
import amf.core.client.platform.AMFParseResult;
import amf.core.client.platform.config.RenderOptions;
import amf.core.client.platform.model.document.BaseUnit;
import java.nio.file.*;

public class Graph {
  public static void main(String[] a) throws Exception {
    String s = Path.of(a[0]).toAbsolutePath().normalize().toString().replace('\\', '/');
    AMFParseResult p = APIConfiguration.API().baseUnitClient().parse(s.startsWith("/") ? "file://" + s : "file:///" + s).get();
    AMFConfiguration cfg = APIConfiguration.fromSpec(p.sourceSpec()).withRenderOptions((System.getenv("COMPACT") != null ? new RenderOptions().withCompactUris().withSourceMaps() : new RenderOptions().withoutSourceMaps()));
    String pipeline = a.length > 2 ? a[2] : "editing";
    BaseUnit u = pipeline.equals("none") ? p.baseUnit() : cfg.baseUnitClient().transform(p.baseUnit(), pipeline.equals("default") ? PipelineId.Default() : PipelineId.Editing()).baseUnit();
    String ld = cfg.baseUnitClient().render(u, "application/ld+json");
    Files.writeString(Path.of(a[1]), ld);
    System.out.println("pipeline " + pipeline + ", " + ld.length() + " chars");
  }
}
