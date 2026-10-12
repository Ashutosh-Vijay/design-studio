// Runs amf-custom-validator (Go compiled to WebAssembly, the engine Design Center's own governance worker
// uses) off the main thread: a big API takes a minute or more. Big graphs go in pieces (govchunk.ts).
import acv from '@aml-org/amf-custom-validator-web';
import { pieces } from './govchunk';

type Job = { profiles: { name: string; text: string }[]; graph: string };
type Res = { sourceShapeName: string; resultSeverity: string; resultMessage: string; focusNode: string };
let ready: Promise<void> | null = null;

self.onmessage = async (e: MessageEvent<Job>) => {
  try {
    ready ??= new Promise<void>((res, rej) => acv.initialize((err?: Error) => (err ? rej(err) : res())));
    await ready;
    const parts = pieces(e.data.graph);
    const found = new Map<string, { ruleset: string; rule: string; level: string; message: string; focus: string }>();
    let done = 0;
    const total = parts.length * e.data.profiles.length;
    for (const p of e.data.profiles) for (const part of parts) {
      const report = await new Promise<string>((res, rej) => acv.validate(p.text, part, false, (r: string, err?: Error) => (err ? rej(err) : res(r))));
      const top = JSON.parse(report);
      const enc = (Array.isArray(top) ? top[0] : top)['doc:encodes'];
      for (const x of ((Array.isArray(enc) ? enc[0] : enc)?.result ?? []) as Res[]) {
        const level = /Violation/.test(x.resultSeverity) ? 'violation' : /Warning/.test(x.resultSeverity) ? 'warning' : 'info';
        found.set(`${p.name}|${x.sourceShapeName}|${x.focusNode}|${x.resultMessage}`, { ruleset: p.name, rule: x.sourceShapeName, level, message: x.resultMessage, focus: x.focusNode });
      }
      postMessage({ progress: ++done / total });
    }
    postMessage({ results: [...found.values()] });
  } catch (err) {
    postMessage({ error: String(err) });
  }
};
