// AI tools (MCP): what a person can do in Design Studio, an AI agent can do too, through the same code.
// The server is in Rust (src-tauri/src/mcp.rs, Streamable HTTP on 127.0.0.1, as in DataWeave Studio); it hands
// each call to this window, where the tool runs against the open project (host.project, lent by the project
// view on every render) and the app (host.app). Edits go through the editor, so they show as they happen.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Outline, Resource } from './raml';
import * as S from './sync';
import { KINDS, makeProject, type Kind } from './Create';
import type { Me } from './SyncUI';
import { Modal, btn, btnPrimary, Spinner } from './App';
import { Icons } from './components/Icons';
import { isVsCode } from './components/WindowControls';

type Problem = { severity: string; message: string; file: string; line: number; col: number };
type Ref = { file: string; line: number; text: string; decl?: boolean };
export type ProjectHost = {
  root: string; name: string; main: string | null; files: string[]; open: string[]; active: string | null; unsaved: string[]; viewOnly: boolean;
  read: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>; // shows the file, writes it, saves it
  remove: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  setRoot: (path: string) => Promise<void>;
  saveAll: () => Promise<void>;
  check: () => Promise<Problem[] | undefined>;
  governance: () => Promise<unknown[] | undefined>;
  outline: () => Outline | null;
  refs: (name: string, file?: string) => Promise<Ref[] | null>;
  renameSymbol: (name: string, nu: string, file?: string) => Promise<string>;
  convert: (path: string, to: string, syntax: string) => Promise<string>;
  jsonSchema: (name: string, file: string) => Promise<string>;
  mockPort: () => Promise<number>;
  show: (path: string, line?: number) => Promise<void>;
  reload: () => Promise<void>;
};
export type AppHost = {
  recent: { root: string; name: string; opened: number }[];
  open: (root: string) => Promise<void>;
  close: () => Promise<void>;
};
export const host: { app: AppHost | null; project: ProjectHost | null } = { app: null, project: null };

const PORT = 4676;
const pref = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const setPref = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked storage: forgotten */ } };
const remoteOk = () => pref('ads.mcp.remote') === '1';

// ---------- The tools ----------
type Args = Record<string, unknown>;
type Tool = { name: string; description: string; props?: Record<string, { type: string; description: string; enum?: string[] }>; required?: string[]; readOnly?: boolean; remote?: boolean; run: (a: Args) => Promise<unknown> };
const str = (description: string) => ({ type: 'string', description });
const bool = (description: string) => ({ type: 'boolean', description });

function proj() {
  const p = host.project;
  if (!p) throw new Error('No project is open in Design Studio. Use open_project, create_project or pull_design_center_project first.');
  return p;
}
async function linked() {
  const p = proj(), l = await S.readLink(p.root);
  if (!l) throw new Error("This project isn't linked to a Design Center project (it was opened from a folder or a zip).");
  return { p, l };
}
// Opening shows the project view a moment later; tools after this one need it there.
async function openAndWait(root: string) {
  const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const same = (x?: string) => !!x && norm(x) === norm(root);
  await host.app!.open(root);
  for (let i = 0; i < 100 && !same(host.project?.root); i++) await new Promise((r) => setTimeout(r, 100));
  if (!same(host.project?.root)) throw new Error(`${root} didn't open (it may not be a folder, or the person kept the current project).`);
}
const filesNow = async (root: string) => (await invoke<{ files: { path: string }[] }>('open_project', { root })).files.map((f) => f.path);
const outlineText = (o: Outline) => {
  const res: string[] = [];
  const walk = (r: Resource, d: number) => { res.push(`${'  '.repeat(d)}${r.path}  ${r.methods.map((m) => m.m.toUpperCase()).join(' ')}`); r.children.forEach((c) => walk(c, d + 1)); };
  o.resources.forEach((r) => walk(r, 0));
  const decl = (title: string, ds: { name: string; alias: string | null; file: string }[]) => ds.length ? `\n${title}:\n${ds.map((d) => `  ${d.alias ? d.alias + '.' : ''}${d.name}  (${d.file})`).join('\n')}` : '';
  return `Resources:\n${res.join('\n') || '  (none)'}${decl('Types', o.types)}${decl('Traits', o.traits)}${decl('Resource types', o.resourceTypes)}${decl('Security schemes', o.securitySchemes)}`
    + (o.libraries.length ? `\nLibraries (uses:):\n${o.libraries.map((l) => `  ${l.alias}: ${l.path}`).join('\n')}` : '');
};

