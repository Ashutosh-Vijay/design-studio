# Privacy policy: Design Studio for MuleSoft

_Last updated: 2026-11-15_

Design Studio (the desktop app and the VS Code extension) has no telemetry, analytics, crash reporting or accounts of its own.

## What stays on your computer

Your spec projects, settings, recent projects, Academy progress and unsaved-work journal stay on your computer. Your Anypoint refresh token, and your own Connected App's secret if you use one, are kept in the system keychain. The access token is kept in memory only.

## What goes over the network, and only for this

- **Anypoint**, after you sign in: your specs and project changes go to and from your own Anypoint organization when you pull, push or publish, and the app reads Design Center and Exchange for you. The Dashboard also reads your organization's environments, API Governance, API Manager and Runtime Manager, and the published specs of your APIs; it only reads. A small daily summary of its counts (how many APIs, how many governed and conformant) and the addresses you check under Health are kept on your computer.
- **Health checks** (Dashboard): one GET to each address you type in, only when you press Check.
- **Signing in**: the app reads the public list of its own Connected Apps from GitHub (or jsDelivr). For an Anypoint cloud not on that list, the sign-in goes through a small broker on `ashutosh-vijay.dev`, which turns the login code into tokens and keeps nothing.
- **Updates** (desktop app only): a check for a newer version on GitHub Releases, which can be turned off in Settings. The VS Code extension is updated by the Marketplace.
- **Addresses in your specs**: when a spec includes or refers to an `http` or `https` address, the checking engine reads it, as Design Center does.
- **Import from URL**: only the address you enter.

The complete list, with every address and port, is in [SECURITY.md](SECURITY.md).

## AI tools

If you start the AI tools (MCP) server, agents you connect to it on your computer can read and change your projects in the app, as you can. Their requests and your specs go to whatever AI service you use with that agent, under that service's terms.

## Contact

issues@ashutosh-vijay.dev
