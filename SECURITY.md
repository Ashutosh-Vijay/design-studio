# Security and privacy

Design Studio for MuleSoft is a desktop app and a VS Code extension for designing Anypoint Design Center API specs. This page lists what it does on your computer and on the network, for security and compliance reviewers who need to approve it before use.

## Summary

- **No telemetry, analytics, tracking or accounts of its own.** Nothing about you or your specs is sent anywhere unless you sign in to Anypoint and choose to sync.
- **Specs stay on your computer.** The AMF engine runs locally: a bundled Java 17 runtime runs it as a child process that talks to the app over stdin and stdout.
- **Anypoint access starts read only.** Until you turn read only off in Settings, every request that could change Design Center or Exchange is refused inside the app before it's sent.
- **Every network connection is listed below.**

## Data the app handles

| Data | Where it's kept | Leaves your computer? |
|---|---|---|
| Your spec projects | A folder you choose (by default `Design Studio` in your home folder) | Only when you push or publish to your Anypoint organization |
| Sync state, unsaved-work journal, published copies for comparison | `.apidesigner/` inside each project (git-ignored) | No |
| Settings, recent projects, Academy progress | The app's WebView storage; the desktop app keeps a copy in `prefs.json` in its data folder, so they survive the storage being cleared | No |
| Dashboard: published specs it read (for endpoint counts and version changes), its daily summary for the trend, and the addresses you check under Health | The app's cache folder (specs) and its WebView storage | No |
| The AI tools server's key | `mcp-key` in the app's data folder (desktop) or VS Code's extension storage | Only to the agents you give the address to |
| Anypoint connection settings (region, mode, read only, business group) | `anypoint.json` in the app's data folder (desktop) or VS Code's extension storage | No |
| Refresh token, your own Connected App's client secret | The system keychain (Credential Manager, Keychain or the Secret Service), under "Design Studio"; in VS Code, its SecretStorage, which uses the same keychain | No |
| Access token | Memory only | Sent to Anypoint with each request |

The app's data folder is `%APPDATA%\com.designstudio.desktop` on Windows, `~/Library/Application Support/com.designstudio.desktop` on macOS and `~/.config/com.designstudio.desktop` on Linux.

## Network activity: the complete list

1. **Update check (desktop app, not the Store or VS Code builds).** A few seconds after starting, the app asks GitHub Releases for the newest version (`github.com/Ashutosh-Vijay/design-studio/releases/latest/download/latest.json`) and downloads a newer, signed installer if there is one. It can be turned off in Settings.
2. **The sign-in client list.** When you open the sign-in form, sign in, or a sign-in is renewed, the app reads the public list of Design Studio's Connected Apps from `raw.githubusercontent.com` or `cdn.jsdelivr.net` (repository `Ashutosh-Vijay/design-studio-auth`). It holds this app's own Connected Apps, one per Anypoint cloud: each one's client ID and its secret. The secret is public on purpose: Anypoint asks for one even from an app that can't keep it, so it protects nothing here. What keeps a sign-in yours is PKCE and the login going back only to this computer (see Sign-in design).
3. **Anypoint.** After you sign in: your Anypoint cloud's host (for example `anypoint.mulesoft.com` or `eu1.anypoint.mulesoft.com`) for sign-in, token renewal, Design Center (your projects, pull, push, locks, publish) and Exchange (search, versions, dependencies). When you open the Dashboard, also these reads, always GET whatever the connection's read-only setting (the app refuses any other method on them before sending): the organization's environments and its API Governance entitlement (`/accounts/api/organizations/{org}/...`), API Governance's readings and conformance reports (`/governance/xapi/api/v1/...`, the API its own console uses), API Manager's API list per environment (`/apimanager/api/v1/organizations/{org}/environments/{env}/apis`) and Runtime Manager's app list per environment (`/armui/api/v1/applications`). Exchange's Graph API (`/graph/api/v2/graphql`) takes its queries as POST: the app sends it read queries only and refuses anything containing a mutation before sending. To count an API's endpoints and compare versions, the dashboard downloads that version's published spec from Exchange's signed link, as Import from Exchange does.
8. **Health checks** (Dashboard, Health tab): one GET to each address you type in, and only when you press Check. Nothing runs on a timer. Exchange files download from the signed links Exchange gives. The desktop app checks Anypoint's certificate against your system's certificate store, as your browser does, so it works behind a company proxy that inspects traffic.
4. **The sign-in broker (fallback only).** For an Anypoint cloud that has no client in the list above, Sign in with Anypoint goes through a small broker at `ashutosh-vijay.dev` (or `ashutosh-vijay.pages.dev`), which holds that Connected App's secret and turns the login code into tokens. It stores nothing. The sign-in form also asks it which clouds it supports. Using your own Connected App never touches it.
5. **Addresses in your specs.** When a spec includes or refers to an `http` or `https` address (`!include https://...` in RAML, a `$ref` to a URL in OAS or AsyncAPI), AMF reads that address each time it checks the spec, as Design Center does. Nothing is sent but the request for that address. A spec that only refers to its own files makes no such request.
6. **Import from URL.** Only the address you type.
7. **Links you click** (Exchange, Design Center, the maker's pages) open in your browser.

### Ports on your computer (127.0.0.1 only)

- **8765 to 8768**, only during a browser sign-in, to receive the login code. Closed straight after.
- **The local mock**, on a free port, only when you use the Documentation panel's Try it or the AI tools' mock.
- **4676, the AI tools (MCP) server**, only when you start it in Settings, AI tools. In VS Code, Copilot doesn't need it: the extension gives it the same tools through VS Code itself, with no port. Its address ends in a key made on your computer (the panel shows the full address), so another program or another user on the same machine can't call it without being given that address. It also refuses requests whose Host isn't this computer and requests from web pages. An agent connected to it can do what you can in the app; changes in Design Center and Exchange through it are off until you allow them, and a read-only connection blocks them either way.

## Sign-in design

Sign in with Anypoint uses a Connected App per Anypoint cloud that belongs to this project. A desktop app can't keep a secret, so those apps require PKCE (only the copy of the app that started a sign-in can finish it) and only send the login back to `localhost` ports 8765 to 8768. You can also use your own Connected App instead (authorization code or client credentials); its secret goes to the system keychain.

## Reporting a vulnerability

Email issues@ashutosh-vijay.dev with the details. Please don't open a public issue for a security problem.

## Third-party software

AMF is MuleSoft's, under the Apache License 2.0. Design Studio is not affiliated with, endorsed by or sponsored by MuleSoft or Salesforce. Anypoint, Design Center, Exchange and MuleSoft are trademarks of Salesforce, Inc.
