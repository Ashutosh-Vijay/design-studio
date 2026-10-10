# Design Center feature inventory

Everything API Designer (Design Center's spec editor) does today, so the mockups and milestones miss nothing. Written 2026-10-10 from MuleSoft's own docs source (`mulesoft/docs-design-center` on GitHub, branch `latest`, 46 pages), the API Designer release notes up to 2.83.200 (2026-08-21), the Code Builder docs, and the developer's screenshots.

**Status column:** **Mock** = in a design mockup now. **Planned** = in PLAN.md with its milestone. **Gap** = not covered yet; the note says what to do.

---

## 1. Layout of API Designer's text editor

| Area | What it does there | Us |
|---|---|---|
| Left: **Files** | Files and folders, the root file marked with a "Root file" label, `exchange.json` shown read-only, a + button for new files, a filter | Mock (Files tab). Gap: the + button and the "root file" label wording |
| Left: **Exchange dependencies** | A separate icon in the left navigation; fragments and rulesets with versions | Gap: no dependencies panel in the mockup (M4) |
| Middle: **editor** | Text editor with tabs (the tab bar shows only when 2+ files are open) | Mock |
| Right: **Documentation** | The API Console rendering of the spec: a Summary page (title, version, base URI, list of resources and types), a page per endpoint and per method, a server picker, and **Try it** against the mocking service | Planned (M5 docs preview and local mock). See section 6 |
| Right: **Mocking Service Configuration** | A second icon on the right rail: make the mock public, expiry date, use the mock as the default server | Planned (M5, local mock instead) |
| Bottom: **Project Errors** | Errors with a Location column (click to open); a **Governance** tab when rulesets are applied | Mock (Problems). Gap: the Governance tab |
| Status bar | "Governance auto-validation: on", the language (RAML), the project type (API specification) | Mock has its own status bar. Gap: governance state |
| Top right | Share, Publish, gear menu, branch picker | Gap: branch, Share, Publish are not in the main window mockup yet |

**Answer to "is our left tree the same as Documentation?"** No. Their Documentation panel is a *reading* view: it renders the spec as API docs and lets you call the mock. Its Summary page lists resources and types, which looks like our tree, but clicking there opens a docs page, not the code. Our tree is a *navigator* (it jumps to the code and drives the Inspector), closer to their "Go to Symbol". Their rendered docs are our M5 docs preview; the mockup has no Docs view yet.

## 2. Editor features (from "Helpful Features in the Text Editor")

Design Center gets these from ALS (the AML Language Server, M0.5).

| Feature | How it works there | Us |
|---|---|---|
| Rename Symbol | Right-click a declaration; renames every use in files linked from the root file, never plain mentions in descriptions | Planned (M1 step 6, rename type). Mock has a stub |
| Highlight uses | Cursor on a declaration highlights where it's *used* (not where the word appears) | **Gap**: cheap with our `uses` list. Add to M1 step 5 |
| Go to References | Right-click, a list of uses, double-click to jump. Covers types, type expressions, traits, resource types, library aliases, JSON path refs, security schemes, annotation types | Mock (Inspector "Used by" for types). Gap: same for traits, resource types, security schemes, aliases |
| Go to Definition | F12 | Planned (M1 step 5) |
| Selection ranges | Ctrl Shift Right grows the selection by syntax node, Ctrl Shift Left shrinks it | **Gap**: CodeMirror has `selectParentSyntax`; bind the same keys |
| Go to Symbol | A list of every symbol in the file | Mock (Ctrl K palette). Gap: also bind Ctrl Shift O for people used to it |
| Extract to Declaration | Select an inline type, trait or resource type; an icon appears; it becomes a top-level declaration, named after the original, with a number if taken | Planned (M2 refactorings, from the ALS list) |
| Command list | F1 shows every command with its shortcut | Gap: bind F1 to our palette |
| Autocomplete | Context-aware, including `!include` and `$ref` paths (added 2.62.0) | Mock and planned (M1 step 5) |
| Ctrl click a file reference | Opens it in a new tab | Mock |

## 3. Tabs

| Behaviour there | Us |
|---|---|
| A plain click on a file in the tree **replaces** the current tab; Ctrl click opens a new tab | Gap: decide. VS Code's "preview tab" (italic until edited) is the friendlier version of the same idea |
| Tab bar appears only with 2+ files open | Ours always shows; keep (it carries the dirty dots) |
| Alt Tab / Alt Shift Tab for next and previous tab | Gap: use Ctrl Tab / Ctrl Shift Tab (Alt Tab is taken by Windows) |
| "Close All Other Tabs" in a tab menu | Gap: add a tab context menu (Close, Close others, Close saved, Copy path, Reveal in Files) |

## 4. Files and the root file

| Feature | Us |
|---|---|
| **Root file**: one per project; publish and validation start from it; label in the Files pane; **Set as root file** in each spec's menu; asked when importing a spec | Mock shows "main". Gap: rename to "Root file" (their word), add "Set as root file" to the file menu |
| File menu (three dots): Rename, Download, **Download as** (RAML to OAS YAML or JSON, OAS to RAML 0.8 or 1.0, "not guaranteed valid"), **Duplicate** (opens a "Duplicate As" dialog that converts the format), Open in new tab, Delete | Gap: file context menu in Files. "Download as" maps to AMF's Compatibility pipeline (ARCHITECTURE 4.1, parking lot "Export as OAS") |
| New file: format (RAML 1.0, OAS 2.0, OAS 3.0, RAML 0.8, JSON Schema, Other) and, for RAML, the fragment type (Trait, Resource Type, Library, Data Type, User Documentation, Example, Annotation Type, Security Scheme, Overlay, Extension) | Gap: New file dialog. Mock it |
| `exchange.json` is read-only there | Decide: we can show it read-only too, with the fields that matter (main, dependencies) in a small form |
| Import: file or zip, a URL (single file, no includes), or **from Exchange** (business group, name, version, type, language RAML or OAS, include snapshots) | Mock (zip on the start screen). Gap: import into an open project (file, URL, Exchange) |

**Naming clash:** their **"Duplicate As"** converts a file between RAML and OAS. Our "Duplicate as…" copies an endpoint. People who know Design Center will expect the format conversion. Rename ours, for example **"Duplicate endpoint…"** (resources) and **"Duplicate method…"** (methods), and keep "Download as" for the format conversion.

## 5. Exchange dependencies and governance

| Feature | Us |
|---|---|
| Add dependency: filter by organization or keyword, "Include versions in Development", pick a version, "Show selected only", format badge (RAML, OAS, JSON Schema) | Planned (M4). Gap in mockups |
| Change a dependency's version without removing it (2.62.0); remove; refresh before publishing | Planned (M4, "dependency updates") |
| Show in Files (under `exchange_modules/<group>/<asset>/<version>/`), Open in Exchange | Mock shows `exchange_modules` in Files. Gap: the actions |
| Limits: 100 dependencies per project (2.76.0); 1,000 dependency files, 300 MB | Note for the import code |
| **Rulesets** as dependencies; conformance messages in Project Errors under a Governance tab; auto-validation on or off; a "Validate for governance" button; a dot on the dependencies icon when the org requires rulesets | Parking lot ("rulesets and conformance"). Worth a slot after M4: AMF ships the custom validator, so it can run locally |

## 6. Documentation panel and mocking service

| Feature | Us |
|---|---|
| API Console rendering: Summary, endpoint pages, method pages with parameters, bodies, responses, examples; OAS 3 servers per path or method, links, callbacks | Planned (M5 docs preview, our own React rendering) |
| Try it: server picker (`baseUri` or the mocking service), query parameters, Send, copy the request URL | Planned (M5 local mock and try-it) |
| Mock is public with an optional expiry date | Not needed: ours is local. A "share a mock" link would need hosting; parking lot |
| **Behavioral headers**: `MS2-Delay` (ms or a range, max 10 s), `MS2-Example` (pick a named example), `MS2-Error-Level` (`REQUEST_ONLY`, `SERVER_ONLY`, `ALL`), `MS2-Error-Rate` (0 to 1), `MS2-Randomize` (generate a payload from the type when there's no example), `MS2-Status-Code`, `MS2-Status-Code-Selection` | Planned: **support the same headers in our local mock**, so tests written against Design Center's mock work unchanged |

## 7. Project, branches, sharing, publishing

| Feature | Us |
|---|---|
| Gear menu: Import, Import from Exchange, Download Project, Branch Settings, Rename, Duplicate project, Delete | Mock has a project menu. Gap: Rename, Duplicate, Delete, Download as zip |
| **Branches** ("fork"): click the branch name, type a new name, Enter. A fork can't be merged back in API Designer (GitHub Sync can merge). Projects open on the main branch. Pick a branch before opening (2.67.0) | Planned (M3: list, switch, create). Gap in mockups: a branch chip in the header |
| **Share**: Viewer, Editor, Admin, Transfer Ownership, Remove Access, for users or teams | Not planned. Offer "Share in Design Center…" that opens the browser |
| Permissions: Design Center Viewer can only view and use the mock | Gap: a read-only mode for projects we can't edit (banner plus a locked editor) |
| **Publish**: asset version and API version pre-filled by rules (from the spec's `version`, or the last published version plus one patch), lifecycle Development or Stable, business group, asset name, asset ID. Stable versions can't be reused. **Unreferenced files are excluded by default**, after a prompt | Planned (M4). Copy the pre-fill rules exactly, and the unreferenced-files prompt (our `files` list from the outline already knows what's referenced) |
| View code from Exchange: read-only, then "Edit spec" if you can edit | Parking lot ("open an API straight from Exchange") |
| **GitHub Synchronization**: a GitHub App that syncs API Designer projects with a repository both ways; GitHub becomes the source of truth | New fact. Our M0.3 finding (a `git push` to Design Center's own Git URL doesn't arrive) is about a different thing. Worth reading before M3, since teams using it want "push to GitHub", not "push to Design Center" |

## 8. Visual editor (the one we're beating)

Three panels: left (API name, add resources, data types, security schemes, all inline in one file), middle (forms), right (read-only RAML and OAS viewers, plus the mock). RAML 1.0 or OAS 2.0 and 3.0 JSON. **"Edit RAML" or "Edit OAS" switches to the text editor for good: you can't go back.** That one-way switch is exactly the gap our two-way forms (M2) fill.

## 9. Things the release notes tell us

- **API Designer runs AMF 5.10.0** (2.79.0, April 2026). We bundle 5.15.0. Where the two disagree, a spec could be clean for us and fail on publish. Check the corpus against both before M1 ships, and say which AMF version we use in About.
- 2.70.0 added "a performance impact notification for large projects": Design Center itself admits big specs are slow, which is our reason to exist.
- 2.74.0 restyled API Designer to Salesforce's look (the purple in the screenshots).
- Projects auto-release the lock on leaving (2.83.200), and locks go stale otherwise; matches M0.3.
- Paste options (2.65.0), copy error details to the clipboard (2.66.0): small things users now expect. Gap: "Copy" on a problem row.

## 10. What to mock next, from the gaps

1. **Files pane menu and New file dialog**: root file label and "Set as root file", Rename, Delete, Download as, Open in new tab; the format and fragment-type picker.
2. **Header additions**: branch chip with switch and create; Publish; "Share in Design Center…".
3. **Dependencies panel**: fragments and rulesets, versions, add dialog, Show in Files, Open in Exchange.
4. **Docs tab in the Inspector**: a small API Console-style page for the selected endpoint, with Try it against the local mock and the MS2 headers.
5. **Publish dialog** with Design Center's pre-fill rules and the unreferenced-files prompt.
6. **Editor polish**: highlight uses, tab context menu, F1 and Ctrl Shift O, Copy on problem rows, and the rename of "Duplicate as…".

## Sources

- MuleSoft docs source: https://github.com/mulesoft/docs-design-center (pages under `modules/ROOT/pages`)
- API Designer release notes: https://docs.mulesoft.com/release-notes/design-center/design-center-release-notes-api_specs
- Text editor: https://docs.mulesoft.com/design-center/design-create-publish-api-raml-editor
- Enhanced experience (Omni): https://docs.mulesoft.com/general/exp-overview
- Code Builder API design: https://docs.mulesoft.com/anypoint-code-builder/des-create-api-specs
- The legacy open-source API Designer (Angular, RAML only): https://github.com/mulesoft/api-designer