const TOOLS: Tool[] = [
  // The app
  { name: 'get_state', readOnly: true, description: 'Start here. What Design Studio has open (project, root file, files, unsaved files, open tabs), recent projects, who is signed in to Anypoint, and whether changes in Design Center and Exchange are allowed for AI tools.',
    run: async () => {
      // A slow network shouldn't hold up the first call: Anypoint gets a few seconds.
      const me = await Promise.race([invoke<Me | null>('anypoint_status').catch(() => null), new Promise<'slow'>((r) => setTimeout(() => r('slow'), 4000))]);
      const p = host.project;
      return {
        project: p && { root: p.root, name: p.name, rootFile: p.main, files: p.files, openTabs: p.open, activeFile: p.active, unsaved: p.unsaved, viewOnly: p.viewOnly, designCenter: await S.readLink(p.root).then((l) => l && { project: l.projectName, branch: l.branch }) },
        recentProjects: host.app?.recent.slice(0, 15).map((r) => ({ name: r.name, path: r.root })),
        anypoint: me === 'slow' ? "Anypoint didn't answer in time; try again" : me ? { user: me.username, organization: me.org_name, readOnlyConnection: me.read_only } : 'not signed in',
        designCenterChangesAllowed: remoteOk(),
      };
    } },
  { name: 'open_project', description: 'Open a spec project folder on this computer (a path from get_state recentProjects, or any folder). If the open project has unsaved changes, Design Studio asks the person first.',
    props: { path: str('The project folder') }, required: ['path'],
    run: async (a) => { await openAndWait(String(a.path)); return `Opened ${host.project!.name}.`; } },
  { name: 'create_project', description: "Create a new API specification or fragment project, as Design Center's Create does, and open it. With in_design_center it is created in Design Center too (needs changes allowed and a sign-in that isn't read only).",
    props: { name: str('Project name'), kind: { type: 'string', description: 'Language or fragment type', enum: Object.keys(KINDS).filter((k) => k !== 'other' && k !== 'jsonSchema') }, in_design_center: bool('Also create it in Design Center (default false)') }, required: ['name', 'kind'],
    run: async (a) => {
      const dc = a.in_design_center === true;
      if (dc && !remoteOk()) throw new Error(REMOTE_OFF);
      const me = dc ? await invoke<Me | null>('anypoint_status') : null;
      if (dc && (!me || me.read_only)) throw new Error(!me ? 'Not signed in to Anypoint.' : 'The Anypoint connection is read only.');
      const root = await makeProject(String(a.name).trim(), a.kind as Kind, dc, me);
      await openAndWait(root);
      return `Created ${a.name} at ${root} and opened it.`;
    } },
  { name: 'close_project', description: 'Close the open project and go back to the start screen (asks the person if files are unsaved).', run: async () => { await host.app!.close(); return 'Closed.'; } },

  // Files
  { name: 'list_files', readOnly: true, description: 'Every file in the open project, the root file, and which are unsaved. Files under exchange_modules/ are Exchange dependencies and are read only.',
    run: async () => { const p = proj(); return { rootFile: p.main, files: await filesNow(p.root), unsaved: p.unsaved }; } },
  { name: 'read_file', readOnly: true, description: "A file's text as the editor holds it (unsaved edits included). Paths are relative to the project, with forward slashes.",
    props: { path: str('File path in the project') }, required: ['path'], run: async (a) => proj().read(String(a.path)) },
  { name: 'write_file', description: 'Create a file or replace its whole text, then save it. It opens in the editor so the person sees it. Prefer edit_file for changes to an existing file: it keeps the rest byte for byte.',
    props: { path: str('File path in the project; folders are made as needed'), content: str('The full text') }, required: ['path', 'content'],
    run: async (a) => { await proj().write(String(a.path), String(a.content)); return `Saved ${a.path}.`; } },
  { name: 'edit_file', description: 'Replace an exact piece of text in a file and save it. old_text must match exactly once (include enough surrounding lines), unless replace_all is true. Indentation is YAML structure in RAML and OAS: keep it right.',
    props: { path: str('File path in the project'), old_text: str('The exact text to replace'), new_text: str('The replacement'), replace_all: bool('Replace every match instead of exactly one') }, required: ['path', 'old_text', 'new_text'],
    run: async (a) => {
      const p = proj(), path = String(a.path), text = await p.read(path), old = String(a.old_text);
      const n = old ? text.split(old).length - 1 : 0;
      if (!n) throw new Error(`old_text wasn't found in ${path}. Read the file again: it must match exactly, spaces included.`);
      if (n > 1 && a.replace_all !== true) throw new Error(`old_text matches ${n} places in ${path}. Add surrounding lines so it matches one, or set replace_all.`);
      await p.write(path, a.replace_all === true ? text.split(old).join(String(a.new_text)) : text.replace(old, () => String(a.new_text)));
      return `Edited ${path} (${n} ${n === 1 ? 'place' : 'places'}).`;
    } },
  { name: 'delete_file', description: 'Move a file to the Recycle Bin or Trash (it can be restored from there).', props: { path: str('File path in the project') }, required: ['path'],
    run: async (a) => { await proj().remove(String(a.path)); return `Moved ${a.path} to the trash.`; } },
  { name: 'rename_file', description: 'Rename or move a file. Every !include and uses: path that points at it is updated, as Design Center does.',
    props: { path: str('Current path'), new_path: str('New path in the project') }, required: ['path', 'new_path'],
    run: async (a) => { await proj().rename(String(a.path), String(a.new_path)); return `Renamed ${a.path} to ${a.new_path}.`; } },
  { name: 'set_root_file', description: "Make a file the project's root file (Design Center's Set as root file; written to exchange.json).", props: { path: str('File path') }, required: ['path'],
    run: async (a) => { await proj().setRoot(String(a.path)); return `${a.path} is the root file now.`; } },
  { name: 'show_in_editor', readOnly: true, description: 'Open a file in the editor for the person, optionally at a line.', props: { path: str('File path'), line: { type: 'number', description: 'Line number (1 based)' } }, required: ['path'],
    run: async (a) => { await proj().show(String(a.path), a.line == null ? undefined : Number(a.line)); return 'Shown.'; } },

  // Checking and understanding the spec
  { name: 'check_spec', readOnly: true, description: "Run AMF's full check (the same engine and rules as Design Center) on the project, unsaved edits included. Returns every error and warning with file and line. Run it after every change and fix what it reports until it is clean.",
    run: async () => {
      const r = await proj().check();
      if (!r) return 'This project has no root file AMF can check (set one with set_root_file).';
      return r.length ? r.map((x) => `${x.severity} ${x.file}:${x.line}:${x.col + 1} ${x.message}`).join('\n') : 'No problems: AMF reads the spec as valid.';
    } },
  { name: 'get_outline', readOnly: true, description: 'The API as a tree: resources and their methods, types, traits, resource types, security schemes and libraries, with the file each is declared in.',
    run: async () => { const o = proj().outline(); return o ? outlineText(o) : 'No outline yet (no root file, or it is still being read).'; } },
  { name: 'find_references', readOnly: true, description: "Where a type, trait, resource type or security scheme is declared and used, in every file (Design Center's Go to References). Library members are written alias.Name.",
    props: { name: str('The name, like Order or lib.Order'), file: str('Optional: the file you see the name in, for library aliases') }, required: ['name'],
    run: async (a) => { const r = await proj().refs(String(a.name), a.file as string | undefined); if (!r) throw new Error(`${a.name} isn't a declared type, trait, resource type or security scheme.`); return r.map((x) => `${x.decl ? 'declared' : 'used'} ${x.file}:${x.line}  ${x.text}`).join('\n'); } },
  { name: 'rename_symbol', description: "Rename a type, trait, resource type or security scheme and every use of it in every file (Design Center's Rename), never plain mentions in descriptions.",
    props: { name: str('Current name (alias.Name for a library member)'), new_name: str('New name'), file: str('Optional: the file you see the name in') }, required: ['name', 'new_name'],
    run: async (a) => proj().renameSymbol(String(a.name), String(a.new_name), a.file as string | undefined) },
  { name: 'convert_spec', description: "Convert a RAML root file to OAS with AMF (Design Center's Duplicate As) and save the result as a new file.",
    props: { path: str('The RAML root file'), to: { type: 'string', description: 'Target', enum: ['oas30', 'oas20'] }, syntax: { type: 'string', description: 'Output syntax', enum: ['yaml', 'json'] }, target_path: str('Where to save the converted file') }, required: ['path', 'to', 'syntax', 'target_path'],
    run: async (a) => { const p = proj(); await p.write(String(a.target_path), await p.convert(String(a.path), String(a.to), String(a.syntax))); return `Converted to ${a.target_path}.`; } },
  { name: 'type_as_json_schema', readOnly: true, description: 'A RAML type or OAS schema rendered by AMF as JSON Schema.', props: { name: str('Type name'), file: str('The file that declares it') }, required: ['name', 'file'],
    run: async (a) => proj().jsonSchema(String(a.name), String(a.file)) },
  { name: 'run_governance', readOnly: true, description: "Check the API against the governance rulesets it depends on (Exchange rulesets in exchange.json), as Design Center's Governance does. Returns each finding with its rule, level and place.",
    run: async () => { const r = await proj().governance(); return r === undefined ? 'No governance results (no rulesets, or no root file).' : r.length ? r : 'No findings: the API meets its rulesets.'; } },
  { name: 'mock_request', readOnly: true, description: "Call the API's local mock (Design Center's mocking service, unsaved edits included) and get the status, headers and body it answers with. Supports Design Center's MS2-Status-Code and MS2-Example headers.",
    props: { method: str('HTTP method'), path: str('Path with query, like /orders/1?limit=2 (the baseUri path is not needed)'), headers: { type: 'object', description: 'Request headers' } as never, body: str('Request body') }, required: ['method', 'path'],
    run: async (a) => {
      const port = await proj().mockPort();
      const r = await fetch(`http://127.0.0.1:${port}${String(a.path).startsWith('/') ? '' : '/'}${a.path}`, { method: String(a.method).toUpperCase(), headers: (a.headers ?? {}) as Record<string, string>, body: a.body && !/^(get|head)$/i.test(String(a.method)) ? String(a.body) : undefined });
      return `${r.status} ${r.statusText}\n${[...r.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${await r.text()}`;
    } },

  // Design Center
  { name: 'design_center_status', readOnly: true, description: "The open project's Design Center link: project, branch, whether Design Center has commits not pulled yet, who holds the lock, and the local changes not pushed yet.",
    run: async () => {
      const { p, l } = await linked();
      const [st, ch] = await Promise.all([S.remoteState(l), S.localChanges(p.root, l, await filesNow(p.root))]);
      return { project: l.projectName, branch: l.branch, behind: st.behind, lockedBy: st.lockedBy, toPush: { added: ch.added, modified: ch.modified, deleted: ch.deleted }, unsavedInEditor: p.unsaved };
    } },
  { name: 'pull', description: "Bring Design Center's latest commits in, merging with local changes (like git). Conflicting lines get both versions between markers, to resolve with edit_file.",
    run: async () => {
      const { p, l } = await linked(); await p.saveAll();
      const r = await S.pull(p.root, l); await p.reload();
      return r.upToDate ? 'Already up to date.' : { updated: r.updated, removed: r.removed, conflicts: r.conflicts, dependencies: r.deps };
    } },
  { name: 'push', remote: true, description: 'Save every file and send the local changes to Design Center, holding the branch lock. Refuses when Design Center has commits not pulled yet (pull first).',
    run: async () => { const { p, l } = await linked(); await p.saveAll(); const r = await S.push(p.root, l, await filesNow(p.root)); window.dispatchEvent(new Event('ads-files-changed')); return r.sent ? `Pushed ${r.sent} ${r.sent === 1 ? 'change' : 'changes'}.` : 'Nothing to push.'; } },
  { name: 'list_branches', readOnly: true, description: "The Design Center project's branches.", run: async () => { const { l } = await linked(); return { current: l.branch, branches: (await S.branches(l.projectId)).map((b) => b.name) }; } },
  { name: 'switch_branch', description: 'Switch the project to another Design Center branch (local changes must be pushed or discarded first).', props: { name: str('Branch name') }, required: ['name'],
    run: async (a) => { const { p, l } = await linked(); await p.saveAll(); await S.switchBranch(p.root, l, String(a.name), await filesNow(p.root)); await p.reload(); return `On ${a.name} now.`; } },
  { name: 'create_branch', remote: true, description: 'Create a Design Center branch from the current one and switch to it.', props: { name: str('New branch name') }, required: ['name'],
    run: async (a) => { const { p, l } = await linked(); await S.createBranch(l, String(a.name)); await S.switchBranch(p.root, (await S.readLink(p.root))!, String(a.name), await filesNow(p.root)); await p.reload(); return `Created ${a.name} and switched to it.`; } },
  { name: 'list_design_center_projects', readOnly: true, description: "The Design Center projects in the signed-in organization (Design Center's project list).",
    run: async () => (await S.projects()).map((x) => ({ id: x.id, name: x.name, updated: new Date(x.updated).toISOString() })) },
  { name: 'pull_design_center_project', description: 'Pull a Design Center project to this computer (or find the copy already here) and open it.', props: { id: str('Project id from list_design_center_projects'), branch: str('Branch (default master)') }, required: ['id'],
    run: async (a) => {
      const me = await invoke<Me | null>('anypoint_status'); if (!me) throw new Error('Not signed in to Anypoint.');
      const x = (await S.projects()).find((y) => y.id === a.id); if (!x) throw new Error(`No Design Center project has id ${a.id}.`);
      const home = await S.projectHome(me.org_name || 'Anypoint', x.name, x.id);
      if (!(await S.readLink(home.root))) await S.clone(home.root, x.id, x.name, String(a.branch ?? 'master'));
      await openAndWait(home.root);
      return `Opened ${x.name} (${home.root}).`;
    } },

  // Exchange
  { name: 'publish_to_exchange', remote: true, description: "Publish the project to Exchange (Design Center's Publish): pushes unsent changes first, holds the lock, publishes, pulls back exchange.json. A Stable version can't be published twice; use development for a version you will republish.",
    props: { version: str('Asset version, like 1.0.1'), development: bool('Publish as a Development version (default false: Stable)'), api_version: str('API version, like v1 (default from the spec)'), name: str('Asset name (default from exchange.json)') }, required: ['version'],
    run: async (a) => {
      const { p } = await linked(); await p.saveAll();
      const x = await S.readDescriptor(p.root); if (!x) throw new Error('This project has no exchange.json.');
      const d = x.d, main = p.main ?? d.main ?? '';
      const apiVersion = String(a.api_version ?? ((await p.read(main).catch(() => '')).match(/^version:\s*(\S+)/m)?.[1] ?? 'v1'));
      const r = await S.publish(p.root, await filesNow(p.root), { name: String(a.name ?? d.name), assetId: d.assetId, groupId: d.groupId, version: String(a.version), apiVersion, main, classifier: d.classifier ?? 'raml', development: a.development === true });
      await p.reload();
      return `Published ${d.assetId} ${a.version}${a.development ? ' as Development' : ''}.${r.pushed ? ` ${r.pushed} changes were pushed first.` : ''}`;
    } },
  { name: 'search_exchange', readOnly: true, description: 'Search Exchange for assets to depend on: RAML fragments (libraries, types, traits), rulesets, or APIs.',
    props: { query: str('Search words'), types: { type: 'array', description: 'Asset types, like raml-fragment, rest-api, ruleset (default raml-fragment)' } as never }, required: ['query'],
    run: async (a) => S.searchAssets(String(a.query), (a.types as string[] | undefined) ?? ['raml-fragment']) },
  { name: 'asset_versions', readOnly: true, description: "An Exchange asset's versions, newest first, with Stable or Development status.", props: { group_id: str('Group (organization) id'), asset_id: str('Asset id') }, required: ['group_id', 'asset_id'],
    run: async (a) => S.assetVersions(String(a.group_id), String(a.asset_id)) },
  { name: 'add_dependency', description: "Add an Exchange asset as a dependency (Design Center's Exchange dependencies): written to exchange.json and fetched into exchange_modules/. Returns the path to use in !include or uses:.",
    props: { group_id: str('Group id'), asset_id: str('Asset id'), version: str('Version') }, required: ['group_id', 'asset_id', 'version'],
    run: async (a) => { const p = proj(); const r = await S.addDependency(p.root, { groupId: String(a.group_id), assetId: String(a.asset_id), version: String(a.version) }); await p.reload(); window.dispatchEvent(new Event('ads-governance-changed')); return r; } },
  { name: 'remove_dependency', description: 'Remove an Exchange dependency (refused while a file still uses it).', props: { group_id: str('Group id'), asset_id: str('Asset id'), version: str('Version') }, required: ['group_id', 'asset_id', 'version'],
    run: async (a) => { const p = proj(); await S.removeDependency(p.root, await filesNow(p.root), { groupId: String(a.group_id), assetId: String(a.asset_id), version: String(a.version) }); await p.reload(); window.dispatchEvent(new Event('ads-governance-changed')); return `Removed ${a.asset_id}.`; } },
];
const REMOTE_OFF = "Changes in Design Center and Exchange are off for AI tools. The person can turn on 'Allow changes in Design Center and Exchange' in Design Studio's AI tools panel.";

