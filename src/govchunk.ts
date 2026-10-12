// Governance on big specs (PLAN 10.15): amf-custom-validator runs out of WebAssembly memory (about 2 GB) on
// a graph much over 4 MB, so a big API is validated in pieces. The graph is flat (nodes linked by @id); a
// piece keeps the document, its declarations and the API node with some of its endpoints, and only the
// nodes those reach. Results are merged later by rule and element, so API-level and declaration results
// that every piece reports count once.
type Node = Record<string, unknown> & { '@id'?: string; '@type'?: string | string[] };

export function pieces(graph: string, maxChars = 1_800_000): string[] {
  if (graph.length <= maxChars) return [graph];
  const top = JSON.parse(graph) as Node | Node[];
  const doc = (Array.isArray(top) ? top[0] : top) as Node & { '@graph': Node[] };
  const nodes = doc['@graph'];
  const byId = new Map(nodes.map((n) => [n['@id'] as string, n]));
  const isType = (n: Node, t: string) => [].concat(n['@type'] as never).includes(t as never);
  const api = nodes.find((n) => isType(n, 'apiContract:WebAPI') || isType(n, 'apiContract:AsyncAPI'));
  const root = nodes.find((n) => isType(n, 'doc:Document'));
  const eps = (api?.['apiContract:endpoint'] ?? []) as { '@id': string }[];
  if (!api || !root || eps.length < 2) return [graph];
  const count = Math.min(eps.length, Math.ceil(graph.length / maxChars) + 1);
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    const mine = eps.filter((_, i) => i % count === k);
    const apiPart = { ...api, 'apiContract:endpoint': mine };
    // The first piece carries every declaration (so rules on unused types still run once); the others only
    // what their endpoints reach.
    const rootPart = k === 0 ? root : { ...root, 'doc:declares': [] };
    // Everything reachable from the document (and the processing data), through any {"@id"} value.
    const keep = new Map<string, Node>();
    const todo: Node[] = [root, ...nodes.filter((n) => isType(n, 'doc:APIContractProcessingData'))];
    const visit = (v: unknown) => {
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (v && typeof v === 'object') {
        const id = (v as Node)['@id'];
        if (typeof id === 'string' && Object.keys(v).length === 1) { const n = id === api['@id'] ? apiPart : byId.get(id); if (n && !keep.has(id)) { keep.set(id, n); todo.push(n); } return; }
        Object.values(v).forEach(visit);
      }
    };
    for (const r of todo.splice(0)) { const n = r === root ? rootPart : r; keep.set(r['@id'] as string, n); todo.push(n); }
    while (todo.length) { const n = todo.pop()!; for (const [key, v] of Object.entries(n)) if (key !== '@id' && key !== '@type') visit(v); }
    const piece = { ...doc, '@graph': [...keep.values()] };
    out.push(JSON.stringify(Array.isArray(top) ? [piece] : piece));
  }
  return out;
}
