// Spike: the ids AMF's Editing pipeline leaves on each unit's elements (root and referenced units).
import amf.apicontract.client.platform.APIConfiguration;
import amf.core.client.common.transform.PipelineId;
import amf.core.client.platform.AMFParseResult;
import amf.core.client.platform.model.document.BaseUnit;
import java.nio.file.Path;
public class Ids {
  public static void main(String[] a) throws Exception {
    String s = Path.of(a[0]).toAbsolutePath().normalize().toString().replace('\\', '/');
    AMFParseResult p = APIConfiguration.API().baseUnitClient().parse(s.startsWith("/") ? "file://" + s : "file:///" + s).get();
    BaseUnit u = APIConfiguration.fromSpec(p.sourceSpec()).baseUnitClient().transform(p.baseUnit(), PipelineId.Editing()).baseUnit();
    print(u, 0);
  }
  static void print(BaseUnit u, int d) {
    System.out.println("  ".repeat(d) + "unit " + u.id().replaceAll(".*/", "") + " " + u.getClass().getSimpleName());
    if (u instanceof amf.core.client.platform.model.document.DeclaresModel dm) for (var x : dm.declares()) System.out.println("  ".repeat(d) + "  declares " + x.id().replaceAll("file:.*maptest/", ""));
    for (BaseUnit r : u.references()) print(r, d + 1);
  }
}
