# Releasing

A tag `vX.Y.Z` builds and publishes everything: the desktop app for Windows, macOS (Apple Silicon and Intel) and Linux with the updater's `latest.json`, and a `.vsix` per platform, all on one GitHub release; the `.vsix` also goes to the Marketplace once `VSCE_PAT` is set. The workflow (`.github/workflows/release.yml`) has no version numbers of its own: it reads the tag, and its first step, `npm run release:check`, stops the release if anything below disagrees.

**While in beta, VS Code only:** `DESKTOP: "false"` at the top of `release.yml` skips the desktop builds; the tag then makes a pre-release named "Design Studio for VS Code vX.Y.Z (BETA)" with the four `.vsix` and VS Code-only notes (`release-notes.mjs --vscode`). The extension's display name carries "(BETA)". Set `DESKTOP` to `"true"` and drop "(BETA)" when the desktop app ships.

Adapted from DataWeave Studio's routine, including what it learned the hard way.

## 1. Decide the version

App-milestone semver: a major user-facing capability is a minor bump while in beta (0.x), fixes are a patch.

## 2. Bump it everywhere

`release:check` compares them all:

- `package.json`, and `package-lock.json` (the top `version` and `packages[""].version`)
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`, and the `design-studio` entry in `src-tauri/Cargo.lock`
- `vscode-extension/package.json` (CI also stamps the tag's version into it)

## 3. Write the notes, for users

- **`src/releases.json`**: a new entry on top; never delete old ones. The app shows it in About (What's new), opens it once after an update, and the GitHub release text is made from it (`scripts/release-notes.mjs`). `"only": "desktop"` or `"vscode"` keeps an item to one runtime.
- **`vscode-extension/CHANGELOG.md`**: move Unreleased into `## X.Y.Z`. Do this **before tagging**: the Marketplace refuses to publish the same version twice, so a missing changelog costs a new patch release.
- What goes in: each new feature once, plus fixes to things that already shipped. Not its sub-parts, not developer-facing work, not a walk through the git log. Plain words, no em dashes.

## 4. Check the words people read

- README, `vscode-extension/README.md`, About, the start screen: still true? (Sign-in clouds, counts like "33 tools" or "46 lessons".)
- **Network behaviour changed?** Update the complete list in `SECURITY.md` and the summary in `PRIVACY.md`.
- **UI changed?** Retake the screenshots (`docs/screenshots/`, 1600x1000, dark and light) on the Library API showcase project, never a real one. Before committing, look at every recent list, path, host and project name in them: nothing from work, ever.

## 5. Run the checks

```bash
npm run release:check
```

```bash
npx tsc --noEmit -p . && npm run build && npm run build:vscode
```

```bash
cd amf-server && mvn -q package && cd .. && npm run academy:verify && npm run starters:verify
```

```bash
cd vscode-extension && npm run compile
```

- `cargo check` fails with "os error 32" while `tauri dev` runs (the exe is locked): use `CARGO_TARGET_DIR` outside `src-tauri/target`, or stop the dev app.
- After an `amf-server` change, the dev app needs the new jar copied to `src-tauri/resources/amf-server/` (CI does this itself).
- Smoke test both: the desktop app (open a project, a full check, governance, Try it) and a packaged `.vsix` in a clean VS Code profile (`vscode-extension/DEVELOPMENT.md`).

## 6. Before the first public release only

- The updater reads `latest.json` from this repo's releases, and the README links there: both need the repo public (PLAN 10.5 has the checklist, including the MIT licence and history scrub).
- Secrets: `TAURI_SIGNING_PRIVATE_KEY` and its password are set; `VSCE_PAT` (Marketplace publisher `ashutosh-vijay`) is the developer's to add.
- The Connected Apps: a trial org that expires soon breaks every sign-in through it. Check the dates (PLAN section 9) and rotate first if one is close.

## 7. Commit, tag, push

```bash
git commit -am "Release vX.Y.Z"
```

```bash
git tag -a vX.Y.Z -m "Design Studio X.Y.Z" && git push origin main vX.Y.Z
```

The build takes about 20 minutes. A platform that fails (Maven Central sometimes answers 429 to GitHub's runners) leaves the release as a draft with the others' files: `gh run rerun <id> --failed`, and the publish job releases it.

## 8. After

- The release has every installer, the portable and zipped Windows builds, `latest.json` and four `.vsix`.
- An installed older version finds the update by itself (About shows it).
- The Marketplace listing shows the version and the changelog.
- The download page on the website points at the new version.
