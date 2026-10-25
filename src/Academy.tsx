// API Design Academy, after DataWeave Studio's: from "what is an API?" to a published, governed spec.
// Reading on the left; on the right a live editor that AMF reads as you type (op "lesson": files held in
// memory, never the open project's), and a check graded on AMF's own model of what you wrote. The course
// is in course.ts and every lesson is run through AMF by scripts/academy-verify.mjs before it ships.
// Lessons are never locked: the order is a suggestion.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { baseExtensions, languageFor } from './editor';
import { PARTS, LESSONS, grade, type Block, type Question, type Lesson, type Model, type Problem } from './course';
import { Icons } from './components/Icons';
import { WindowControls } from './components/WindowControls';
import { Spinner } from './App';

// ---------- Progress (this computer only) ----------
const STORE = 'ads.academy.v2'; // v2: the course was renumbered when it grew
type Progress = { done: Record<string, boolean>; drafts: Record<string, Record<string, string>> };
const load = (): Progress => { try { const p = JSON.parse(localStorage.getItem(STORE) ?? '{}'); return { done: p.done ?? {}, drafts: p.drafts ?? {} }; } catch { return { done: {}, drafts: {} }; } };
const store = (p: Progress) => { try { localStorage.setItem(STORE, JSON.stringify(p)); } catch { /* blocked storage: it just forgets */ } };
export const academyDone = () => { const d = load().done; return LESSONS.filter((l) => d[l.id]).length; };

type Read = { ok: true; problems: Problem[]; model: Model; spec: string } | { ok: false; error: string };
async function readSpec(files: Record<string, string>): Promise<Read> {
  try {
    const r = await invoke<{ problems: Problem[]; model: Model; spec: string }>('amf', { op: 'lesson', args: { main: Object.keys(files)[0], files } });
    // A problem with no place of its own (a missing title) belongs to the root file.
    return { ok: true, ...r, problems: r.problems.map((p) => (p.file ? p : { ...p, file: Object.keys(files)[0], line: Math.max(p.line, 1) })) };
  } catch (e) { return { ok: false, error: String(e).replace(/^amf\.[\w.]+:\s*/, '') }; }
}

const Cap = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 9 12 4 2 9l10 5 10-5Z" /><path d="M6 11v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5" /><path d="M22 9v5" />
  </svg>
);

