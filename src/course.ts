// API Design Academy: the course, and its grader. Every lesson's solution is run through AMF by
// scripts/academy-verify.mjs before it ships (the solution must pass every goal, the starter must not, and
// each "wrong" must fail), so the course never teaches something the engine doesn't accept.

export type Block = { p: string } | { list: string[] } | { callout: string; text: string } | { code: string } | { steps: string[] };
// One thing the learner's spec must have, read from AMF's model of it. `say` is shown when it's missing.
export type Goal = {
  say: string;
  title?: string; version?: string; spec?: string;
  endpoint?: string; method?: string; response?: string; bodyType?: string; requestType?: string; example?: boolean;
  param?: string; paramType?: string; paramIn?: string; paramRequired?: boolean; is?: string;
  type?: string; property?: string; propType?: string; required?: boolean; file?: string;
};
export type Check =
  | { kind: 'choice'; question: string; options: { text: string; correct?: boolean; why: string }[] }
  | { kind: 'build'; prompt: string; goals: Goal[]; hints: string[] };
export type Lesson = {
  id: string; title: string; minutes: number; body: Block[];
  // The editor's files (the first is the root file). Read-only lessons show an example; build lessons start here.
  files: Record<string, string>; readOnly?: boolean; http?: boolean;
  solution?: Record<string, string>; wrong?: Record<string, string>[];
  check: Check;
};
export type Part = { title: string; note: string; lessons: Lesson[] };

// ---------- The grader ----------
type Op = { method: string; parameters: { name: string; in: string; required: boolean; type: string }[]; body: { type: string; example?: string }[]; responses: { code: string; body: { type: string; example?: string }[] }[]; is: string[] };
export type Model = {
  title?: { v: string }; version?: { v: string };
  endpoints?: { path: string; operations: Op[] }[];
  types?: { name: string; type: string; at?: { file: string }; properties?: { name: string; type: string; required: boolean }[] }[];
};
export type Problem = { severity: string; message: string; file: string; line: number; col: number };
export function grade(goals: Goal[], model: Model, spec: string, problems: Problem[]) {
  const errors = problems.filter((p) => p.severity === 'error');
  const results = goals.map((g) => {
    if (g.title != null && model.title?.v !== g.title) return false;
    if (g.version != null && model.version?.v !== g.version) return false;
    if (g.spec != null && spec !== g.spec) return false;
    if (g.endpoint != null) {
      const e = model.endpoints?.find((x) => x.path === g.endpoint); if (!e) return false;
      if (g.method != null) {
        const o = e.operations.find((x) => x.method === g.method); if (!o) return false;
        if (g.is != null && !o.is.includes(g.is)) return false;
        if (g.requestType != null && !o.body.some((b) => b.type === g.requestType)) return false;
        if (g.param != null) {
          const p = o.parameters.find((x) => x.name === g.param); if (!p) return false;
          if (g.paramType != null && p.type !== g.paramType) return false;
          if (g.paramIn != null && p.in !== g.paramIn) return false;
          if (g.paramRequired != null && p.required !== g.paramRequired) return false;
        }
        if (g.response != null) {
          const r = o.responses.find((x) => x.code === g.response); if (!r) return false;
          if (g.bodyType != null && !r.body.some((b) => b.type === g.bodyType)) return false;
          if (g.example && !r.body.some((b) => b.example)) return false;
        }
      }
    }
    if (g.type != null) {
      const t = model.types?.find((x) => x.name === g.type); if (!t) return false;
      if (g.file != null && t.at?.file !== g.file) return false;
      if (g.property != null) {
        const p = t.properties?.find((x) => x.name === g.property); if (!p) return false;
        if (g.propType != null && p.type !== g.propType) return false;
        if (g.required != null && p.required !== g.required) return false;
      }
    }
    return true;
  });
  return { errors, results, passed: !errors.length && results.every(Boolean) };
}

