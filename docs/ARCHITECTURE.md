# Design Studio: architecture

Status: **agreed design before M1** (2026-10-05). Built on the facts proven in M0 (PLAN.md sections 10.2 to 10.4). Where this document and the code disagree later, update this document in the same change.

---

## 1. Shape

```
┌──────────────── Tauri app ─────────────────────────────────────────────┐
│  Webview (React + TypeScript + CodeMirror 6)                           │
│   - UI, editors, tree, problems, forms, graph                          │
│   - edit operations (pure TS, return text edits)                       │
│   - fast YAML parse for positions (`yaml` CST)                         │
│        │ invoke / events                                               │
│  Rust core                                                             │
│   - project + virtual file system (the open project's files, dirty set)│
│   - disk IO, zip import, file watcher                                  │
│   - amf-server process manager                                         │
│   - (M3) OS keychain, Anypoint HTTP client, lock keep-alive, loopback  │
│        │ stdin/stdout JSON lines                                       │
│  amf-server (Java 17, AMF 5.15, bundled JRE)                           │
│   - parse, validate, outline (with positions), resolve                 │
└────────────────────────────────────────────────────────────────────────┘
        │ (M3) HTTPS
  Anypoint (Design Center, Exchange)      Cloudflare login broker (M3)
```

**Rules that keep it simple:**
1. **The webview never talks to the JVM or the network directly.** Everything goes through Rust commands. This is the same as DataWeave Studio, where it has worked well.
2. **The text is the master copy.** Edits are text splices (M0.2); AMF only reads. Nothing ever regenerates a file.
3. **The UI never waits on AMF.** Typing, edits, the tree and autocomplete use the last known results; AMF results arrive tagged with a generation number, and stale ones are dropped.

---

## 2. Repository layout

One repo, like DataWeave Studio:

```
design-studio/
  src/                    React app
    app/                  App shell, layout, panes
    editor/               CodeMirror 6 setup, RAML/OAS language, completion, hover, markers
    edits/                edit operations (pure functions + tests)
    project/              project store (open files, outline, problems, generations)
    tree/                 API tree
    problems/             problems panel
    forms/                (M2) visual forms. Built as src/Inspector.tsx (forms) and src/splice.ts (text splices by key path)
    graph/                (M5) API map
    shared/               theme, icons, window controls, settings, palette (from DataWeave Studio)
  src-tauri/              Rust core
    src/project.rs        open/close, VFS, save, zip import, watcher
    src/amf.rs            amf-server process manager + request routing (one engine per window)
    src/anypoint/         (M3) auth, client, lock keep-alive
  amf-server/             Java 17 Maven project (shaded jar)
  scripts/                bench (corpus timings), golden test runner, release helpers
  corpus/                 public specs (raml-org examples, small OAS)
  corpus-private/         git-ignored: private real-world specs, local tests only
  tests/golden/           expected diffs for edit operations on public corpus
  docs/                   PLAN.md, ARCHITECTURE.md
  spikes/                 M0 throwaway code (kept for reference)
```

---

## 3. Project and files (Rust)

**A project** is a root folder plus its main file. The main file comes from `exchange.json`'s `main` when present; otherwise the user picks it, and the root `.raml`/OAS file is guessed.

**The virtual file system (VFS)**, kept by Rust for the open project:
- `path -> { disk_text, buffer_text?, eol: LF|CRLF, encoding, disk_mtime }`;
- **dirty** = `buffer_text` differs from `disk_text`;
- the webview sends changed buffers (debounced, whole-file text for the changed files only);
- Rust forwards them to amf-server as overlays.

**Saving:**
- **Line endings:** write `buffer_text` with the file's original line endings (detected per file at open). A splice that inserted `\n` into a CRLF file is converted.
- **Untouched files** are never rewritten.
- **New files** (e.g. copied examples) are created and the parent folders made.

