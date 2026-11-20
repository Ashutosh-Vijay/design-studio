# Changelog

New work collects under Unreleased and moves into a version when it ships. The same notes are in the app (About, What's new).

## Unreleased

- **Indentation guides** in the editor: a faint line at each indent level, so you can see what sits under what.
- **Enter indents where you are**: one level deeper after a new key (`name:`), the same level after a value, and at the item's level inside a `- ` list.
- **Nested types in the Inspector**: a type's properties show as deep as they go, through objects and lists of lists, each with its own required box.
- **A new type from JSON** in any file with types, including libraries: name it and paste the JSON. Replacing the type you're in is now a choice, not the default.
- Fixed: an example file created from the editor couldn't be opened from its `!include` until the file was reopened.
- Fixed: Review changes didn't scroll when several files were open; every file's changes now scroll in one list.

## 0.1.0 (November 2026): the first beta

- **Design Center specs, fast**: open RAML, OAS and AsyncAPI projects of any size in seconds. Every edit is checked by AMF, the engine Design Center uses, so errors show as you type. Suggestions for types, traits and `!include` paths are instant, and Design Center's shelf sits under the editor. RAML and OAS are coloured as in Design Center, by resource, method, trait and schema. Work on several projects at once, each in its own window (in VS Code, its own tab).
- **Forms and code in step**: build a new API from the forms, as with Design Center's Guide me through it, or edit any spec with them: resources, methods, types, parameters, security schemes and responses for RAML 1.0 and OAS 3.0 and 3.1, and servers, channels, messages and schemas for AsyncAPI. Switch between forms and code any time, and a form changes only the lines it must. Or start from a secured starter that passes MuleSoft's best-practice and OWASP security rulesets. Check a sample body against any type, and copy an OAS schema as a RAML type. Create a missing example file from its type, or a type from pasted JSON. Rename a type everywhere, find its uses, extract to a library, or delete with cascade.
- **Design Center and Exchange**: sign in with Anypoint, pull your projects, put a project made on your computer into Design Center, see every line a push will send, push with the branch lock, work on branches and merge with conflict help. Publish to Exchange with a suggested version, manage Exchange dependencies, and see what changed since the last version. Connections start read only.
- **Governance, docs and a local mock**: check your API against the rulesets it depends on, read it as documentation, try any method on a local mock that answers like Design Center's, and see every type's uses on the API map.
- **Your organization at a glance**: the Dashboard shows every API in Exchange with its versions, endpoints and what changed between them, whether API Governance covers it and what conforms, what is managed and deployed in each environment, and who published what. Health checks the addresses you choose, with the method, headers and status codes your APIs need. Open an API in Design Center or pull it here in one click, and export every endpoint to Excel. It only reads, and shows only what your Anypoint permissions allow.
- **AI tools**: Copilot's agent mode can use Design Studio's tools directly, with nothing to set up: open projects, edit specs, run AMF's checks and governance, try the mock and work with Design Center, while you watch every change. Claude Code, Cursor and other agents can connect too, over MCP.
- **API Design Academy**: 46 lessons, from how computers talk (HTTP, JSON, integration, MuleSoft) to all of RAML (types, resource types, traits, security schemes, fragments, libraries), Design Center, Exchange, APIkit and API Manager, with exam-style practice for the MuleSoft Developer I and II certifications. Every lesson has something to try or answer, and AMF checks what you write.
- **Made to fit**: pick the editor and interface fonts, text sizes and line spacing, where new projects go, and Design Center or Design Studio colours. It can follow your VS Code theme.