// ---------- The course ----------
const S13 = `#%RAML 1.0
title: Library API
version: v1
baseUri: https://api.example.com/library/{version}
mediaType: application/json
`;
const S14 = S13 + `
/books:
  /{bookId}:
`;
const S15 = S13 + `
/books:
  get:
    responses:
      200:
        description: The books in the catalogue
  post:
    responses:
      201:
        description: The book was added
  /{bookId}:
    get:
      responses:
        200:
          description: One book
        404:
          description: There's no book with that id
`;
const TYPES16 = `types:
  Book:
    type: object
    properties:
      title: string
      year: integer
      isbn?: string
`;
const S16 = S15.replace('mediaType: application/json\n', 'mediaType: application/json\n\n' + TYPES16);
const S17 = S13 + '\n' + TYPES16 + `
/books:
  get:
    responses:
      200:
        body:
          type: Book[]
  post:
    body:
      type: Book
    responses:
      201:
        description: The book was added
  /{bookId}:
    get:
      responses:
        200:
          body:
            type: Book
            example:
              title: Dune
              year: 1965
        404:
          description: There's no book with that id
`;
const S18 = S17.replace(`/books:
  get:
    responses:`, `/books:
  get:
    queryParameters:
      limit?:
        type: integer
        minimum: 1
        maximum: 100
    responses:`);
const S19 = S18.replace(`mediaType: application/json
`, `mediaType: application/json

traits:
  pageable:
    queryParameters:
      page?:
        type: integer
        minimum: 1
`).replace(`/books:
  get:
    queryParameters:`, `/books:
  get:
    is: [pageable]
    queryParameters:`);

const LIB21 = `#%RAML 1.0 Library
usage: The Library API's data types

types:
  Book:
    type: object
    properties:
      title: string
      year: integer
      isbn?: string
`;
const ROOT21 = `#%RAML 1.0
title: Library API
version: v1
mediaType: application/json

types:
  Book:
    type: object
    properties:
      title: string
      year: integer
      isbn?: string

/books:
  /{bookId}:
    get:
      responses:
        200:
          body:
            type: Book
`;
const SAMPLE = `#%RAML 1.0
title: Library API
version: v1
baseUri: https://api.example.com/library/{version}
mediaType: application/json

types:
  Book:
    type: object
    properties:
      title: string
      year: integer
      isbn?: string

/books:
  get:
    responses:
      200:
        body:
          type: Book[]
          example:
            - title: Dune
              year: 1965
  post:
    body:
      type: Book
    responses:
      201:
        description: The book was added
`;
const OAS31 = `openapi: 3.0.0
info:
  title: Library API
  version: v1
paths: {}
`;
const OAS31_SOLVED = `openapi: 3.0.0
info:
  title: Library API
  version: v1
paths:
  /books:
    get:
      responses:
        '200':
          description: The books in the catalogue
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Book'
components:
  schemas:
    Book:
      type: object
      required: [title, year]
      properties:
        title:
          type: string
        year:
          type: integer
        isbn:
          type: string
`;