const INSTRUCTIONS = `Design Studio is a desktop designer for MuleSoft Anypoint Design Center API specs (RAML 1.0 and OAS 3.0/2.0). These tools act in the person's open Design Studio window: everything a person can do there, you can do, and they watch it happen.

How to work:
1. Call get_state first. If no project is open, open_project, create_project or pull_design_center_project.
2. Read before you edit (read_file, get_outline). Make changes with edit_file (exact text replacement); use write_file for new files. Keep YAML indentation right: it is structure.
3. After every change, run check_spec. It is AMF, the engine Design Center itself uses: its answer is the truth. Fix what it reports and check again until it is clean. Never tell the person a spec is done while check_spec reports errors.
4. Renaming a type, trait or resource type: use rename_symbol (it updates every use, in every file). Renaming a file: rename_file (it updates every !include and uses:).
5. To try an endpoint, mock_request calls the local mock with the spec's own examples.
6. Design Center: pull before you push. push, create_branch, publish_to_exchange and create_project in Design Center need the person's setting 'Allow changes in Design Center and Exchange'; if refused, tell the person instead of retrying.

RAML notes: libraries are used through uses: aliases (lib.TypeName); fragments are pulled in with !include; Exchange dependencies live under exchange_modules/ and are read only.`;

// ---------- Running calls from the server ----------
export type LogRow = { at: number; tool: string; ok: boolean; ms: number; note: string };
let log: LogRow[] = [];
const watchers = new Set<() => void>();
let started = false;
// Listens for the server's calls once, for the window's lifetime.
export function startDispatcher() {
  if (started) return; started = true;
  listen<{ id: number; tool: string; args: Args }>('mcp-call', async (e) => {
    const { id, tool, args } = e.payload, t0 = performance.now();
    const t = TOOLS.find((x) => x.name === tool);
    let ok = true, text: string;
    try {
      if (!t) throw new Error(`No tool called ${tool}.`);
      if (t.remote && !remoteOk()) throw new Error(REMOTE_OFF);
      const r = await t.run(args ?? {});
      text = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
    } catch (err) { ok = false; text = String(err).replace(/^Error: /, ''); }
    log = [{ at: Date.now(), tool, ok, ms: Math.round(performance.now() - t0), note: ok ? '' : text.slice(0, 140) }, ...log].slice(0, 60);
    watchers.forEach((w) => w());
    invoke('mcp_reply', { id, ok, result: text });
  });
  if (pref('ads.mcp.auto') === '1') startServer().catch(() => {});
}
const definitions = () => TOOLS.map((t) => ({
  name: t.name, description: t.description,
  inputSchema: { type: 'object', properties: t.props ?? {}, ...(t.required ? { required: t.required } : {}) },
  annotations: { readOnlyHint: !!t.readOnly, destructiveHint: t.name === 'delete_file', openWorldHint: !!t.remote },
}));
export const savedPort = () => Number(pref('ads.mcp.port')) || PORT;
export async function startServer(port = savedPort()) {
  await invoke('mcp_start', { port, tools: definitions(), instructions: INSTRUCTIONS });
  window.dispatchEvent(new Event('ads-mcp'));
}
export async function stopServer() { await invoke('mcp_stop'); window.dispatchEvent(new Event('ads-mcp')); }
type Status = { running: boolean; port: number | null; uptimeSecs: number; requests: number };
export function useMcpStatus() {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    const read = () => invoke<Status>('mcp_status').then(setS, () => {});
    read();
    const t = setInterval(read, 3000);
    window.addEventListener('ads-mcp', read);
    return () => { clearInterval(t); window.removeEventListener('ads-mcp', read); };
  }, []);
  return s;
}