**Zip import:**
- extract to a chosen folder;
- duplicate entries: last one wins, with a warning listing them (M0.1 found one in a real Exchange zip);
- paths normalised, and zip-slip guarded.

**File watcher (notify crate):**
- an external change to a clean file reloads it silently;
- an external change to a dirty file asks the user (keep mine / take theirs / diff).

**Project metadata:** `.apidesigner/` in the project folder, git-ignored by default:
- `link.json` (M3: remote project, branch, base commit, file hashes);
- `state.json` (open tabs, tree expansion).

---

## 4. amf-server

**The process manager in Rust** is taken from DataWeave Studio's dw-server manager:
- spawn the bundled JRE with UTF-8 flags (`-Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8`, M0.1);
- a startup handshake **with a timeout**, and stderr captured into the app log. Both are lessons from the DataWeave Studio splash hang, where endpoint security blocked the JRE;
- restart on crash, with the last overlays replayed;
- warm-up at launch on a tiny spec, which pays the 2 s class-loading cost before the user opens anything.

**Protocol:** JSON lines on stdin and stdout, one request per line, `{id, op, ...}`; answers `{id, ok, ...}`.

| op | input | output |
|---|---|---|
| `open` | `root`, `main` | ok |
| `overlay` | `{files: {path: text or null}}` (unsaved text) | ok |
| `check` | `mode: parse or validate`, `model` (optional) | `problems`, `spec`, `parseMs`, `validateMs`; with `model`: the API as AMF reads it (endpoints, operations, parameters, bodies, responses, types with positions, type names and Used by from AMF links) |
| `convert` | `path`, `to` (oas30, oas20, raml10), `syntax` | the converted text (Duplicate As) |
| `jsonSchema` | `name`, `file` of a declared type | AMF's JSON Schema for it |
| `resolve` | | resolved model JSON (planned for M5: docs, mock, graph) |

As built: there is one `check` op (a newer queued check makes an older one answer `{stale: true}`), and unchanged libraries and fragments come from AMF's `UnitCache`. The app asks for the model with the idle full check (it costs about 0.2 s on a big spec), not with every keystroke.

**File loading:** a custom AMF `ResourceLoader` serves an overlay first, then disk, so unsaved edits are checked without writing files.

**The configuration:** parse with `APIConfiguration.API()`, validate with `APIConfiguration.fromSpec(parsed.sourceSpec())` (M0.1: the auto-detect configuration refuses to validate).

**Problems** come from merging parse results and validation results (M0.1: broken references and missing includes come from the parse phase). Each problem has severity, message, file, range and a short code. AMF's operating-system error text (mangled on Windows) is replaced with our own wording for file-not-found.

**The outline** (as planned) is built by walking the AMF model with `annotations().location()` and `lexical()`. **As built in M1:** the tree, autocomplete and shelf use a fast line-based reading in the webview (`src/raml.ts`) instead, so they never wait on the JVM; AMF reports the errors. The AMF outline below stays the plan for `uses` (find usages, the M5 graph):

```jsonc
{
  "spec": "RAML 1.0",
  "title": "system-api", "version": "v1",
  "resources": [ { "path": "/orders", "file": "main.raml", "range": [57,0,181,0],
                   "methods": [ { "method": "get", "range": [...], "is": ["client-id-policy"] } ],
                   "children": [ ... ] } ],
  "types":  [ { "name": "Order", "library": "orderLib", "file": "data-types/order.raml", "range": [...] } ],
  "traits": [ ... ], "resourceTypes": [ ... ], "securitySchemes": [ ... ],
  "libraries": [ { "alias": "quoteLib", "path": "data-types/quote.raml", "usedIn": ["main.raml"] } ],
  "files": [ "main.raml", "data-types/quote.raml", "examples/....json", ... ],
  "uses":  [ { "from": {"file": "...", "range": [...]}, "to": "type:orderLib.Order" } ]
}
```