// `code` and **bold** inside lesson text.
function Rich({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g).map((s, i) =>
    s.startsWith('`') && s.endsWith('`') ? <code key={i} className="font-mono text-[12px] px-1 py-px rounded bg-surface-3 text-content">{s.slice(1, -1)}</code>
      : s.startsWith('**') && s.endsWith('**') ? <strong key={i} className="font-semibold text-content">{s.slice(2, -2)}</strong>
        : s.startsWith('*') && s.endsWith('*') && s.length > 2 ? <em key={i} className="not-italic text-content">{s.slice(1, -1)}</em>
          : <span key={i}>{s}</span>)}</>;
}
function Reading({ body }: { body: Block[] }) {
  return (
    <div className="flex flex-col gap-3 text-[13.5px] leading-relaxed text-content-secondary">
      {body.map((b, i) => 'p' in b ? <p key={i} className="m-0"><Rich text={b.p} /></p>
        : 'h' in b ? <h2 key={i} className="mt-3 mb-0 text-[14.5px] font-semibold text-content">{b.h}</h2>
        : 'table' in b ? (
          <div key={i} className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-[12.5px] leading-snug">
              <thead><tr>{b.table[0].map((c, j) => <th key={j} className="text-left font-semibold text-content px-2.5 py-1.5 bg-surface-2 border-b border-line">{c}</th>)}</tr></thead>
              <tbody>{b.table.slice(1).map((r, j) => <tr key={j} className="border-t border-line first:border-t-0 align-top">{r.map((c, k) => <td key={k} className={`px-2.5 py-1.5 ${k === 0 ? 'text-content' : ''}`}><Rich text={c} /></td>)}</tr>)}</tbody>
            </table>
          </div>)
        : 'list' in b ? <ul key={i} className="m-0 pl-0 list-none flex flex-col gap-1.5">{b.list.map((x, j) => <li key={j} className="flex gap-2"><span className="text-accent">•</span><span><Rich text={x} /></span></li>)}</ul>
          : 'callout' in b ? <div key={i} className="px-3.5 py-2.5 rounded-r-lg border-l-[3px] border-accent bg-accent-dim"><strong className="text-content">{b.callout}. </strong><Rich text={b.text} /></div>
            : 'code' in b ? <pre key={i} className="m-0 p-3 rounded-lg bg-bg border border-line font-mono text-[12px] leading-[1.6] text-content overflow-x-auto">{b.code}</pre>
              : <div key={i} className="flex items-stretch gap-1.5 py-1">{b.steps.map((s, j) => (
                <div key={j} className="flex items-center gap-1.5 flex-1 min-w-0">
                  <div className={`flex-1 text-center text-[11.5px] px-1.5 py-2 rounded-lg border ${j === 0 ? 'border-accent bg-accent-dim text-content' : 'border-line bg-surface-2'}`}>{s}</div>
                  {j < b.steps.length - 1 && <span className="text-accent">→</span>}
                </div>))}</div>)}
    </div>
  );
}
const PaneHead = ({ title, note, right }: { title: string; note?: string; right?: ReactNode }) => (
  <div className="h-9 shrink-0 flex items-center gap-2 px-3.5 border-b border-line bg-surface">
    <span className="text-[12px] font-semibold">{title}</span>{note && <span className="text-[11px] text-content-faint truncate">{note}</span>}<span className="flex-1" />{right}
  </div>
);

