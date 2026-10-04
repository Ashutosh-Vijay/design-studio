// Shared layout and measurement harness for the M0.4 editor comparison.
// Each page builds the same thing with its own editor and exposes the same
// adapter, so the numbers are like for like.

export type Adapter = {
  /** Insert text at the end of a given line (1-based) as if typed. */
  typeAt(line: number, text: string): void;
  /** Scroll the big editor so this line is at the top. */
  scrollToLine(line: number): void;
  lineCount(): number;
  /** The YAML key path at the cursor, as the breadcrumb shows it. */
  breadcrumb(): string;
  /** Put the cursor at line/column (1-based line, 0-based column). */
  setCursor(line: number, col: number): void;
  /** Open completion at the cursor and return the labels shown. */
  completionLabels(): Promise<string[]>;
};

export async function loadSpec() {
  const [text, outline, problems] = await Promise.all([
    fetch('/main.raml').then((r) => r.text()),
    fetch('/outline.json').then((r) => r.json()),
    fetch('/problems.json').then((r) => r.json()),
  ]);
  return { text, outline, problems } as {
    text: string;
    outline: { types: { label: string; detail: string }[]; traits: string[] };
    problems: { line: number; from: number; to: number; message: string; severity: string }[];
  };
}

/** Big editor on the left, a draggable splitter, ten small editors on the right. */
export function layout(title: string) {
  document.body.innerHTML = `
    <header><b>${title}</b> <a href="/monaco.html">Monaco</a> <a href="/cm.html">CodeMirror 6</a>
      <span id="crumb"></span><span id="metrics"></span></header>
    <main>
      <section id="big"></section>
      <div id="split"></div>
      <section id="small">${Array.from({ length: 10 }, (_, i) => `<label>Field ${i + 1}<div class="mini" id="mini${i}"></div></label>`).join('')}</section>
    </main>`;
  const split = document.getElementById('split')!;
  const big = document.getElementById('big')!;
  split.addEventListener('pointerdown', (e) => {
    split.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => { big.style.flexBasis = `${ev.clientX}px`; };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', () => split.removeEventListener('pointermove', move), { once: true });
  });
  return {
    big,
    minis: Array.from({ length: 10 }, (_, i) => document.getElementById(`mini${i}`)!),
    setCrumb: (s: string) => { document.getElementById('crumb')!.textContent = s; },
  };
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** Runs the same measurements on any adapter and shows and returns them. */
export async function measure(a: Adapter, created: { bigMs: number; minisMs: number }) {
  const m: Record<string, number | string> = { ...created };
  // Typing: 200 single-character inserts, one per frame, in the middle of the file.
  const mid = Math.floor(a.lineCount() / 2);
  let worst = 0, total = 0;
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    a.typeAt(mid, 'x');
    await frame();
    const dt = performance.now() - t0;
    total += dt; worst = Math.max(worst, dt);
  }
  m.typeAvgMs = +(total / 200).toFixed(1);
  m.typeWorstMs = +worst.toFixed(1);
  // Scrolling: jump through the file 40 lines at a time, one jump per frame.
  total = 0; worst = 0; let n = 0;
  for (let l = 1; l < a.lineCount(); l += 40, n++) {
    const t0 = performance.now();
    a.scrollToLine(l);
    await frame();
    const dt = performance.now() - t0;
    total += dt; worst = Math.max(worst, dt);
  }
  m.scrollAvgMs = +(total / n).toFixed(1);
  m.scrollWorstMs = +worst.toFixed(1);
  // Breadcrumb (cursor context) cost, at 20 places through the file.
  total = 0;
  for (let i = 0; i < 20; i++) {
    a.setCursor(Math.floor((a.lineCount() / 20) * i) + 1, 6);
    const t0 = performance.now();
    a.breadcrumb();
    total += performance.now() - t0;
  }
  m.crumbAvgMs = +(total / 20).toFixed(2);
  // Completion after `type: ` on the broken line 65 (a real type position).
  a.setCursor(65, 0);
  m.heapMB = (performance as any).memory ? Math.round((performance as any).memory.usedJSHeapSize / 1048576) : 'n/a';
  document.getElementById('metrics')!.textContent = Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · ');
  (window as any).__metrics = m;
  return m;
}