`uses` (references, each with its position) powers find-usages, rename, impact highlighting and the M5 graph. Whatever AMF can't attribute exactly, the webview fills in with the per-file alias text match from M0.2, and every rename is followed by a parse that would expose a miss.

**Scheduling:**
- **Parse:** 300 ms after the last edit (0.1 to 0.4 s on the corpus).
- **Validate:** after 1.5 s idle, on save, and on demand (0.5 to 2 s). A newer generation cancels a running validation where AMF allows; otherwise its result is dropped.
- **One worker thread.** Requests queue, and a parse for generation N supersedes queued parses for older generations.

---

### 4.1 What's inside AMF and ALS (survey, 2026-10-05)

**AMF 5.15.0** (with its dependencies, 17,257 classes) is more than a parser. Useful public APIs:

| API | Use in the app |
|---|---|
| `AMFShapePayloadValidator.validate(json)` | Check each example, and each mock request and response, against its type, with AMF's own messages and positions |
| `JsonSchemaShapeRenderer.toJsonSchema(shape)` | "View or copy as JSON Schema" for any RAML type |
| `RamlShapeRenderer.toRamlDatatype(shape)` | The reverse, for OAS specs |
| `AMFElementClient.asEndpoint(unit, resourceType)`, `asOperation(unit, trait)` | Show the **effective** endpoint or method with traits and resource types applied (for example `client-id-policy` plus `correlation-headers` plus `global-errors` expanded) |
| `UnitCache` (custom reference cache) | Reuse parsed, unchanged libraries and fragments between parses. The main lever on M0.1\x27s 2 s full validation |
| `ParsingOptions` (`withTokens`, max YAML references, JSON complexity and depth) | Keep tokens; guard against huge or hostile specs |
| `PipelineId.Default` / `Editing` / `Compatibility` / `Cache` / `Introspection` | \`Compatibility\` converts between RAML and OAS (the parking-lot export) |
| Spec coverage | RAML 0.8 and 1.0; OAS 2.0, 3.0, 3.1 and 3.2; AsyncAPI 2.x and 3 (with Kafka, Anypoint MQ, Solace, AMQP, MQTT, IBM MQ, Pulsar and other bindings); GraphQL; gRPC; Avro; JSON Schema; AML dialects |

**ALS, the AML Language Server** (`org.mule.als:als-server_2.12` 7.1.6-0 on MuleSoft\x27s Nexus, about 3,000 classes). This is the engine behind API Designer\x27s and Code Builder\x27s editor features. It\x27s a full LSP server with modules for:
- workspace management;
- diagnostics;
- completion (about 360 web-API suggestion classes, path navigation, templates);
- structure (the outline);
- code actions, which include refactorings: **extract RAML type, extract to library, extract to fragment, extract trait, extract resource type**, delete a declaration, create a file.

ALS 7.1.6 is pinned to **AMF 5.9.2** (plus AMF modules for GraphQL, MCP and agent networks), not 5.15.

**Licence and status:**
- AMF, ALS and the custom validator are **Apache 2.0** (MuleSoft, Inc.), so bundling them is fine with the notice kept.
- Their GitHub repos (aml-org) were **archived** in 2026, but MuleSoft still publishes AMF to its Nexus (5.15.0 on 2026-10-02). Expect binaries, not public issues or fixes.

**M0.5 result (2026-10-05): don't adopt ALS for the editor; keep it as a reference.**

Code: `spikes/m0-5-als/run.mjs`. ALS 7.1.6 (73 jars, 61 MB, AMF 5.9.2), `org.mulesoft.als.server.lsp4j.Main`, run on `system-api` (2,202 lines). Two setup lessons:
- **Talk over a socket** (`--port N --listen`). ALS writes its debug logs to stdout, about 600 lines per run, which corrupts LSP over stdio.
- **Declare the main file first:** `workspace/executeCommand` `didChangeConfiguration` with `{mainPath, folder, dependencies}`. Without it, cross-file features silently fail: references 0, a rename that edits only the declaration (which would break the spec), definition 6.4 s.

| Feature | Result with the main file declared |
|---|---|
| Start, then first diagnostics | 1.3 s, then 4.7 s (whole project), correct (0 problems) |
| Outline | 0.44 s, 1,630 symbols |
| Definition | 0.16 s, correct file and line |
| References and rename of a library type | correct across files (1 reference; rename edits both files, as in M0.2) |
| Code actions | 0.2 to 0.3 s: "Delete declaration (Cascade)", "Extract to Declaration", "Extract resource type". The extract edit touched 6 lines |
| **Re-check after an edit** | **3.0 s**, against 0.38 s for our parse-only tier (M0.1) |
| **Completion after `type:`** | 13 built-in types only. In an empty `type:` it offers the 36 library aliases (`billingLib.`) but took **3.3 s** after an edit; after `alias.` it gave 0 items in this test |
| Hover on a type reference | generic keyword text ("Defines a data type"), not the type |

**Why not adopt it:**
- The everyday loop (typing, completion, errors) is where ALS is slow: about 3 s per edit for re-checks and completion, against an instant local completion and a 0.4 s parse tier in our design.
- ALS pins AMF 5.9.2, and our checks use 5.15. Two AMF versions can't share one JVM classpath, so ALS would need a second JVM (memory, start-up and 61 MB more).
- The repo is archived, with no public fixes, and it needs workarounds (socket instead of stdio, explicit main-file setup).

**What we take from it:**
- **The refactoring list** sets the target for our own splice-based edits (M2): extract to declaration (type), extract resource type, extract trait, extract to library or fragment, delete declaration with cascade.
- **It's a test oracle:** for references and rename, compare our results against ALS's on the corpus in tests.
- **Revisit** only if MuleSoft ships a newer ALS on AMF 5.15+ with faster completion.

## 5. Webview

**State:** a single project store, plain React context and hooks as in DataWeave Studio, with no extra state library unless it becomes painful. It holds:
- open files (one CodeMirror state per file, keyed by path);
- the current generation;
- the last outline and its generation;
- problems by file;
- the dirty set;
- the selection (the tree node, the cursor's YAML path).

**The editor (CodeMirror 6, M0.4):**
- **Languages:** RAML is `@codemirror/lang-yaml` plus highlighting for the `#%RAML` header, `!include`, `uses:` aliases and type expressions; OAS uses lang-yaml and lang-json.
- **Cursor context** comes from the live Lezer tree (about 0.01 ms in M0.4), which drives autocomplete, the shelf, the breadcrumb and the tree selection.
- **One editor state per file,** created lazily. Big example JSON files open only when clicked.
- **Undo:** an edit operation touching several files is applied as one undo group per file, plus an app-level "undo last operation" that reverts all its files together.

