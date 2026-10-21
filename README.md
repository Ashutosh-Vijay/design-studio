# Design Studio for MuleSoft

A fast designer for Anypoint Design Center API specs, RAML and OAS, where the visual editor and the code stay in sync both ways. It works on big specs, online or offline, as a desktop app and as a VS Code extension.

Every edit is checked by AMF, the engine Design Center uses. It syncs with Design Center and Exchange, checks governance rulesets, runs a local mock, lets AI agents work in it over MCP, and teaches API design in the API Design Academy.

Status: beta. See [docs/PLAN.md](docs/PLAN.md) for the plan and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it's built.

## Build

- **Desktop:** `mvn package` in `amf-server/` (Java 17 or later), then `npm install` and `npm run tauri dev`.
- **VS Code:** `npm run build:vscode`, then see [vscode-extension/DEVELOPMENT.md](vscode-extension/DEVELOPMENT.md).