// ---------- The panel (Settings, AI tools) ----------
export function McpPanel({ onClose }: { onClose: () => void }) {
  const st = useMcpStatus();
  const [port, setPort] = useState(String(savedPort()));
  const [auto, setAuto] = useState(pref('ads.mcp.auto') === '1');
  const [remote, setRemote] = useState(remoteOk());
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState(log);
  const [client, setClient] = useState<'claude' | 'vscode' | 'cursor' | 'desktop'>('claude');
  const [copied, setCopied] = useState(false);
  useEffect(() => { const w = () => setRows(log); watchers.add(w); return () => { watchers.delete(w); }; }, []);
  const running = !!st?.running;
  const url = `http://127.0.0.1:${st?.port ?? (Number(port) || PORT)}/mcp`;
  const toggle = async () => {
    setBusy(true); setErr(null);
    try {
      if (running) await stopServer();
      else { const p = Number(port); if (!(p > 1023 && p < 65536)) throw new Error('Pick a port from 1024 to 65535.'); setPref('ads.mcp.port', String(p)); await startServer(p); }
    } catch (e) { setErr(String(e).replace(/^Error: /, '')); }
    setBusy(false);
  };
  const snippet = {
    claude: `claude mcp add --transport http design-studio ${url}`,
    vscode: `{\n  "servers": {\n    "design-studio": { "type": "http", "url": "${url}" }\n  }\n}`,
    cursor: `{\n  "mcpServers": {\n    "design-studio": { "url": "${url}" }\n  }\n}`,
    desktop: `{\n  "mcpServers": {\n    "design-studio": { "command": "npx", "args": ["-y", "mcp-remote", "${url}"] }\n  }\n}`,
  }[client];
  const where = { claude: 'Run this in a terminal (Claude Code).', vscode: isVsCode ? "Nothing to set up in this VS Code: while the server runs, Copilot's agent mode lists Design Studio by itself (MCP: List Servers). The setting above is for another VS Code." : 'Put this in .vscode/mcp.json, then turn the server on in Copilot agent mode.', cursor: 'Put this in ~/.cursor/mcp.json, then turn it on in Cursor settings, MCP.', desktop: "Put this in Claude Desktop's claude_desktop_config.json (needs Node.js), then restart Claude Desktop." }[client];
  const box = 'rounded-md border border-line bg-surface-2';
  return (
    <Modal title="AI tools (MCP)" sub="Let AI agents like Claude, Copilot and Cursor work in Design Studio" width={560} onCancel={onClose}
      footer={<><span className="flex-1 text-[12px] text-err select-text">{err}</span><button className={btn} onClick={onClose}>Close</button>
        <button className={btnPrimary} disabled={busy} onClick={toggle}>{busy ? <Spinner /> : running ? 'Stop' : 'Start'}</button></>}>
      <div className="flex flex-col gap-3.5 text-[12.5px]">
        <p className="m-0 text-content-secondary leading-relaxed">An agent connected here can do what you can: open and create projects, read and edit files, run AMF's checks and governance, try the mock, pull, and work with Exchange. You see every change in the editor as it happens. It runs on this computer only.</p>
        <div className={`${box} flex items-center gap-2.5 px-3 py-2`}>
          <span className="w-2 h-2 rounded-full" style={{ background: running ? 'var(--ok)' : 'var(--content-ghost)' }} />
          <span className="font-medium">{running ? 'Running' : 'Stopped'}</span>
          {running && <span className="text-content-faint">{st!.requests} {st!.requests === 1 ? 'call' : 'calls'}</span>}
          <span className="flex-1" />
          {running ? <span className="font-mono text-[11.5px] select-text">{url}</span>
            : <label className="flex items-center gap-1.5 text-content-faint">Port<input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} className="w-[64px] h-[24px] px-1.5 rounded border border-line bg-surface-input font-mono text-[11.5px] text-content outline-none focus:border-accent" /></label>}
        </div>
        <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); setPref('ads.mcp.auto', e.target.checked ? '1' : '0'); }} className="accent-[var(--accent)]" />Start when Design Studio opens</label>
        <label className="flex items-start gap-2 cursor-pointer"><input type="checkbox" checked={remote} onChange={(e) => { setRemote(e.target.checked); setPref('ads.mcp.remote', e.target.checked ? '1' : '0'); }} className="mt-0.5 accent-[var(--accent)]" />
          <span>Allow changes in Design Center and Exchange<span className="block text-[11.5px] text-content-faint">Push, new branches, new Design Center projects and Publish. Off, an agent can still pull and read. A read only Anypoint connection blocks these either way.</span></span></label>
        <div>
          <div className="flex items-center gap-1 mb-1.5">
            <span className="text-[11.5px] text-content-faint mr-1">Connect</span>
            {([['claude', 'Claude Code'], ['vscode', 'VS Code'], ['cursor', 'Cursor'], ['desktop', 'Claude Desktop']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setClient(k)} className={`h-[24px] px-2 rounded text-[11.5px] ${client === k ? 'bg-accent-dim text-accent' : 'text-content-muted hover:text-content'}`}>{l}</button>
            ))}
          </div>
          <div className="relative">
            <pre className={`${box} m-0 p-2.5 pr-9 font-mono text-[11.5px] whitespace-pre-wrap break-all select-text`}>{snippet}</pre>
            <button title="Copy" onClick={() => { navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="absolute top-1.5 right-1.5 w-[24px] h-[24px] flex items-center justify-center rounded text-content-faint hover:bg-surface-3 hover:text-content">{copied ? <Icons.Check size={13} /> : <Icons.Copy size={13} />}</button>
          </div>
          <div className="mt-1 text-[11.5px] text-content-faint">{where}</div>
        </div>
        <div>
          <div className="text-[11.5px] text-content-faint mb-1">Recent calls</div>
          <div className={`${box} max-h-[150px] overflow-auto`}>
            {rows.length ? rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2 px-2.5 py-1 border-b border-line-subtle last:border-0 text-[11.5px]">
                <span style={{ color: r.ok ? 'var(--ok)' : 'var(--err)' }}>{r.ok ? '✓' : '✕'}</span>
                <span className="font-mono">{r.tool}</span>
                <span className="text-content-faint truncate flex-1" title={r.note}>{r.note}</span>
                <span className="text-content-ghost font-mono">{r.ms} ms</span>
              </div>
            )) : <div className="px-2.5 py-2 text-[11.5px] text-content-faint">{running ? 'Nothing yet. Connect an agent with the setup above.' : 'Start the server, then connect an agent.'}</div>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