**Where am I?** A fast `yaml` parse of the current file, debounced at about 50 ms and done in the webview, gives the YAML path at the cursor: for example `/orders > get > responses > 200 > body > application/json > type`. That drives autocomplete context, the tree selection, breadcrumbs and which form to show.

**Autocomplete** (M1, all local and instant), by context:
- `type:`, `items:`, a type expression: types from the outline, qualified by the **current file's** aliases;
- `is: [`: traits;
- `type:` under a resource: resource types;
- after `!include`: project files, filtered by extension;
- under `body:`: media types;
- under `responses:`: status codes;
- method keys, and RAML keywords valid at that level.

**Edit operations** (`src/edits/`) are pure functions:

```ts
type FileEdit = { path: string; edits: { from: number; to: number; text: string }[] } | { path: string; create: string };
duplicateFile(project, path, newPath, format): FileEdit[]   // same format = byte copy; else amf-server `convert`
renameType(project, typeRef, newName): FileEdit[]
addResponse(project, methodRef, code, template): FileEdit[]
```

- They use positions from the `yaml` parse and the outline, and indentation from siblings (M0.2).
- They never touch bytes outside their splices.
- The UI previews the result (files touched, lines added) before applying.
- **Golden tests** run each operation on the public corpus and compare against stored diffs; the private corpus runs locally only.

