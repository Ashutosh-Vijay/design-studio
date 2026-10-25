# Design Studio for MuleSoft

A fast designer for Anypoint Design Center API specs, RAML and OAS, right inside VS Code.

Big specs open in seconds, and every edit is checked as you type by AMF, the same engine Design Center uses. It works the way Design Center does, with the same words (Root file, Project errors, Exchange dependencies, Publish), so there's nothing new to learn.

> **Beta.** Tell us what you hit.

## What you get

- **An editor that keeps up**: instant suggestions for types, traits and `!include` paths, the API tree, and Design Center's shelf under the editor.
- **Forms and code in step**: the Inspector edits resources, methods, types and parameters, and changes only the lines it must.
- **Refactorings**: rename a type everywhere, find references, extract to a library, delete with cascade.
- **Design Center sync**: sign in, pull projects, push with the branch lock, branches, and merge with conflict help.
- **Exchange**: publish with a suggested version, add and update dependencies, and see what changed since the last version.
- **Governance**: check your API against the rulesets it depends on.
- **A local mock**: try every method with Design Center's MS2 headers, unsaved edits included.
- **AI tools**: Copilot's agent mode can use Design Studio's tools directly, with nothing to set up: open projects, edit specs, run AMF's checks and governance, try the mock. You watch every change happen, and tools that change something ask first. Claude Code, Cursor and other agents can connect too (Settings, AI tools).
- **API Design Academy**: 16 short lessons, from "what is an API" to libraries, publishing and OAS, each one checked by AMF.

## Getting started

- Command Palette: **Design Studio: Open**.
- Explorer: right-click a project folder or a `.raml` file, then **Open in Design Studio**.
- New to API design? **Design Studio: API Design Academy**.

Everything is included: the AMF engine and a small Java runtime, so you don't need Java installed. Your specs stay on your computer; you only sign in to pull, push and publish.

## Signing in

**Sign in with Anypoint** opens your browser and comes back to VS Code on this computer (localhost ports 8765 to 8768). It works in the US and India Anypoint clouds today; in every other cloud, use your own Connected App. Connections start read only, so nothing in Design Center changes until you turn that off in Settings.

Remote windows (SSH, WSL, dev containers, Codespaces) aren't supported in this beta: run VS Code locally.
