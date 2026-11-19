# Contributing to Design Studio for MuleSoft

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

[Open an issue](https://github.com/Ashutosh-Vijay/design-studio/issues/new/choose) with:

- where you ran it (VS Code or the desktop app, and the version from About);
- what you did, what you expected, and what happened;
- the smallest spec that shows it.

**Never paste your company's specs, tokens or org names.** Cut the spec down to a few made-up lines that still show the problem. If the bug is about security, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Building it

- **Desktop:** Java 17 or later and Maven, Node 22, Rust. `mvn package` in `amf-server/`, then `npm install` and `npm run tauri dev`.
- **VS Code:** `npm run build:vscode`, then follow [vscode-extension/DEVELOPMENT.md](vscode-extension/DEVELOPMENT.md).

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit: the webview, the Rust and Node backends, and the AMF engine.

## Before you open a pull request

Run the checks CI runs:

```bash
npm run release:check
```

```bash
npx tsc --noEmit -p . && npm run build && npm run build:vscode
```

```bash
cd amf-server && mvn -q package && cd .. && npm run academy:verify && npm run starters:verify && npm run sync:verify
```

```bash
cd vscode-extension && npm run compile && npm run verify
```

## A few rules the code keeps

- **The text is the master copy.** Forms and refactorings change a spec with the smallest possible text edit (`src/splice.ts`). Never regenerate a file from a model: it reformats the whole thing.
- **Both hosts.** Shared code runs in the desktop app and in VS Code. A new backend command needs both the Rust version (`src-tauri/`) and the Node version (`vscode-extension/src/`).
- **Every Anypoint call goes through `call()`,** so read-only connections stay read only.
- **Words people read** are plain and friendly, use Design Center's names for things, and never contain em dashes.
- **Keep it simple.** Small, direct code over layers and abstractions.

By contributing, you agree your contribution is licensed under the [MIT License](LICENSE).