**Panes:** the tree (left), the editor with tabs and breadcrumbs (centre), the inspector (right: the M2 forms, docs preview, Exchange panel), problems (bottom), and a status bar (spec, generation state, validation time).

---

## 6. Performance budgets (from M0.1)

| Action | Budget |
|---|---|
| Keystroke to screen | under 16 ms (CodeMirror; never blocked) |
| Cursor context (YAML path) | under 20 ms on a 2,000-line file |
| Autocomplete list | under 50 ms (outline already in memory) |
| Edit to outline and reference errors | under 0.5 s |
| Edit to full validation | about 2 s for a 5,000-line spec, in the background |
| Open a project (warm sidecar) | under 2 s for the largest corpus spec |

`scripts/bench` runs the corpus and fails if a budget regresses by more than 20%.

---

## 7. Reused from DataWeave Studio

Copied in, not shared as a package (two solo repos, so copying is simpler than a shared library):
- **Look and feel:** theme tokens, Dusk and Paper themes, accent handling, `ThemeContext`, `Icons`, `WindowControls`, the settings dialog pattern, the command palette, toasts.
- **The JVM sidecar:** the process manager (spawn, handshake with timeout, stderr capture, restart), JSON-lines framing, jlink JRE bundling in CI.
- **OS keychain commands** (saved keys), used in M3 for tokens and BYOK secrets.
- **Shipping:** the updater, the GitHub release workflow, the Microsoft Store MSIX workflow and listing automation, the feedback widget.
- **Testing:** CDP driving of the dev app.

---

## 8. Tech choices

### 8.1 Why Tauri (not Electron, not Flutter)
- **Tauri:** a small shell using the system webview (WebView2, Chromium-based, on Windows), low memory, and it reuses all of DataWeave Studio's Rust, sidecar, updater, Store and CI work.
  - Risk: webview differences on macOS and Linux, which DataWeave Studio already ships through.
- **Electron:** identical rendering everywhere, but it adds about 100 MB and much more memory, and the backend, updater and packaging would be redone. It stays the fallback only if a webview problem proves unworkable.
- **Flutter:** no mature code editor for multi-thousand-line YAML with completions, and no reuse. A poor fit for an editor-first app.

### 8.2 Editor: Monaco or CodeMirror 6, decided by M0.4

DataWeave Studio's Monaco bugs came from its design, not from bad luck:
- **Global per-language providers:** every editor shows every editor's completions, so it needed a refcounted registry.
- **Self-measured layout fighting CSS:** `min-h-0` fixes, relayout problems, and an overflow root that broke rename's Enter and Escape.
- **Find-widget flicker and shortcut collisions.**

This app will have many small editors (form fields, examples, inspector), which makes the global-provider problem worse.

CodeMirror 6 has:
- per-instance extensions;
- light instances;
- viewport rendering;
- an incremental YAML parser (Lezer) whose syntax tree may give the cursor context directly;
- `@codemirror/merge` for conflict views;
- a VS Code keymap package.

Its costs: no reuse of DataWeave Studio's editor glue, more completion UI to polish ourselves, and no built-in minimap.

**M0.4 (half a day):** load the 2,201-line `system-api.raml` in both editors, with RAML highlighting, context-aware type completion (from a fixed outline) and AMF problem markers. Compare the feel, typing and scroll speed with a big file, ten small instances on one screen, layout behaviour inside a resizable pane, and the amount of code. The winner is recorded here.

**M0.4 result (2026-10-05): CodeMirror 6.**

Code: `spikes/m0-4-editor` (`bench.mjs`, `leak.mjs`). Monaco 0.52.2 (core plus YAML only) against CodeMirror 6 (view 6.43, lang-yaml 6.1). Each page has the 2,202-line `system-api.raml`, type and trait completion, the two AMF markers, a breadcrumb and 10 small editors. Measured in headless Edge, three runs each.