export const PARTS: Part[] = [
  { title: 'Part 1 · Start here', note: 'No API or RAML knowledge needed. One running example: a library\'s catalogue of books.', lessons: [
    { id: '1.1', title: 'What an API is', minutes: 4, http: true, files: {},
      body: [
        { p: 'Apps don\'t share a brain. When one needs something from another, it sends a *request* over HTTP and gets a *response* back. An *API* is the list of requests a system accepts, and what it answers to each.' },
        { p: 'A request has two main parts:' },
        { list: ['The **resource**: what it is about, written as a path, like `/books` (all the books) or `/books/42` (one of them).', 'The **method**: what to do with it. `GET` reads, `POST` creates, `PUT` replaces, `PATCH` changes part of it, `DELETE` removes it.'] },
        { p: 'The response starts with a *status code*: `200` OK, `201` Created, `400` the request was wrong, `404` there\'s nothing there. Most responses also carry a *body*, usually JSON.' },
        { callout: 'Try it', text: 'Send the requests on the right to a pretend library and watch what comes back.' },
      ],
      check: { kind: 'choice', question: 'A librarian\'s app wants to add a new book to the catalogue. Which request fits?', options: [
        { text: '`GET /books`', why: 'GET only reads. It would list the books, not add one.' },
        { text: '`POST /books`', correct: true, why: 'Right. POST to a collection creates a new item in it, and the answer is usually 201 Created.' },
        { text: '`DELETE /books/42`', why: 'DELETE removes a book. It\'s the opposite.' },
      ] } },
    { id: '1.2', title: 'Design first', minutes: 3, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: 'In MuleSoft, an API usually starts as a *spec*: a file that says which resources and methods exist, what each one takes and what it answers. You write it in Design Center (or here), before anyone writes the Mule app behind it.' },
        { steps: ['Design the spec', 'Try it on the mock', 'Publish to Exchange', 'Build it in Mule'] },
        { p: 'Why first? Because the spec is a *contract*. The people who will call the API can read it, try it on a mock that answers with the spec\'s own examples, and start their work, while the Mule app is still being built. Mule developers then scaffold their flows from the same file.' },
        { p: 'Specs are written in one of two languages: **RAML**, MuleSoft\'s own, and **OAS** (OpenAPI), the industry\'s. This course starts with RAML, which most Design Center projects use, and shows OAS at the end.' },
        { callout: 'On the right', text: 'A small RAML spec. You don\'t need to understand it yet: by lesson 1.7 you will have written one like it.' },
      ],
      check: { kind: 'choice', question: 'Why write the spec before building the Mule app?', options: [
        { text: 'Because Mule can\'t run without RAML', why: 'Mule apps can run without a spec. The spec is for agreeing on the API, not a technical requirement.' },
        { text: 'So callers and builders agree on the API, and callers can start on a mock right away', correct: true, why: 'Exactly. The spec is the contract both sides work from, and the mock lets callers try it before it exists.' },
        { text: 'Because specs make the API faster', why: 'A spec describes the API. It has no effect on how fast it runs.' },
      ] } },
    { id: '1.3', title: 'Meet RAML', minutes: 5, files: { 'library.raml': '#%RAML 1.0\n' }, solution: { 'library.raml': S13 },
      body: [
        { p: 'A RAML file starts with the line `#%RAML 1.0`. Then come the API\'s details, each as a *key*, a colon, and a value:' },
        { code: '#%RAML 1.0\ntitle: Library API\nversion: v1\nbaseUri: https://api.example.com/library/{version}\nmediaType: application/json' },
        { list: ['`title` is the only one RAML requires.', '`baseUri` is where the API will live. `{version}` in it is filled in from `version`.', '`mediaType` sets the format of every body, so you don\'t repeat it everywhere.'] },
        { p: 'RAML is written in *YAML*, where *indentation is structure*: two spaces for each level, never tabs. A key at the left edge belongs to the API itself.' },
        { callout: 'Watch the right side', text: 'AMF, the engine Design Center uses, reads your file as you type. Mistakes show with a red underline, and what it understood shows under the editor.' },
      ],
      check: { kind: 'build', prompt: 'Give the API the title `Library API` and the version `v1`.', hints: ['Each detail goes on its own line at the left edge, like `title: Library API`.', 'The version line is `version: v1`.'],
        goals: [{ say: 'The title is Library API', title: 'Library API' }, { say: 'The version is v1', version: 'v1' }] } },
    { id: '1.4', title: 'Resources', minutes: 4, files: { 'library.raml': S13 }, solution: { 'library.raml': S14 },
      body: [
        { p: 'Resources are the nouns of an API. In RAML each one is a key that starts with `/`, at the left edge:' },
        { code: '/books:\n  /{bookId}:' },
        { p: '`/books` is the *collection*. `/{bookId}` is nested inside it (two spaces in), so its full path is `/books/{bookId}`: one book. The part in braces is a *URI parameter*, filled in by the caller: `/books/42`.' },
        { list: ['Name collections with plural nouns: `/books`, `/loans`, `/members`.', 'Nest an item under its collection instead of writing `/books/{bookId}` as a separate top-level key. Design Center\'s API tree shows the nesting.'] },
        { p: 'A resource with nothing under it is fine for now. The next lesson gives it methods.' },
      ],
      check: { kind: 'build', prompt: 'Add the `/books` collection, with `/{bookId}` nested inside it.', hints: ['Start a new line at the left edge with `/books:`.', 'On the next line, two spaces in: `/{bookId}:`.'],
        goals: [{ say: 'There is a /books resource', endpoint: '/books' }, { say: 'There is a /books/{bookId} resource', endpoint: '/books/{bookId}' }] } },
    { id: '1.5', title: 'Methods and responses', minutes: 5, files: { 'library.raml': S14 }, solution: { 'library.raml': S15 },
      body: [
        { p: 'Under a resource, list the methods it supports. Under each method, `responses` lists the status codes it can answer with:' },
        { code: '/books:\n  get:\n    responses:\n      200:\n        description: The books in the catalogue' },
        { p: 'The usual pattern, which Design Center\'s shelf suggests too:' },
        { list: ['`get` on a collection lists it: `200`.', '`post` on a collection creates an item: `201`.', '`get` on an item reads it: `200`, or `404` when there\'s no such item.'] },
        { p: 'Each level is two more spaces in. If AMF underlines something, the indentation is the first thing to check.' },
      ],
      check: { kind: 'build', prompt: 'Give `/books` a `get` (200) and a `post` (201), and give `/books/{bookId}` a `get` that answers 200 or 404.', hints: ['Methods go two spaces inside their resource: `get:` under `/books:`.', 'Under the method: `responses:`, then the code (`200:`), then `description: ...`.', 'The `get` of `/{bookId}` sits two spaces inside `/{bookId}:`, which is itself inside `/books:`.'],
        goals: [
          { say: 'GET /books answers 200', endpoint: '/books', method: 'get', response: '200' },
          { say: 'POST /books answers 201', endpoint: '/books', method: 'post', response: '201' },
          { say: 'GET /books/{bookId} answers 200', endpoint: '/books/{bookId}', method: 'get', response: '200' },
          { say: 'GET /books/{bookId} answers 404', endpoint: '/books/{bookId}', method: 'get', response: '404' },
        ] } },
    { id: '1.6', title: 'Data types', minutes: 5, files: { 'library.raml': S15 }, solution: { 'library.raml': S16 },
      body: [
        { p: 'A *type* describes the shape of the data: what a book looks like. Types are declared once, under `types` at the top level, and used anywhere by name.' },
        { code: TYPES16.trimEnd() },
        { list: ['`type: object` means it has properties.', 'Each property has a type: `string`, `integer`, `number`, `boolean`, `date-only`, `datetime` and more.', 'A name ending in `?` is optional (`isbn?`). Every other property is required.', 'A list of books is written `Book[]`.'] },
        { p: 'Type names start with a capital letter by convention, which is how Design Center\'s Types and Traits shelf lists them.' },
      ],
      check: { kind: 'build', prompt: 'Declare a `Book` type with a required `title` (string), a required `year` (integer) and an optional `isbn` (string).', hints: ['`types:` goes at the left edge, above `/books:`.', 'Then `Book:` two spaces in, and `type: object` and `properties:` under it.', 'An optional property: `isbn?: string`.'],
        goals: [
          { say: 'There is a Book type', type: 'Book' },
          { say: 'Book has a required title, a string', type: 'Book', property: 'title', propType: 'string', required: true },
          { say: 'Book has a required year, an integer', type: 'Book', property: 'year', propType: 'integer', required: true },
          { say: 'Book has an optional isbn, a string', type: 'Book', property: 'isbn', propType: 'string', required: false },
        ] } },
    { id: '1.7', title: 'Bodies and examples', minutes: 6, files: { 'library.raml': S16 }, solution: { 'library.raml': S17 },
      wrong: [{ 'library.raml': S17.replace('year: 1965', 'year: nineteen sixty-five') }],
      body: [
        { p: 'A *body* says what a request sends or a response returns. Since `mediaType` is set at the top, a body only needs its `type`:' },
        { code: '/{bookId}:\n  get:\n    responses:\n      200:\n        body:\n          type: Book\n          example:\n            title: Dune\n            year: 1965' },
        { p: 'An *example* shows a real value. The mock answers with it, and the API\'s documentation shows it. AMF checks every example against its type: an example that doesn\'t fit is an error, the same as in Design Center.' },
        { list: ['A response body: under the status code.', 'A request body (what `post` sends): directly under the method, next to `responses`.'] },
        { callout: 'Try it', text: 'Once it passes, change the example\'s `year` to some text and watch AMF complain.' },
      ],
      check: { kind: 'build', prompt: 'Make `GET /books` return `Book[]`, `POST /books` take a `Book`, and `GET /books/{bookId}` return a `Book` with an example.', hints: ['Under `200:` of `get`, write `body:` and then `type: Book[]` two spaces in.', 'For `post`, `body:` goes directly under `post:`, beside `responses:`.', 'The example sits next to `type: Book`, with `title` and `year` under it.'],
        goals: [
          { say: 'GET /books returns Book[]', endpoint: '/books', method: 'get', response: '200', bodyType: 'Book[]' },
          { say: 'POST /books takes a Book', endpoint: '/books', method: 'post', requestType: 'Book' },
          { say: 'GET /books/{bookId} returns a Book', endpoint: '/books/{bookId}', method: 'get', response: '200', bodyType: 'Book' },
          { say: 'That response has an example', endpoint: '/books/{bookId}', method: 'get', response: '200', example: true },
        ] } },
    { id: '1.8', title: 'Parameters', minutes: 5, files: { 'library.raml': S17 }, solution: { 'library.raml': S18 },
      body: [
        { p: 'Callers can pass extra details in the URL after a `?`, like `/books?limit=10`. These are *query parameters*, declared under the method:' },
        { code: 'get:\n  queryParameters:\n    limit?:\n      type: integer\n      minimum: 1\n      maximum: 100' },
        { p: 'Like properties, query parameters are required unless the name ends in `?` (or has `required: false`). A required `limit` would make every call without it a bad request, so it\'s optional here.' },
        { p: 'Facets like `minimum` and `maximum` say which values are allowed. The mock and Mule\'s APIkit both enforce them.' },
      ],
      check: { kind: 'build', prompt: 'Let `GET /books` take an optional `limit` query parameter, an integer.', hints: ['`queryParameters:` goes under `get:`, beside `responses:`.', 'Then `limit?:` and, under it, `type: integer`.'],
        goals: [{ say: 'GET /books has an optional integer limit in the query', endpoint: '/books', method: 'get', param: 'limit', paramType: 'integer', paramIn: 'query', paramRequired: false }] } },
    { id: '1.9', title: 'Reuse: traits', minutes: 5, files: { 'library.raml': S18 }, solution: { 'library.raml': S19 },
      body: [
        { p: 'Many methods share behaviour: paging, a correlation header, error responses. Instead of writing it on each one, declare it once as a *trait* and apply it with `is`:' },
        { code: 'traits:\n  pageable:\n    queryParameters:\n      page?:\n        type: integer\n\n/books:\n  get:\n    is: [pageable]' },
        { p: 'A trait\'s content is merged into every method that uses it. *Resource types* do the same for whole resources: a `collection` type can give every collection its `get` and `post`.' },
        { p: 'Design Center\'s Rename and Delete keep these references in step across files. Design Studio does too: F2 on a trait\'s name renames it everywhere.' },
      ],
      check: { kind: 'build', prompt: 'Declare a `pageable` trait with an optional integer `page` query parameter, and apply it to `GET /books`.', hints: ['`traits:` goes at the left edge, like `types:`.', 'Apply it with `is: [pageable]` directly under `get:`.'],
        goals: [{ say: 'GET /books is pageable', endpoint: '/books', method: 'get', is: 'pageable' }] } },
  ] },
  { title: 'Part 2 · The Design Center way', note: 'How real projects are split, shared, mocked, published and checked.', lessons: [
    { id: '2.1', title: 'Libraries and fragments', minutes: 6, files: { 'library.raml': ROOT21, 'libraries/types.raml': '#%RAML 1.0 Library\nusage: The Library API\'s data types\n' },
      solution: { 'library.raml': ROOT21.replace(/types:\n {2}Book:[\s\S]*?isbn\?: string\n\n/, 'uses:\n  lib: libraries/types.raml\n\n').replace('type: Book', 'type: lib.Book'), 'libraries/types.raml': LIB21 },
      body: [
        { p: 'Big APIs are split into files. A *library* starts with `#%RAML 1.0 Library` and holds types, traits and resource types. The root file brings it in with `uses`, giving it a short name:' },
        { code: 'uses:\n  lib: libraries/types.raml\n\n# then, anywhere in the root file:\ntype: lib.Book' },
        { p: 'A *fragment* is a single piece in its own file (one type, one example, one trait), pulled in with `!include`: `example: !include examples/book.json`.' },
        { list: ['Libraries are how teams share types across APIs: published to Exchange, they become *Exchange dependencies* of other projects.', 'The root file is the one Design Center checks and publishes. The others are reached from it.'] },
        { callout: 'Two files', text: 'This lesson has two. Switch between them with the tabs above the editor.' },
      ],
      check: { kind: 'build', prompt: 'Move `Book` into the library `libraries/types.raml`, bring it in with `uses` as `lib`, and use it as `lib.Book`.', hints: ['Cut the whole `types:` block from library.raml and paste it at the end of libraries/types.raml.', 'In library.raml, where `types:` was: `uses:` and, under it, `lib: libraries/types.raml`.', 'Then the response body becomes `type: lib.Book`.'],
        goals: [
          { say: 'Book is declared in libraries/types.raml', type: 'Book', file: 'libraries/types.raml' },
          { say: 'GET /books/{bookId} returns lib.Book', endpoint: '/books/{bookId}', method: 'get', response: '200', bodyType: 'lib.Book' },
        ] } },
    { id: '2.2', title: 'Exchange and dependencies', minutes: 3, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: '*Exchange* is Anypoint\'s catalogue. Published specs, libraries, examples and rulesets live there, each as an *asset* with a group, an id and versions.' },
        { p: 'When a project depends on an Exchange asset, Design Center lists it in `exchange.json` and keeps a copy under `exchange_modules/`. You then `uses:` or `!include` it from there, like any file in the project. The copy is read only: to change it, change the asset and publish a new version.' },
        { list: ['A shared library of types is the most common dependency: every API of a team uses the same `Customer` and `Error`.', 'Changing a dependency\'s version updates the folder and every path that points into it.'] },
        { p: 'In Design Studio, the Dependencies panel on the left adds, updates and removes them.' },
      ],
      check: { kind: 'choice', question: 'You need a fix that was made in version 1.0.3 of a shared types library your API depends on (you have 1.0.1). What do you do?', options: [
        { text: 'Edit the files under `exchange_modules/`', why: 'Those are a read only copy of the published asset. Edits there aren\'t yours to make and would be lost.' },
        { text: 'Change the dependency to version 1.0.3', correct: true, why: 'Right. The new version is fetched, and the paths pointing into the old folder are updated.' },
        { text: 'Copy the fixed type into your own spec', why: 'Then your API stops sharing the type with the others, which is what the library is for.' },
      ] } },
    { id: '2.3', title: 'Mock and try it', minutes: 3, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: 'A *mock* is a pretend server that answers from the spec: with each response\'s example, or a value made up from its type. Callers can build against it before the API exists.' },
        { p: 'Design Center\'s mocking service reads a few headers to pick the answer, and Design Studio\'s local mock reads the same:' },
        { list: ['`MS2-Status-Code: 404` asks for that response.', '`MS2-Example: second` picks a named example.', '`MS2-Error-Rate` and `MS2-Randomize` make it misbehave on purpose.'] },
        { p: 'In Design Studio, the Documentation panel has a Try it on every method, and it calls the local mock, with your unsaved edits included.' },
      ],
      check: { kind: 'choice', question: 'Your spec gives `GET /books/{bookId}` a 200 and a 404. How do you see the 404 on the mock?', options: [
        { text: 'Ask for a book id that doesn\'t exist', why: 'The mock doesn\'t store books, so it can\'t know which ids exist. It answers from the spec.' },
        { text: 'Send the header `MS2-Status-Code: 404`', correct: true, why: 'Right. The mock then answers with the 404 response from the spec.' },
        { text: 'You can\'t: the mock only gives 200', why: 'It can give any response the spec declares. A header picks which.' },
      ] } },
    { id: '2.4', title: 'Publishing and versions', minutes: 4, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: '*Publish* sends the spec to Exchange as a new version of its asset. Versions follow *semantic versioning*, `major.minor.patch`:' },
        { list: ['**major** (2.0.0): something callers rely on changed or went away. A removed method, a new required parameter, a changed type.', '**minor** (1.1.0): something new was added, and nothing old broke.', '**patch** (1.0.1): no change to the API itself. A fixed description or example.'] },
        { p: 'A version can be **Stable** (the default) or **Development**. A Stable version is final: it can\'t be published again. A Development version can be republished while you iterate.' },
        { p: 'Design Studio\'s Exchange panel compares your spec with the last published version and suggests the next number.' },
      ],
      check: { kind: 'choice', question: 'Version 1.4.2 is published. You add an optional `sort` query parameter to `GET /books`. What\'s the next version?', options: [
        { text: '2.0.0', why: 'An optional parameter breaks no existing call, so it isn\'t a major change.' },
        { text: '1.5.0', correct: true, why: 'Right. Something new, nothing broken: a minor version, with patch back to 0.' },
        { text: '1.4.3', why: 'Patch is for changes that don\'t touch the API. A new parameter does.' },
      ] } },
    { id: '2.5', title: 'Governance', minutes: 3, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: 'Teams agree on rules for their APIs: names in kebab-case, every response with an example, an error type on every 4xx. Written down for a machine, these are *rulesets*, published to Exchange like any asset.' },
        { p: 'A project that depends on a ruleset is checked against it: Design Center\'s Governance shows each rule the API breaks, as a violation, a warning or information. MuleSoft publishes rulesets too, like the Anypoint Best Practices.' },
        { list: ['Add a ruleset as a dependency, then read its findings in the Governance tab.', 'A rule that doesn\'t fit this API can be switched off for it, without editing the ruleset.'] },
      ],
      check: { kind: 'choice', question: 'Your team\'s ruleset says every resource name must be kebab-case. What happens to an API with `/bookLoans`?', options: [
        { text: 'AMF reports it as an invalid spec', why: 'The spec is valid RAML. Governance rules are a team\'s own agreement, checked on top.' },
        { text: 'Governance reports a finding for that rule', correct: true, why: 'Right. It shows in Governance as a violation or warning, with where it is, so it can be renamed to `/book-loans`.' },
        { text: 'It can\'t be published to Exchange', why: 'Publishing doesn\'t depend on governance findings. They\'re there to be fixed, not to block.' },
      ] } },
  ] },
  { title: 'Part 3 · OAS', note: 'The same ideas in the other language Design Center speaks.', lessons: [
    { id: '3.1', title: 'OAS for RAML designers', minutes: 6, files: { 'library.yaml': OAS31 }, solution: { 'library.yaml': OAS31_SOLVED },
      body: [
        { p: '*OAS* (OpenAPI) describes the same things as RAML with different words:' },
        { list: ['Resources are `paths`, written flat: `/books` and `/books/{bookId}` side by side, not nested.', 'Status codes are quoted keys: `\'200\':`, and every response needs a `description`.', 'Bodies say their media type: `content:` then `application/json:` then `schema:`.', 'Types are *schemas*, declared under `components: schemas:` and used with `$ref: \'#/components/schemas/Book\'`.', 'Required properties are listed in `required: [title, year]` instead of marked with `?`.'] },
        { code: "paths:\n  /books:\n    get:\n      responses:\n        '200':\n          description: The books\n          content:\n            application/json:\n              schema:\n                type: array\n                items:\n                  $ref: '#/components/schemas/Book'" },
      ],
      check: { kind: 'build', prompt: 'Add `GET /books`, answering 200 with a list of `Book`, and declare `Book` with a required `title` and `year`.', hints: ['Replace `paths: {}` with `paths:` and `/books:` under it.', 'The schema of a list: `type: array` and `items:` with the `$ref` under it.', '`components:` goes at the left edge, with `schemas:` and `Book:` under it.'],
        goals: [
          { say: 'GET /books answers 200 with Book[]', endpoint: '/books', method: 'get', response: '200', bodyType: 'Book[]' },
          { say: 'Book has a required title', type: 'Book', property: 'title', required: true },
          { say: 'Book has a required year, an integer', type: 'Book', property: 'year', propType: 'integer', required: true },
        ] } },
    { id: '3.2', title: 'RAML or OAS?', minutes: 2, files: { 'library.yaml': OAS31_SOLVED }, readOnly: true,
      body: [
        { p: 'Both work in Design Center, Exchange and Mule. Pick by who reads the spec:' },
        { list: ['**RAML** when the API lives in Anypoint: libraries, traits and resource types make big families of APIs short and consistent, and most MuleSoft projects use it.', '**OAS** when the API is shared outside: almost every tool and gateway reads OpenAPI.'] },
        { p: 'You don\'t have to choose forever: Design Studio\'s Duplicate As turns a RAML spec into OAS 3.0 or 2.0 with AMF.' },
        { callout: 'Done', text: 'That\'s the course. Create a project and design your own API, with AMF checking every line as you go.' },
      ],
      check: { kind: 'choice', question: 'Your API will be called by a partner who builds their client from the spec with a generic OpenAPI tool. Which language do you hand them?', options: [
        { text: 'RAML', why: 'RAML works in Anypoint, but a generic tool outside it expects OpenAPI.' },
        { text: 'OAS', correct: true, why: 'Right. And if the design is in RAML, Duplicate As converts it.' },
      ] } },
  ] },
];
export const LESSONS = PARTS.flatMap((p) => p.lessons);