// ---------- 1.1: send requests to a pretend library ----------
const CALLS: { m: string; path: string; send?: string; status: string; body: string; note: string }[] = [
  { m: 'GET', path: '/books', status: '200 OK', body: '[\n  { "id": 42, "title": "Dune", "year": 1965 },\n  { "id": 7, "title": "Emma", "year": 1815 }\n]', note: 'Reads the collection: every book.' },
  { m: 'GET', path: '/books/42', status: '200 OK', body: '{ "id": 42, "title": "Dune", "year": 1965 }', note: 'Reads one book, by its id in the path.' },
  { m: 'GET', path: '/books/999', status: '404 Not Found', body: '{ "message": "There\'s no book with id 999" }', note: 'Nothing there. The request was fine; the book isn\'t.' },
  { m: 'POST', path: '/books', send: '{ "title": "Beloved", "year": 1987 }', status: '201 Created', body: '{ "id": 43, "title": "Beloved", "year": 1987 }', note: 'Creates a new book. The answer gives it an id.' },
  { m: 'POST', path: '/books', send: '{ "year": "soon" }', status: '400 Bad Request', body: '{ "message": "title is required; year must be a number" }', note: 'The request itself was wrong, so nothing was created.' },
  { m: 'DELETE', path: '/books/42', status: '204 No Content', body: '', note: 'Removed. 204 means it worked and there\'s nothing more to say.' },
];
const METHOD_COLOR: Record<string, string> = { GET: 'var(--ok)', POST: 'var(--accent)', DELETE: 'var(--err)' };
function HttpExplorer() {
  const [i, setI] = useState<number | null>(null);
  const c = i == null ? null : CALLS[i];
  return (
    <div className="flex flex-col min-h-0 h-full">
      <PaneHead title="A pretend library API" note="click a request to send it" />
      <div className="p-3.5 flex flex-col gap-1.5 border-b border-line">
        {CALLS.map((x, j) => (
          <button key={j} onClick={() => setI(j)} className={`flex items-center gap-2.5 px-3 py-1.5 rounded-md border text-left font-mono text-[12px] ${i === j ? 'border-accent bg-accent-dim' : 'border-line bg-surface hover:border-accent-border'}`}>
            <span className="w-[54px] font-semibold" style={{ color: METHOD_COLOR[x.m] }}>{x.m}</span><span className="text-content">{x.path}</span>
            {x.send && <span className="text-content-faint truncate">{x.send}</span>}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3.5">
        {c ? <>
          <div className="text-[11px] uppercase tracking-[0.5px] text-content-faint mb-1">Response</div>
          <div className="font-mono text-[13px] font-semibold" style={{ color: c.status.startsWith('2') ? 'var(--ok)' : 'var(--warn)' }}>{c.status}</div>
          {c.body && <pre className="mt-2 mb-0 p-3 rounded-lg bg-bg border border-line font-mono text-[12px] text-content">{c.body}</pre>}
          <p className="mt-2.5 mb-0 text-[12.5px] text-content-secondary">{c.note}</p>
        </> : <span className="text-[12.5px] text-content-faint">The response shows here.</span>}
      </div>
    </div>
  );
}

// ---------- The live editor, and what AMF reads from it ----------
function SpecEditor({ files, readOnly, onChange, problems }: { files: Record<string, string>; readOnly: boolean; onChange: (path: string, text: string) => void; problems: Problem[] }) {
  const paths = Object.keys(files);
  const [tab, setTab] = useState(paths[0]);
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const change = useRef(onChange); change.current = onChange;
  const make = (path: string) => EditorState.create({ doc: files[path], extensions: [...baseExtensions(), languageFor(path), EditorState.readOnly.of(readOnly),
    EditorView.updateListener.of((u) => { if (u.docChanged) change.current(path, u.state.doc.toString()); })] });
  useEffect(() => {
    view.current = new EditorView({ state: make(paths[0]), parent: host.current! });
    return () => view.current?.destroy();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const show = (path: string) => {
    const v = view.current!; states.current.set(tab, v.state);
    v.setState(states.current.get(path) ?? make(path)); setTab(path);
  };
  // AMF's problems as underlines, for the file on show.
  useEffect(() => {
    const v = view.current; if (!v) return;
    const doc = v.state.doc;
    const diags: Diagnostic[] = problems.filter((p) => p.file === tab).map((p) => {
      const l = doc.line(Math.min(Math.max(p.line, 1), doc.lines)), from = Math.min(l.from + p.col, l.to);
      return { from, to: Math.max(from + 1, l.to), severity: (p.severity === 'error' ? 'error' : 'warning') as Diagnostic['severity'], message: p.message };
    }).filter((d) => d.to <= doc.length);
    v.dispatch(setDiagnostics(v.state, diags));
  }, [problems, tab]);
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-line bg-surface">
        {paths.map((p) => <button key={p} onClick={() => p !== tab && show(p)} className={`h-7 px-2.5 rounded-md font-mono text-[11.5px] ${tab === p ? 'bg-accent-dim text-accent' : 'text-content-faint hover:text-content'}`}>{p}</button>)}
        <span className="flex-1" />{readOnly && <span className="flex items-center gap-1 text-[11px] text-content-faint"><Icons.Lock size={11} />example</span>}
      </div>
      <div ref={host} className="flex-1 min-h-0 overflow-hidden [&_.cm-editor]:h-full" />
    </div>
  );
}
function AmfReads({ read, busy }: { read: Read | null; busy: boolean }) {
  const errors = read?.ok ? read.problems.filter((p) => p.severity === 'error') : [];
  const m = read?.ok ? read.model : null;
  return (
    <div className="h-[38%] min-h-[150px] shrink-0 flex flex-col border-t border-line bg-bg">
      <PaneHead title="What AMF reads" right={busy ? <Spinner /> : read?.ok ? <span className="text-[11px] font-mono" style={{ color: errors.length ? 'var(--err)' : 'var(--ok)' }}>{errors.length ? `${errors.length} ${errors.length === 1 ? 'error' : 'errors'}` : 'valid'}</span> : null} />
      <div className="flex-1 min-h-0 overflow-auto px-3.5 py-2.5 font-mono text-[11.5px] leading-[1.7] select-text">
        {!read ? <span className="text-content-faint font-sans">Reading…</span>
          : !read.ok ? <span className="text-err font-sans">The engine isn't ready: {read.error}</span>
            : <>
              {read.problems.map((p, i) => <div key={i} style={{ color: p.severity === 'error' ? 'var(--err)' : 'var(--warn)' }}>{p.file}:{p.line} {p.message}</div>)}
              {m?.title && <div className="text-content">{m.title.v}{m.version ? <span className="text-content-faint"> · {m.version.v}</span> : null}{m.securedBy?.length ? <span className="text-content-faint"> · secured by {m.securedBy.join(', ')}</span> : null}</div>}
              {(m?.endpoints ?? []).map((e) => (
                <div key={e.path}>
                  <span className="text-content">{e.path}</span>
                  {e.resourceType && <span className="text-content-faint"> type {e.resourceType}</span>}
                  {e.is?.length ? <span className="text-content-faint"> is {e.is.join(', ')}</span> : null}
                  {e.params?.length ? <span className="text-content-faint"> {'{'}{e.params.map((p) => `${p.name}: ${p.type}`).join(', ')}{'}'}</span> : null}
                  {e.operations.map((o) => <span key={o.method} className="ml-2.5"><span style={{ color: METHOD_COLOR[o.method.toUpperCase()] ?? 'var(--violet)' }}>{o.method.toUpperCase()}</span>{o.responses.length ? <span className="text-content-faint"> {o.responses.map((r) => r.code + (r.body[0]?.type ? ` ${r.body[0].type}` : '')).join(', ')}</span> : null}{o.is.length ? <span className="text-content-faint"> is {o.is.join(', ')}</span> : null}</span>)}
                </div>
              ))}
              {([['traits', m?.traits], ['resource types', m?.resourceTypes], ['security schemes', m?.schemes?.map((x) => x.type ? `${x.name} (${x.type})` : x.name)], ['annotation types', m?.annotationTypes]] as const).map(([k, v]) => v?.length ? <div key={k}><span className="text-content-faint">{k}: </span><span className="text-content">{v.join(', ')}</span></div> : null)}
              {(m?.types ?? []).map((t) => <div key={t.name + (t.at?.file ?? '')}><span className="text-[var(--syn-type)]">{t.name}</span><span className="text-content-faint"> {t.properties?.length ? `{ ${t.properties.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join(', ')} }` : t.type}</span></div>)}
              {!read.problems.length && !m?.title && !(m?.endpoints ?? []).length && <span className="text-content-faint font-sans">Nothing yet.</span>}
            </>}
      </div>
    </div>
  );
}

// One question and its options: a lesson's choice, or one of a quiz's questions.
function Choices({ q, label, picked, onPick }: { q: Question; label: string; picked?: number; onPick: (i: number) => void }) {
  return <>
    <div className="text-[13px] font-semibold mb-2.5 text-content"><Rich text={`${label}${q.question}`} /></div>
    <div className="flex flex-col gap-1.5">
      {q.options.map((o, i) => (
        <button key={i} onClick={() => onPick(i)} className="w-full text-left px-3 py-2 rounded-lg border text-[12.5px]"
          style={{ borderColor: picked === i ? (o.correct ? 'var(--ok)' : 'var(--err)') : 'var(--line)', background: picked === i ? 'var(--surface)' : 'transparent' }}>
          <Rich text={o.text} />
          {picked === i && <div className="mt-1 text-[12px]" style={{ color: o.correct ? 'var(--ok)' : 'var(--err)' }}>{o.correct ? '✓ ' : ''}<Rich text={o.why} /></div>}
        </button>
      ))}
    </div>
  </>;
}

// ---------- A lesson ----------
function LessonView({ lesson, index, done, draft, onDraft, onDone, onPrev, onNext, onFinish }: {
  lesson: Lesson; index: number; done: boolean; draft?: Record<string, string>;
  onDraft: (files: Record<string, string>) => void; onDone: () => void; onPrev?: () => void; onNext?: () => void; onFinish: () => void;
}) {
  const check = lesson.check;
  const [files, setFiles] = useState<Record<string, string>>(() => ({ ...lesson.files, ...(draft ?? {}) }));
  const [read, setRead] = useState<Read | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<number | undefined>();
  const [picks, setPicks] = useState<Record<number, number>>({});
  const quizRight = check.kind === 'quiz' ? check.questions.filter((q, i) => q.options[picks[i]]?.correct).length : 0;
  const pick = (qi: number, i: number) => {
    if (check.kind !== 'quiz') return;
    const next = { ...picks, [qi]: i }; setPicks(next);
    if (check.questions.every((q, j) => q.options[next[j]]?.correct)) onDone();
  };
  const [result, setResult] = useState<ReturnType<typeof grade> | null>(null);
  const [hints, setHints] = useState(0);
  const hasEditor = Object.keys(lesson.files).length > 0;
  // AMF reads as you type (a beat after the last key).
  useEffect(() => {
    if (!hasEditor) return;
    setBusy(true);
    let live = true;
    const t = setTimeout(async () => { const r = await readSpec(files); if (live) { setRead(r); setBusy(false); } }, read ? 450 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [files]); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = (path: string, text: string) => {
    const next = { ...files, [path]: text };
    setFiles(next); setResult(null);
    if (!lesson.readOnly) onDraft(next);
  };
  const submit = async () => {
    if (check.kind !== 'build') return;
    setBusy(true);
    const r = await readSpec(files); setRead(r); setBusy(false);
    if (!r.ok) return;
    const g = grade(check.goals, r.model, r.spec, r.problems);
    setResult(g);
    if (g.passed) onDone();
  };
  const reset = () => { setFiles({ ...lesson.files }); onDraft({}); setResult(null); };
  const total = LESSONS.length;
  return (
    <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: 'minmax(340px, 42%) minmax(0, 1fr)' }}>
      <section className="flex flex-col min-h-0 border-r border-line bg-surface">
        <div className="flex-1 overflow-auto px-7 py-6">
          <div className="flex gap-1 mb-5">{LESSONS.map((l, i) => <i key={l.id} className="flex-1 h-1 rounded-full" style={{ background: i < index || (i === index && done) ? 'var(--accent)' : i === index ? 'var(--accent-border)' : 'var(--surface-3)' }} />)}</div>
          <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-accent">Lesson {lesson.id} · {index + 1} of {total} · about {lesson.minutes} min</div>
          <h1 className="mt-1.5 mb-4 text-[22px] font-semibold tracking-tight">{lesson.title}</h1>
          <Reading body={lesson.body} />
          {check.kind === 'quiz' && <div className="mt-7 pt-5 border-t border-line flex flex-col gap-6">
            {check.questions.map((q, qi) => <div key={qi}><Choices q={q} label={`${qi + 1}. `} picked={picks[qi]} onPick={(i) => pick(qi, i)} /></div>)}
          </div>}
        </div>
        <div className="border-t border-line px-7 py-4 bg-surface-2">
          {check.kind === 'choice' ? <Choices q={check} label="Check: " picked={picked} onPick={(i) => { setPicked(i); if (check.options[i].correct) onDone(); }} />
          : check.kind === 'quiz' ? (
            <div className="flex items-center gap-3 text-[12.5px]">
              <span className="font-semibold">Check: {check.questions.length} questions above</span>
              <span style={{ color: quizRight === check.questions.length ? 'var(--ok)' : 'var(--content-faint)' }}>{quizRight === check.questions.length ? '✓ All right' : `${quizRight} of ${check.questions.length} right`}</span>
            </div>
          ) : <>
            <div className="text-[13px] font-semibold"><Rich text={`Check: ${check.prompt}`} /></div>
            <div className="flex items-center gap-3 mt-2.5 flex-wrap">
              <button onClick={submit} disabled={busy} className="h-8 px-3.5 rounded-lg text-[12.5px] font-semibold bg-accent text-accent-ink disabled:opacity-50">{busy && result === null ? 'Checking…' : 'Check my design'}</button>
              {hints < check.hints.length && <button onClick={() => setHints(hints + 1)} className="text-[12px] text-content-faint hover:text-content">Show a hint</button>}
              {draft && Object.keys(draft).length > 0 && <button onClick={reset} className="text-[12px] text-content-faint hover:text-content">Start over</button>}
              {result?.passed && <span className="text-[12.5px] text-[var(--ok)]">✓ AMF agrees: it's all there.</span>}
            </div>
            {hints > 0 && <div className="mt-2.5 flex flex-col gap-1 text-[12px] text-content-secondary">{check.hints.slice(0, hints).map((h, i) => <div key={i}>Hint {i + 1}: <Rich text={h} /></div>)}</div>}
            {result && !result.passed && (
              <div className="mt-2.5 flex flex-col gap-1 text-[12px]">
                {result.errors.length > 0 && <div className="text-err">AMF reports {result.errors.length === 1 ? 'an error' : `${result.errors.length} errors`}: {result.errors[0].file}, line {result.errors[0].line}: {result.errors[0].message}</div>}
                {check.goals.map((g, i) => <div key={i} style={{ color: result.results[i] ? 'var(--ok)' : 'var(--content-faint)' }}>{result.results[i] ? '✓' : '○'} {g.say}</div>)}
              </div>
            )}
          </>}
        </div>
        <div className="flex justify-between gap-3 px-7 py-2.5 border-t border-line bg-surface">
          <button onClick={onPrev} disabled={!onPrev} className="h-8 px-3 rounded-lg border border-line text-[12.5px] disabled:opacity-40">‹ Previous</button>
          <button onClick={onNext ?? onFinish} className={`h-8 px-3 min-w-0 truncate rounded-lg text-[12.5px] font-semibold ${done ? 'bg-accent text-accent-ink' : 'border border-line text-content-secondary'}`}>
            {onNext ? `Next: ${LESSONS[index + 1].id} ${LESSONS[index + 1].title} ›` : 'Create your own project ›'}
          </button>
        </div>
      </section>
      <section className="flex flex-col min-h-0 min-w-0 bg-bg">
        {lesson.http ? <HttpExplorer /> : lesson.aside ? <>
          <PaneHead title={lesson.aside.title} />
          <div className="flex-1 min-h-0 overflow-auto px-6 py-5"><Reading body={lesson.aside.body} /></div>
        </> : <>
          <SpecEditor key={lesson.id} files={files} readOnly={!!lesson.readOnly} onChange={edit} problems={read?.ok ? read.problems : []} />
          <AmfReads read={read} busy={busy} />
        </>}
      </section>
    </div>
  );
}

// ---------- The screen ----------
export function AcademyScreen({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const [progress, setProgress] = useState<Progress>(load);
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key !== 'Escape' || e.defaultPrevented) return; if (at !== null) setAt(null); else onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [at, onClose]);
  const update = (p: Progress) => { setProgress(p); store(p); };
  const doneCount = LESSONS.filter((l) => progress.done[l.id]).length;
  const next = Math.max(0, LESSONS.findIndex((l) => !progress.done[l.id]));
  const lesson = at !== null ? LESSONS[at] : null;
  const minutes = useMemo(() => LESSONS.reduce((t, l) => t + l.minutes, 0), []);
  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-bg text-content">
      <header data-tauri-drag-region className="h-11 shrink-0 flex items-center gap-3 pl-3 bg-surface border-b border-line">
        <button onClick={() => (lesson ? setAt(null) : onClose())} title="Back (Esc)" className="h-7 pl-1.5 pr-2.5 flex items-center gap-1 rounded-md text-[12px] text-content-muted hover:bg-surface-2 hover:text-content">
          <Icons.ArrowLeft size={14} />{lesson ? 'All lessons' : 'Back'}</button>
        <span className="w-px h-4 bg-line" />
        <span className="text-accent"><Cap /></span>
        <span data-tauri-drag-region className="text-[13px] font-semibold">API Design Academy</span>
        <span data-tauri-drag-region className="text-[11.5px] text-content-faint truncate">{lesson ? `${lesson.id} ${lesson.title}` : `${LESSONS.length} lessons · about ${minutes} minutes`}</span>
        <span data-tauri-drag-region className="flex-1 h-full" />
        <WindowControls />
      </header>
      {lesson && at !== null ? (
        <LessonView key={lesson.id} lesson={lesson} index={at} done={!!progress.done[lesson.id]} draft={progress.drafts[lesson.id]}
          onDraft={(f) => update({ ...progress, drafts: { ...progress.drafts, [lesson.id]: f } })}
          onDone={() => { if (!progress.done[lesson.id]) update({ ...progress, done: { ...progress.done, [lesson.id]: true } }); }}
          onPrev={at > 0 ? () => setAt(at - 1) : undefined} onNext={at < LESSONS.length - 1 ? () => setAt(at + 1) : undefined} onFinish={onCreate} />
      ) : (
        <main className="flex-1 overflow-auto">
          <div className="max-w-[1080px] mx-auto px-8 pt-8 pb-16">
            <section className="grid gap-6 items-end pb-6 border-b border-line" style={{ gridTemplateColumns: '1fr auto' }}>
              <div>
                <h1 className="m-0 text-[28px] font-semibold tracking-tight">Learn API design from zero</h1>
                <p className="mt-1.5 mb-0 max-w-[640px] text-[13.5px] text-content-secondary leading-relaxed">Start with what an API is. Go through all of RAML (types, resource types, traits, security schemes, fragments, libraries), then Design Center, Exchange, APIkit and API Manager, as far as the MuleSoft Developer I and II exams ask. Every lesson has something to try or answer, and AMF, the engine Design Center uses, checks what you write.</p>
              </div>
              <div className="min-w-[260px] p-4 rounded-xl border border-line bg-surface">
                <div className="text-[22px] font-bold">{doneCount} of {LESSONS.length}</div>
                <div className="text-[12px] text-content-faint">lessons done</div>
                <div className="h-1.5 my-2.5 rounded-full bg-surface-3 overflow-hidden"><div className="h-full bg-accent" style={{ width: `${(doneCount / LESSONS.length) * 100}%` }} /></div>
                <button onClick={() => (doneCount === LESSONS.length ? onCreate() : setAt(next))} className="w-full h-9 rounded-lg text-[12.5px] font-semibold bg-accent text-accent-ink">
                  {doneCount === 0 ? 'Start with 1.1' : doneCount === LESSONS.length ? 'Create your own project' : `Continue: ${LESSONS[next].id} ${LESSONS[next].title}`}
                </button>
              </div>
            </section>
            {PARTS.map((part) => (
              <section key={part.title} className="mt-7">
                <div className="flex items-baseline gap-2.5 mb-3"><h2 className="m-0 text-[15px] font-semibold">{part.title}</h2><span className="text-[12px] text-content-faint">{part.note}</span></div>
                <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                  {part.lessons.map((l) => {
                    const i = LESSONS.indexOf(l), d = progress.done[l.id], cur = !d && i === next;
                    return (
                      <button key={l.id} onClick={() => setAt(i)} className="text-left p-3 rounded-xl border bg-surface hover:border-accent-border"
                        style={cur ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 3px var(--accent-dim)' } : { borderColor: 'var(--line)' }}>
                        <div className="text-[11px] font-mono text-content-faint">{l.id}{d && <span className="text-[var(--ok)]">  ✓ done</span>}{cur && <span className="text-accent">  → next</span>}</div>
                        <div className="mt-0.5 text-[13px] font-semibold">{l.title}</div>
                        <div className="mt-1 text-[11.5px] text-content-faint">{l.minutes} min · {l.check.kind === 'build' ? 'design it, AMF checks' : l.check.kind === 'quiz' ? `${l.check.questions.length} questions` : 'a quick question'}</div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </main>
      )}
    </div>
  );
}