| | Monaco | CodeMirror 6 |
|---|---|---|
| Create the big editor | 28 to 105 ms | 14 to 29 ms |
| Create 10 small editors | 26 to 36 ms | **5 to 6 ms** |
| Typing (per character, including the frame) | 7.2 ms | 10.5 ms |
| Scrolling (per 40-line jump) | 10 to 14 ms | 7 to 8.5 ms |
| Cursor context (YAML key path) | 11 to 18 ms (re-parses the file) | **~0.01 ms** (the incremental Lezer tree) |
| Bundle | ~3.8 MB (3.4 MB JS, worker, CSS, font) | **0.43 MB** |
| Small editor, typing "ord" | **suggested words from the big spec** (`orderLib`, `orderCreate`, ...) | nothing (extensions are per editor) |
| Code for the same page | 86 lines | 85 lines |

**Why CodeMirror 6:**
- No cross-editor leaks by design; Monaco leaked the big spec's words into a form field out of the box.
- Cursor context is effectively free from the live syntax tree. That drives completion, the breadcrumb, tree sync and which form to show on every cursor move.
- Small editors are 6 times cheaper to create.
- It's 9 times smaller.

Typing and scrolling are well inside a 16 ms frame on both. The costs: no reuse of DataWeave Studio's Monaco glue, and the completion UI, theming and keymap get our own polish (the VS Code keymap package covers the shortcuts).

### 8.3 The rest

- **Shell and UI:** Tauri 2, React and TypeScript, Vite, Tailwind, **CodeMirror 6** (`@codemirror/lang-yaml`, autocomplete, lint, merge), `yaml` 2.x for edit positions, `jsonc-parser` for OAS JSON.
- **amf-server:** Java 17 and Maven with the shade plugin. Plain Java, since AMF's platform API is Java-friendly and Scala isn't needed.
- **Rust:** serde, notify, zip, tokio. Later reqwest and keyring (M3).
- **Windows first** (it's what I use at work); macOS and Linux builds from the same CI as DataWeave Studio.

---

## 9. Failure handling

- **amf-server doesn't start** (blocked JRE, missing Java): the editor still works (typing, tree from the last outline, the YAML parse); a banner explains, with the log.
- **amf-server crashes:** it restarts, replays the overlays and re-parses. A crash loop of 3 within a minute stops and shows the banner.
- **A parse is slow** (over 10 s): a status-bar warning. The editor stays usable.
- **The project changed on disk while dirty:** the user chooses (section 3).
- **Never lose typing:** dirty buffers are journalled to `.apidesigner/recovery/` every few seconds and offered back after a crash.

---

## 10. M1 build order

Each step ends usable and tested:

1. **Skeleton:** Tauri and React app with DataWeave Studio's shell (theme, window controls, settings, palette); an open-folder dialog; a file list.
2. **amf-server and the manager:** open, overlay, parse, validate; warm-up; problems panel with click-to-jump; bench script on the corpus.
3. **Editor:** CodeMirror tabs, the RAML grammar, dirty tracking and save with line endings kept, zip import with duplicate handling.
4. **Outline and tree:** resources, methods, types, traits, libraries; the tree selects with the cursor and the cursor follows the tree; breadcrumbs.
5. **Autocomplete and hover:** the context table in section 5; hover on a type shows its definition; F12 goes to the definition.
6. **Edit operations:** rename type (Design Center's "Rename Symbol") and add response, end to end with a preview and golden tests. Then the Files menu: Set as root file, Rename (updates every `!include`), Duplicate As (copy, or RAML/OAS conversion through amf-server's `convert`), Delete.
7. **Hardening:** the file watcher, recovery journal, failure banners, budgets checked on all three corpus specs.

**Exit (from PLAN.md):** I do my real copy-paste-edit work in it faster than in Design Center, on the three corpus specs.
