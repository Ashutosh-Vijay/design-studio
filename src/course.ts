// API Design Academy: the course, and its grader. Every lesson's solution is run through AMF by
// scripts/academy-verify.mjs before it ships (the solution must pass every goal, the starter must not, and
// each "wrong" must fail), so the course never teaches something the engine doesn't accept.
// The syllabus follows what the MuleSoft Developer I and II exams ask about API design, RAML, Design Center,
// Exchange, APIkit and API Manager, with the Library API as the one running example.

export type Block = { p: string } | { h: string } | { list: string[] } | { callout: string; text: string } | { code: string } | { steps: string[] } | { table: string[][] };
// One thing the learner's spec must have, read from AMF's model of it. `say` is shown when it's missing.
export type Goal = {
  say: string;
  title?: string; version?: string; spec?: string;
  endpoint?: string; method?: string; response?: string; bodyType?: string; media?: string; requestType?: string; example?: boolean; responseHeader?: string;
  param?: string; paramType?: string; paramIn?: string; paramRequired?: boolean; is?: string; uriParam?: string; resourceType?: string; securedBy?: string;
  type?: string; property?: string; propType?: string; required?: boolean; file?: string; typeOf?: string; enumHas?: string[]; typeExample?: boolean;
  trait?: string; resourceTypeDecl?: string; scheme?: string; schemeType?: string; doc?: string; annotationType?: string; fragment?: string; kind?: string;
};
export type Question = { question: string; options: { text: string; correct?: boolean; why: string }[] };
export type Check =
  | ({ kind: 'choice' } & Question)
  | { kind: 'quiz'; questions: Question[] }
  | { kind: 'build'; prompt: string; goals: Goal[]; hints: string[] };
export type Lesson = {
  id: string; title: string; minutes: number; body: Block[];
  // The editor's files (the first is the root file). Read-only lessons show an example; build lessons start here.
  files: Record<string, string>; readOnly?: boolean; http?: boolean;
  // With no files: a reference card on the right instead of the editor.
  aside?: { title: string; body: Block[] };
  solution?: Record<string, string>; wrong?: Record<string, string>[];
  check: Check;
};
export type Part = { title: string; note: string; lessons: Lesson[] };

// ---------- The grader ----------
type Body = { media: string; type: string; example?: string };
type Op = { method: string; parameters: { name: string; in: string; required: boolean; type: string }[]; body: Body[]; responses: { code: string; headers?: string[]; body: Body[] }[]; is: string[]; securedBy?: string[] };
export type Model = {
  title?: { v: string }; version?: { v: string }; securedBy?: string[];
  endpoints?: { path: string; resourceType?: string; is?: string[]; params?: { name: string; type: string; required: boolean }[]; securedBy?: string[]; operations: Op[] }[];
  types?: { name: string; type: string; enum?: string[]; example?: string; at?: { file: string }; properties?: { name: string; type: string; required: boolean }[] }[];
  traits?: string[]; resourceTypes?: string[]; schemes?: { name: string; type: string }[]; annotationTypes?: string[];
  docs?: { title: string; content: string }[]; files?: { file: string; kind: string }[];
};
export type Problem = { severity: string; message: string; file: string; line: number; col: number };
export function grade(goals: Goal[], model: Model, spec: string, problems: Problem[]) {
  const errors = problems.filter((p) => p.severity === 'error');
  const results = goals.map((g) => {
    if (g.title != null && model.title?.v !== g.title) return false;
    if (g.version != null && model.version?.v !== g.version) return false;
    if (g.spec != null && spec !== g.spec) return false;
    if (g.trait != null && !model.traits?.includes(g.trait)) return false;
    if (g.resourceTypeDecl != null && !model.resourceTypes?.includes(g.resourceTypeDecl)) return false;
    if (g.annotationType != null && !model.annotationTypes?.includes(g.annotationType)) return false;
    if (g.doc != null && !model.docs?.some((d) => d.title === g.doc && d.content.trim())) return false;
    if (g.fragment != null && !model.files?.some((f) => f.file === g.fragment && (g.kind == null || f.kind === g.kind))) return false;
    if (g.scheme != null) {
      const s = model.schemes?.find((x) => x.name === g.scheme); if (!s) return false;
      if (g.schemeType != null && s.type !== g.schemeType) return false;
    }
    if (g.securedBy != null && g.endpoint == null && !model.securedBy?.includes(g.securedBy)) return false;
    if (g.endpoint != null) {
      const e = model.endpoints?.find((x) => x.path === g.endpoint); if (!e) return false;
      if (g.resourceType != null && e.resourceType !== g.resourceType) return false;
      if (g.uriParam != null) {
        const p = e.params?.find((x) => x.name === g.uriParam); if (!p) return false;
        if (g.paramType != null && p.type !== g.paramType) return false;
      }
      if (g.method == null && g.is != null && !e.is?.includes(g.is)) return false;
      if (g.method != null) {
        const o = e.operations.find((x) => x.method === g.method); if (!o) return false;
        if (g.is != null && !o.is.includes(g.is)) return false;
        if (g.securedBy != null && !o.securedBy?.includes(g.securedBy)) return false;
        if (g.requestType != null && !o.body.some((b) => b.type === g.requestType)) return false;
        if (g.param != null) {
          const p = o.parameters.find((x) => x.name === g.param); if (!p) return false;
          if (g.paramType != null && p.type !== g.paramType) return false;
          if (g.paramIn != null && p.in !== g.paramIn) return false;
          if (g.paramRequired != null && p.required !== g.paramRequired) return false;
        }
        if (g.response != null) {
          const r = o.responses.find((x) => x.code === g.response); if (!r) return false;
          const bodies = g.media != null ? r.body.filter((b) => b.media === g.media) : r.body;
          if (g.media != null && !bodies.length) return false;
          if (g.bodyType != null && !bodies.some((b) => b.type === g.bodyType)) return false;
          if (g.example && !bodies.some((b) => b.example)) return false;
          if (g.responseHeader != null && !r.headers?.includes(g.responseHeader)) return false;
        }
      }
    }
    if (g.type != null) {
      const t = model.types?.find((x) => x.name === g.type); if (!t) return false;
      if (g.file != null && t.at?.file !== g.file) return false;
      if (g.typeOf != null && t.type !== g.typeOf) return false;
      if (g.enumHas != null && !g.enumHas.every((v) => t.enum?.includes(v))) return false;
      if (g.typeExample && !t.example) return false;
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

// ---------- Part 1's running spec, a step at a time ----------
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

// ---------- Part 2's starting point: the Library API as Part 1 left it ----------
const HEAD2 = `#%RAML 1.0
title: Library API
version: v1
baseUri: https://api.example.com/library/{version}
mediaType: application/json
`;
const BOOK = `  Book:
    type: object
    properties:
      title: string
      year: integer
      isbn?: string
`;
const RES2 = `
/books:
  get:
    queryParameters:
      limit?:
        type: integer
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
        404:
          description: There's no book with that id
`;
const BASE2 = HEAD2 + '\ntypes:\n' + BOOK + RES2;

// 2.1: URI and query parameters
const S21 = BASE2.replace(`    queryParameters:
      limit?:
        type: integer
`, `    queryParameters:
      limit?:
        type: integer
      author?:
        type: string
`).replace(`  /{bookId}:
    get:`, `  /{bookId}:
    uriParameters:
      bookId:
        type: integer
        minimum: 1
    get:`);
// 2.2: headers
const S22 = S21.replace(`  post:
    body:
      type: Book
    responses:
      201:
        description: The book was added
`, `  post:
    headers:
      X-Correlation-ID?:
        type: string
    body:
      type: Book
    responses:
      201:
        description: The book was added
        headers:
          Location:
            type: string
            example: https://api.example.com/library/v1/books/43
`);
// 2.3: a spec to read
const READ23 = `#%RAML 1.0
title: Library API
version: v2
baseUri: https://api.example.com/library/{version}
mediaType: application/json

/members:
  /{memberId}:
    uriParameters:
      memberId:
        type: integer
    /loans:
      get:
        headers:
          client_id:
            type: string
        queryParameters:
          status:
            enum: [open, returned]
          limit?:
            type: integer
            maximum: 50
        responses:
          200:
            description: The member's loans
          400:
            description: A parameter is missing or wrong
`;
// 2.4: types and facets
const S24 = HEAD2 + `
types:
  Genre:
    type: string
    enum: [fiction, science, history]
  Book:
    type: object
    properties:
      title:
        type: string
        minLength: 1
      year: integer
      isbn?:
        type: string
        pattern: ^[0-9]{13}$
      genre?: Genre
` + RES2;
// 2.5: inheritance and unions
const S25 = HEAD2 + '\ntypes:\n' + BOOK + `  Ebook:
    type: Book
    properties:
      sizeMb: number
  Item: Book | Ebook
` + RES2;
// 2.6: examples
const BOOK_EXAMPLES = `    examples:
      dune:
        title: Dune
        year: 1965
      emma:
        title: Emma
        year: 1815
        isbn: "9780141439587"
`;
const S26 = (HEAD2 + '\ntypes:\n' + BOOK + BOOK_EXAMPLES + RES2).replace(`      responses:
        200:
          body:
            type: Book
        404:`, `      responses:
        200:
          body:
            application/json:
              type: Book
            application/xml:
              type: Book
        404:`);
// 2.7: resource types
const START27 = HEAD2 + '\ntypes:\n' + BOOK + `
/books:
  /{bookId}:
`;
const S27 = HEAD2 + '\ntypes:\n' + BOOK + `
resourceTypes:
  collection:
    description: All the <<resourcePathName>>
    get?:
      responses:
        200:
          body:
            type: <<item>>[]
    post?:
      body:
        type: <<item>>
      responses:
        201:
          description: Added
  member:
    get?:
      responses:
        200:
          body:
            type: <<item>>
        404:
          description: Not found

/books:
  type: { collection: { item: Book } }
  get:
  post:
  /{bookId}:
    type: { member: { item: Book } }
    get:
`;
// 2.8: traits in depth
const S28 = BASE2.replace(`
types:`, `
traits:
  pageable:
    queryParameters:
      offset?:
        type: integer
        minimum: 0
      limit?:
        type: integer
        minimum: 1
        maximum: <<maxLimit>>
  searchable:
    queryParameters:
      q?:
        type: string
        description: Searches the <<resourcePathName>>

types:`).replace(`  get:
    queryParameters:
      limit?:
        type: integer
    responses:`, `  get:
    is: [pageable: { maxLimit: 50 }, searchable]
    responses:`);
// 2.9: security schemes
const S29 = BASE2.replace(`
types:`, `
securitySchemes:
  oauth_2_0:
    type: OAuth 2.0
    description: Library staff sign in with the library's identity provider.
    describedBy:
      headers:
        Authorization:
          type: string
          description: Bearer and the access token
      responses:
        401:
          description: The token is missing, expired or wrong
    settings:
      authorizationUri: https://auth.example.com/authorize
      accessTokenUri: https://auth.example.com/token
      authorizationGrants: [authorization_code, client_credentials]

securedBy: [oauth_2_0]

types:`);
// 2.10: client ID enforcement
const S210 = BASE2.replace(`
types:`, `
traits:
  client-id-required:
    headers:
      client_id:
        type: string
      client_secret:
        type: string
    responses:
      401:
        description: The client id or secret is missing or wrong
      429:
        description: Too many requests for this client's tier

types:`).replace(`/books:
  get:`, `/books:
  is: [client-id-required]
  get:`).replace(`  /{bookId}:
    get:`, `  /{bookId}:
    is: [client-id-required]
    get:`);
// 2.11: documentation and annotations
const S211 = BASE2.replace(`mediaType: application/json
`, `mediaType: application/json
description: The catalogue of the city library, for the library's own apps and its partners.

documentation:
  - title: Getting started
    content: |
      Ask the library team for a client id, then send it in the client_id header.
      Every list is paged: use offset and limit.

annotationTypes:
  deprecated:
    type: string
    description: Why it's going away, and what to use instead
`).replace(`/books:
  get:`, `/books:
  displayName: Books
  get:
    (deprecated): Use GET /catalogue/items, which also lists ebooks.`);
// 2.12: fragments
const START212 = HEAD2 + `
types:
` + BOOK + `
traits:
  pageable:
    queryParameters:
      page?:
        type: integer
        minimum: 1
` + RES2.replace(`  get:
    queryParameters:
      limit?:
        type: integer
    responses:`, `  get:
    is: [pageable]
    responses:`);
const FRAG_BOOK = `#%RAML 1.0 DataType
type: object
properties:
  title: string
  year: integer
  isbn?: string
`;
const FRAG_PAGEABLE = `#%RAML 1.0 Trait
queryParameters:
  page?:
    type: integer
    minimum: 1
`;
const S212 = START212.replace(BOOK, '  Book: !include types/book.raml\n').replace(`  pageable:
    queryParameters:
      page?:
        type: integer
        minimum: 1
`, '  pageable: !include traits/pageable.raml\n');
// 2.13: libraries
const LIB213 = `#%RAML 1.0 Library
usage: The Library API's data types

types:
` + BOOK;
const ROOT213 = HEAD2 + '\ntypes:\n' + BOOK + `
/books:
  /{bookId}:
    get:
      responses:
        200:
          body:
            type: Book
`;
// 2.14: overlays and extensions
const OVERLAY = `#%RAML 1.0 Overlay
extends: library.raml
usage: The Spanish documentation of the Library API

/books:
  get:
    description: Lista los libros del catálogo.
`;
const EXTENSION = `#%RAML 1.0 Extension
extends: library.raml
usage: Adds what only the library's staff can do

/books:
  /{bookId}:
    delete:
      responses:
        204:
          description: The book was removed
`;
// 2.15: everything at once
const GLANCE = `#%RAML 1.0
title: Library API
description: The catalogue of the city library.
version: v1
baseUri: https://api.example.com/library/{version}
protocols: [HTTPS]
mediaType: application/json
documentation:
  - title: Getting started
    content: Ask the library team for a client id.

uses:
  common: libraries/common.raml

securitySchemes:
  oauth_2_0:
    type: OAuth 2.0
    settings:
      authorizationUri: https://auth.example.com/authorize
      accessTokenUri: https://auth.example.com/token
      authorizationGrants: [client_credentials]
securedBy: [oauth_2_0]

annotationTypes:
  deprecated: string

types:
  Genre:
    type: string
    enum: [fiction, science, history]
  Book:
    type: object
    properties:
      title:
        type: string
        minLength: 1
      year: integer
      isbn?:
        type: string
        pattern: ^[0-9]{13}$
      genre?: Genre
    example:
      title: Dune
      year: 1965
  Ebook:
    type: Book
    properties:
      sizeMb: number

resourceTypes:
  collection:
    get?:
      responses:
        200:
          body:
            type: <<item>>[]
    post?:
      body:
        type: <<item>>
      responses:
        201:
          headers:
            Location: string

traits:
  pageable:
    queryParameters:
      offset?:
        type: integer
        default: 0
      limit?:
        type: integer
        maximum: <<maxLimit>>

/books:
  type: { collection: { item: Book } }
  get:
    is: [pageable: { maxLimit: 50 }]
    queryParameters:
      genre?: Genre
  post:
  /{bookId}:
    uriParameters:
      bookId:
        type: integer
    get:
      responses:
        200:
          body:
            type: Book
        404:
          body:
            type: common.Error
    delete:
      (deprecated): Books are archived now, not deleted.
      securedBy: [oauth_2_0: { scopes: [admin] }]
      responses:
        204:
          description: Removed
`;
const GLANCE_LIB = `#%RAML 1.0 Library
usage: Types every Library API shares

types:
  Error:
    type: object
    properties:
      code: string
      message: string
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
    { id: '1.1', title: 'What an API is', minutes: 5, http: true, files: {},
      body: [
        { p: 'Apps don\'t share a brain. When one needs something from another, it sends a *request* over HTTP and gets a *response* back. An *API* (application programming interface) is the list of requests a system accepts, and what it answers to each.' },
        { p: 'A request has two main parts:' },
        { list: ['The **resource**: what it is about, written as a path, like `/books` (all the books) or `/books/42` (one of them).', 'The **method**: what to do with it. `GET` reads, `POST` creates, `PUT` replaces, `PATCH` changes part of it, `DELETE` removes it.'] },
        { p: 'The response starts with a *status code*: `200` OK, `201` Created, `400` the request was wrong, `404` there\'s nothing there. Most responses also carry a *body*, usually JSON.' },
        { h: 'The words MuleSoft uses' },
        { p: 'MuleSoft\'s training and exams are precise about five terms. They come up again and again:' },
        { table: [['Term', 'What it means', 'In the library'],
          ['API', 'The whole thing: the contract and the running service behind it', 'The Library API'],
          ['API interface', 'The contract alone: resources, methods, parameters, types. In Anypoint, the RAML or OAS spec', '`library.raml`'],
          ['API implementation', 'The code that actually answers the requests, usually a Mule application', 'The Mule app that reads the catalogue database'],
          ['API consumer', 'The app (or team) that calls the API', 'The library\'s mobile app'],
          ['API invocation', 'One call: a single request and its response', '`GET /books/42` and its `200`']] },
        { callout: 'Try it', text: 'Send the requests on the right to a pretend library and watch what comes back.' },
      ],
      check: { kind: 'quiz', questions: [
        { question: 'A librarian\'s app wants to add a new book to the catalogue. Which request fits?', options: [
          { text: '`GET /books`', why: 'GET only reads. It would list the books, not add one.' },
          { text: '`POST /books`', correct: true, why: 'Right. POST to a collection creates a new item in it, and the answer is usually 201 Created.' },
          { text: '`DELETE /books/42`', why: 'DELETE removes a book. It\'s the opposite.' },
        ] },
        { question: 'The Mule application that reads the catalogue database and answers `GET /books` is the API\'s...', options: [
          { text: 'API interface', why: 'The interface is the contract (the spec), not the code that runs it.' },
          { text: 'API implementation', correct: true, why: 'Right. The implementation is what does the work behind the interface.' },
          { text: 'API consumer', why: 'The consumer is whoever calls the API, like the library\'s mobile app.' },
        ] },
      ] } },
    { id: '1.2', title: 'HTTP in more depth', minutes: 7, files: {},
      aside: { title: 'Status codes worth knowing by heart', body: [
        { table: [['Code', 'Means', 'Typical cause'],
          ['200 OK', 'It worked, here is the answer', 'A GET, or a PUT that returns the result'],
          ['201 Created', 'Something new was made', 'A POST; the `Location` header says where'],
          ['202 Accepted', 'Taken, it will be done later', 'Long jobs, queues'],
          ['204 No Content', 'It worked, nothing to send back', 'A DELETE'],
          ['304 Not Modified', 'Your cached copy is still good', 'A GET with `If-None-Match`'],
          ['400 Bad Request', 'The request is wrong', 'A missing required parameter, a body that doesn\'t fit its type'],
          ['401 Unauthorized', 'Who are you?', 'No credentials, or wrong ones'],
          ['403 Forbidden', 'I know who you are, and no', 'Not allowed, or an IP not on the allowlist'],
          ['404 Not Found', 'There\'s nothing there', 'An unknown id or path'],
          ['405 Method Not Allowed', 'This resource doesn\'t do that', 'A DELETE where only GET is declared'],
          ['406 Not Acceptable', 'I can\'t answer in that format', 'An `Accept` the API doesn\'t offer'],
          ['409 Conflict', 'It clashes with the current state', 'A duplicate, an edit on a stale copy'],
          ['415 Unsupported Media Type', 'I can\'t read that format', 'A `Content-Type` the API doesn\'t take'],
          ['429 Too Many Requests', 'Slow down', 'A rate limit or spike control policy'],
          ['500 Internal Server Error', 'It broke on our side', 'An unhandled error'],
          ['501 Not Implemented', 'Declared, but not built yet', 'APIkit, for a method with no flow'],
          ['503 Service Unavailable', 'Try again later', 'A backend that\'s down']] },
      ] },
      body: [
        { p: 'Every request is the same four parts, and every response three. Knowing which part carries what is most of reading an API.' },
        { code: 'POST /library/v1/books?notify=true HTTP/1.1      <- method, path, query\nHost: api.example.com\nContent-Type: application/json                   <- headers\nAccept: application/json\nclient_id: 3f9a...\n\n{ "title": "Beloved", "year": 1987 }             <- body' },
        { list: ['The **path** names the resource. Parts of it can vary: in `/books/42`, `42` fills the URI parameter `{bookId}`.', 'The **query** (after `?`) refines the request: filter, sort, page. `?genre=fiction&limit=10`.', '**Headers** carry details about the call rather than the resource: the format (`Content-Type`, `Accept`), credentials (`Authorization`, `client_id`), caching (`ETag`, `Cache-Control`), tracing (`X-Correlation-ID`).', 'The **body** carries the data itself, for POST, PUT and PATCH, and in most responses.'] },
        { h: 'Safe and idempotent' },
        { p: 'Two properties of methods come up in design questions. *Safe* means it changes nothing. *Idempotent* means sending it twice has the same effect as sending it once, so a client can retry it after a timeout without fear.' },
        { table: [['Method', 'Safe', 'Idempotent', 'Use it to'],
          ['GET', 'yes', 'yes', 'read'],
          ['POST', 'no', 'no', 'create (a second call makes a second book)'],
          ['PUT', 'no', 'yes', 'replace the whole resource'],
          ['PATCH', 'no', 'not by rule', 'change some fields'],
          ['DELETE', 'no', 'yes', 'remove (the second call finds nothing, the state is the same)']] },
        { h: 'Formats' },
        { p: '`Content-Type` says what format the body *is*. `Accept` says what format the caller *wants back*. An API that can\'t read the body answers `415`; one that can\'t write the format asked for answers `406`.' },
      ],
      check: { kind: 'quiz', questions: [
        { question: 'A mobile app times out while sending a request and isn\'t sure it arrived. Which one can it safely send again?', options: [
          { text: '`POST /books` with the new book', why: 'POST isn\'t idempotent: if the first one arrived, a retry adds the book twice.' },
          { text: '`PUT /books/42` with the full book', correct: true, why: 'Right. PUT is idempotent: replacing book 42 twice with the same content leaves the same result.' },
        ] },
        { question: 'A client sends a body with `Content-Type: text/csv` to an API that only reads JSON. What should it get back?', options: [
          { text: '400 Bad Request', why: 'Close, but there\'s a more specific code for a format the API can\'t read.' },
          { text: '406 Not Acceptable', why: '406 is about the `Accept` header: the format the caller wants back.' },
          { text: '415 Unsupported Media Type', correct: true, why: 'Right. 415 says the body\'s format, from `Content-Type`, isn\'t one the API takes.' },
        ] },
        { question: 'Where should a client put its credentials?', options: [
          { text: 'In the query, like `?password=...`', why: 'URLs end up in logs, browser history and caches. Credentials go in headers.' },
          { text: 'In a header, like `Authorization` or `client_id`', correct: true, why: 'Right. Headers carry details about the call, and they aren\'t logged with the URL.' },
        ] },
      ] } },
    { id: '1.3', title: 'API-led connectivity', minutes: 7, files: {},
      aside: { title: 'The three layers', body: [
        { table: [['Layer', 'Unlocks', 'Changes', 'In the library'],
          ['Experience APIs', 'Data shaped for one kind of consumer: a mobile app, a partner, a web page', 'Often, with the app', '`mobile-library-api`: a phone-sized view of loans and holds'],
          ['Process APIs', 'Business logic that combines data from several systems', 'When the business does', '`loans-api`: borrow a book (check the member, the copy, the fines)'],
          ['System APIs', 'One system of record, hiding its quirks', 'Rarely', '`catalogue-sapi` over the catalogue database, `members-sapi` over the CRM']] },
        { steps: ['Mobile app', 'Experience API', 'Process API', 'System APIs', 'Databases, SaaS'] },
        { p: 'Calls flow down. Each layer only calls the one below it (or another API of its own layer, sparingly). A System API never calls a Process API.' },
      ] },
      body: [
        { p: 'MuleSoft\'s answer to the *IT delivery gap* (the business asks for more projects every year, IT\'s capacity barely grows) is to stop building point-to-point integrations, and to build *reusable APIs* instead, so each project leaves behind building blocks for the next.' },
        { h: 'Three layers' },
        { p: '*API-led connectivity* sorts those APIs into three layers, each with its own job and its own pace of change. The table on the right shows them. The point: when the mobile app changes, only its Experience API changes; when the CRM is replaced, only one System API changes.' },
        { h: 'The application network' },
        { p: 'As APIs accumulate, they connect into an *application network*: data and capabilities reachable through discoverable, managed APIs, rather than through custom code for every pair of systems. Each new project mostly *reuses* and adds a little.' },
        { h: 'The modern API' },
        { p: 'A *modern API* is treated as a product: designed first and agreed as a contract, easy to discover and try (in Exchange, with docs and a mock), managed and secured with policies, and measured once it runs.' },
        { h: 'The Center for Enablement (C4E)' },
        { p: 'A *C4E* is a small cross-team group that makes reuse happen: it publishes standards, templates and shared fragments, runs governance, and helps teams find and consume what already exists. It enables rather than builds everything itself, which is the difference from a classic central IT team.' },
        { h: 'Anypoint Platform, end to end' },
        { table: [['Step', 'Where'],
          ['Design the spec, mock it', 'Design Center'],
          ['Share, discover, depend on it', 'Exchange'],
          ['Build the implementation', 'Anypoint Studio (or Anypoint Code Builder)'],
          ['Deploy and run it', 'Runtime Manager (CloudHub, or your own servers)'],
          ['Secure and govern it with policies', 'API Manager, API Governance'],
          ['Watch it', 'Anypoint Monitoring']] },
      ],
      check: { kind: 'quiz', questions: [
        { question: 'Which layer should hide the quirks of the library\'s old catalogue database?', options: [
          { text: 'An Experience API', why: 'Experience APIs shape data for a consumer. They shouldn\'t know which database sits underneath.' },
          { text: 'A Process API', why: 'Process APIs combine systems through System APIs. They shouldn\'t talk to a database directly.' },
          { text: 'A System API', correct: true, why: 'Right. A System API unlocks one system of record, so a database change touches only it.' },
        ] },
        { question: 'What is the main job of a Center for Enablement (C4E)?', options: [
          { text: 'To build every integration for the business', why: 'That\'s the classic central IT model that creates the delivery gap.' },
          { text: 'To make reusable assets, standards and help available, so teams build and reuse on their own', correct: true, why: 'Right. A C4E enables the rest of the organization rather than doing all the work itself.' },
          { text: 'To approve every API before it can be deployed', why: 'A C4E sets standards and governance, but its aim is self service, not a gate on every change.' },
        ] },
      ] } },
    { id: '1.4', title: 'Design first', minutes: 4, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: 'In MuleSoft, an API usually starts as a *spec*: a file that says which resources and methods exist, what each one takes and what it answers. You write it in Design Center (or here), before anyone writes the Mule app behind it.' },
        { steps: ['Design', 'Simulate (mock)', 'Get feedback', 'Publish to Exchange', 'Build in Mule', 'Deploy and manage'] },
        { p: 'Why first? Because the spec is a *contract*. The people who will call the API can read it, try it on a mock that answers with the spec\'s own examples, and give feedback while changes are still cheap. Mule developers then generate their flows from the same file with APIkit, so the implementation can\'t drift from what was agreed.' },
        { p: 'That is the *lifecycle of the modern API*: design, simulate, validate with consumers, then build, deploy, manage and secure, and let others discover and reuse it.' },
        { p: 'Specs are written in one of two languages: **RAML**, MuleSoft\'s own, and **OAS** (OpenAPI), the industry\'s. This course is mostly RAML, which most Design Center projects and the exams use, and shows OAS at the end.' },
        { callout: 'On the right', text: 'A small RAML spec. You don\'t need to understand it yet: by lesson 1.9 you will have written one like it.' },
      ],
      check: { kind: 'choice', question: 'Why write the spec before building the Mule app?', options: [
        { text: 'Because Mule can\'t run without RAML', why: 'Mule apps can run without a spec. The spec is for agreeing on the API, not a technical requirement.' },
        { text: 'So callers and builders agree on the API, and callers can start on a mock right away', correct: true, why: 'Exactly. The spec is the contract both sides work from, and the mock lets callers try it before it exists.' },
        { text: 'Because specs make the API faster', why: 'A spec describes the API. It has no effect on how fast it runs.' },
      ] } },
    { id: '1.5', title: 'Meet RAML', minutes: 6, files: { 'library.raml': '#%RAML 1.0\n' }, solution: { 'library.raml': S13 },
      body: [
        { p: 'A RAML file starts with the line `#%RAML 1.0`. Then come the API\'s details, each as a *key*, a colon, and a value:' },
        { code: '#%RAML 1.0\ntitle: Library API\nversion: v1\nbaseUri: https://api.example.com/library/{version}\nmediaType: application/json' },
        { list: ['`title` is the only one RAML requires.', '`version` is the API\'s version, usually its major one: `v1`.', '`baseUri` is where the API will live. `{version}` in it is filled in from `version`.', '`mediaType` sets the format of every body, so you don\'t repeat it everywhere. It can be a list: `[application/json, application/xml]`.'] },
        { h: 'YAML in five rules' },
        { p: 'RAML is written in *YAML*, so these rules apply everywhere:' },
        { list: ['*Indentation is structure*: two spaces for each level, never tabs. A key at the left edge belongs to the API itself.', 'A list is either `[a, b]` on one line or one `- item` per line.', '`#` starts a comment (the first line is the exception: it names the language).', 'Text needs quotes only when it could be read as something else: `"0042"`, `"yes"`, or text with `: ` inside.', 'A `|` keeps several lines of text as they are, for long descriptions.'] },
        { h: 'Everything that can go at the top' },
        { table: [['Key', 'What it holds'],
          ['`title`, `description`, `version`', 'The API\'s name, a summary, its version'],
          ['`baseUri`, `baseUriParameters`, `protocols`', 'Where it lives, and over `HTTP` or `HTTPS`'],
          ['`mediaType`', 'The default format of bodies'],
          ['`documentation`', 'Pages of user documentation'],
          ['`types`', 'Data types (lesson 1.8 and Part 2)'],
          ['`traits`, `resourceTypes`', 'Reusable pieces of methods and resources'],
          ['`securitySchemes`, `securedBy`', 'How callers prove who they are'],
          ['`annotationTypes`', 'Your own extra keys'],
          ['`uses`', 'Libraries'],
          ['`/anything`', 'Resources']] },
        { callout: 'Watch the right side', text: 'AMF, the engine Design Center uses, reads your file as you type. Mistakes show with a red underline, and what it understood shows under the editor.' },
      ],
      check: { kind: 'build', prompt: 'Give the API the title `Library API` and the version `v1`.', hints: ['Each detail goes on its own line at the left edge, like `title: Library API`.', 'The version line is `version: v1`.'],
        goals: [{ say: 'The title is Library API', title: 'Library API' }, { say: 'The version is v1', version: 'v1' }] } },
    { id: '1.6', title: 'Resources', minutes: 5, files: { 'library.raml': S13 }, solution: { 'library.raml': S14 },
      body: [
        { p: 'Resources are the nouns of an API. In RAML each one is a key that starts with `/`, at the left edge:' },
        { code: '/books:\n  /{bookId}:' },
        { p: '`/books` is the *collection*. `/{bookId}` is nested inside it (two spaces in), so its full path is `/books/{bookId}`: one book. The part in braces is a *URI parameter*, filled in by the caller: `/books/42`.' },
        { list: ['Name collections with plural nouns: `/books`, `/loans`, `/members`. The method is the verb, so avoid verbs in paths (`/getBooks`).', 'Nest an item under its collection instead of writing `/books/{bookId}` as a separate top-level key. Design Center\'s API tree shows the nesting.', 'Nest to show belonging: `/members/{memberId}/loans` is the loans of one member.', 'A resource can have a `displayName` and a `description`, which the API console shows.'] },
        { p: 'With the `baseUri` from the last lesson, the full address of one book is `https://api.example.com/library/v1/books/42`.' },
      ],
      check: { kind: 'build', prompt: 'Add the `/books` collection, with `/{bookId}` nested inside it.', hints: ['Start a new line at the left edge with `/books:`.', 'On the next line, two spaces in: `/{bookId}:`.'],
        goals: [{ say: 'There is a /books resource', endpoint: '/books' }, { say: 'There is a /books/{bookId} resource', endpoint: '/books/{bookId}' }] } },
    { id: '1.7', title: 'Methods and responses', minutes: 5, files: { 'library.raml': S14 }, solution: { 'library.raml': S15 },
      body: [
        { p: 'Under a resource, list the methods it supports. Under each method, `responses` lists the status codes it can answer with:' },
        { code: '/books:\n  get:\n    responses:\n      200:\n        description: The books in the catalogue' },
        { p: 'The usual pattern, which Design Center\'s shelf suggests too:' },
        { table: [['Request', 'Does', 'Answers'],
          ['`get` on a collection', 'lists it', '`200`'],
          ['`post` on a collection', 'creates an item', '`201`, often with a `Location` header'],
          ['`get` on an item', 'reads it', '`200`, or `404` when there\'s no such item'],
          ['`put` on an item', 'replaces it', '`200` or `204`'],
          ['`delete` on an item', 'removes it', '`204`']] },
        { p: 'Each level is two more spaces in. If AMF underlines something, the indentation is the first thing to check. A method can have its own `description` too, shown in the API console.' },
      ],
      check: { kind: 'build', prompt: 'Give `/books` a `get` (200) and a `post` (201), and give `/books/{bookId}` a `get` that answers 200 or 404.', hints: ['Methods go two spaces inside their resource: `get:` under `/books:`.', 'Under the method: `responses:`, then the code (`200:`), then `description: ...`.', 'The `get` of `/{bookId}` sits two spaces inside `/{bookId}:`, which is itself inside `/books:`.'],
        goals: [
          { say: 'GET /books answers 200', endpoint: '/books', method: 'get', response: '200' },
          { say: 'POST /books answers 201', endpoint: '/books', method: 'post', response: '201' },
          { say: 'GET /books/{bookId} answers 200', endpoint: '/books/{bookId}', method: 'get', response: '200' },
          { say: 'GET /books/{bookId} answers 404', endpoint: '/books/{bookId}', method: 'get', response: '404' },
        ] } },
    { id: '1.8', title: 'Data types', minutes: 5, files: { 'library.raml': S15 }, solution: { 'library.raml': S16 },
      body: [
        { p: 'A *type* describes the shape of the data: what a book looks like. Types are declared once, under `types` at the top level, and used anywhere by name.' },
        { code: TYPES16.trimEnd() },
        { list: ['`type: object` means it has properties.', 'Each property has a type: `string`, `integer`, `number`, `boolean`, `date-only`, `datetime` and more (lesson 2.4 has them all).', 'A name ending in `?` is optional (`isbn?`). Every other property is required.', 'A list of books is written `Book[]`.'] },
        { p: 'Type names start with a capital letter by convention, which is how Design Center\'s Types and Traits shelf lists them. RAML types are *format independent*: the same `Book` describes a JSON body and an XML one.' },
      ],
      check: { kind: 'build', prompt: 'Declare a `Book` type with a required `title` (string), a required `year` (integer) and an optional `isbn` (string).', hints: ['`types:` goes at the left edge, above `/books:`.', 'Then `Book:` two spaces in, and `type: object` and `properties:` under it.', 'An optional property: `isbn?: string`.'],
        goals: [
          { say: 'There is a Book type', type: 'Book' },
          { say: 'Book has a required title, a string', type: 'Book', property: 'title', propType: 'string', required: true },
          { say: 'Book has a required year, an integer', type: 'Book', property: 'year', propType: 'integer', required: true },
          { say: 'Book has an optional isbn, a string', type: 'Book', property: 'isbn', propType: 'string', required: false },
        ] } },
    { id: '1.9', title: 'Bodies and examples', minutes: 6, files: { 'library.raml': S16 }, solution: { 'library.raml': S17 },
      wrong: [{ 'library.raml': S17.replace('year: 1965', 'year: nineteen sixty-five') }],
      body: [
        { p: 'A *body* says what a request sends or a response returns. Since `mediaType` is set at the top, a body only needs its `type`:' },
        { code: '/{bookId}:\n  get:\n    responses:\n      200:\n        body:\n          type: Book\n          example:\n            title: Dune\n            year: 1965' },
        { p: 'An *example* shows a real value. The mock answers with it, the API console shows it, and APIkit puts it in the flows it generates. AMF checks every example against its type: an example that doesn\'t fit is an error, the same as in Design Center.' },
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
    { id: '1.10', title: 'Query parameters', minutes: 5, files: { 'library.raml': S17 }, solution: { 'library.raml': S18 },
      body: [
        { p: 'Callers can pass extra details in the URL after a `?`, like `/books?limit=10`. These are *query parameters*, declared under the method:' },
        { code: 'get:\n  queryParameters:\n    limit?:\n      type: integer\n      minimum: 1\n      maximum: 100' },
        { p: 'Like properties, query parameters are required unless the name ends in `?` (or has `required: false`). A required `limit` would make every call without it a bad request, so it\'s optional here.' },
        { p: 'Facets like `minimum` and `maximum` say which values are allowed. The mock and Mule\'s APIkit both enforce them: a call with `limit=500` gets a `400 Bad Request` before any of your flow runs.' },
      ],
      check: { kind: 'build', prompt: 'Let `GET /books` take an optional `limit` query parameter, an integer.', hints: ['`queryParameters:` goes under `get:`, beside `responses:`.', 'Then `limit?:` and, under it, `type: integer`.'],
        goals: [{ say: 'GET /books has an optional integer limit in the query', endpoint: '/books', method: 'get', param: 'limit', paramType: 'integer', paramIn: 'query', paramRequired: false }] } },
    { id: '1.11', title: 'Reuse: traits', minutes: 5, files: { 'library.raml': S18 }, solution: { 'library.raml': S19 },
      body: [
        { p: 'Many methods share behaviour: paging, a correlation header, error responses. Instead of writing it on each one, declare it once as a *trait* and apply it with `is`:' },
        { code: 'traits:\n  pageable:\n    queryParameters:\n      page?:\n        type: integer\n\n/books:\n  get:\n    is: [pageable]' },
        { p: 'A trait\'s content is merged into every method that uses it. *Resource types* do the same for whole resources: a `collection` type can give every collection its `get` and `post`. Part 2 goes deep on both.' },
        { p: 'Design Center\'s Rename and Delete keep these references in step across files. Design Studio does too: F2 on a trait\'s name renames it everywhere.' },
      ],
      check: { kind: 'build', prompt: 'Declare a `pageable` trait with an optional integer `page` query parameter, and apply it to `GET /books`.', hints: ['`traits:` goes at the left edge, like `types:`.', 'Apply it with `is: [pageable]` directly under `get:`.'],
        goals: [{ say: 'GET /books is pageable', endpoint: '/books', method: 'get', is: 'pageable' }] } },
  ] },
  { title: 'Part 2 · RAML in depth', note: 'Everything RAML 1.0 has, the way the certification exams ask about it.', lessons: [
    { id: '2.1', title: 'URI or query parameter?', minutes: 6, files: { 'library.raml': BASE2 }, solution: { 'library.raml': S21 },
      body: [
        { p: 'Both put a value in the URL, and the exams love asking which to use. The rule:' },
        { table: [['', 'URI parameter', 'Query parameter'],
          ['Looks like', '`/books/42`', '`/books?author=Herbert`'],
          ['Use it to', '*identify* a resource: which book', '*refine* the request: filter, sort, page, search'],
          ['Required?', 'Always: without it, it\'s a different path', 'Optional or required, your choice'],
          ['Declared', 'On the resource, under `uriParameters`', 'On the method, under `queryParameters`']] },
        { p: 'A URI parameter needs no declaration to work: `{bookId}` in the path is enough, and it\'s a string. Declare it to give it a type and facets, so APIkit rejects `/books/abc` with a 400 before your flow runs:' },
        { code: '/{bookId}:\n  uriParameters:\n    bookId:\n      type: integer\n      minimum: 1\n  get:' },
        { p: 'RAML 1.0 also has `queryString`: a whole type for the query instead of separate parameters, handy for unions ("either `isbn` or `title`"). It\'s rare; `queryParameters` is what you\'ll see.' },
      ],
      check: { kind: 'build', prompt: 'Declare `bookId` as an integer URI parameter of `/{bookId}`, and let `GET /books` filter by an optional `author` (a string).', hints: ['`uriParameters:` goes directly under `/{bookId}:`, beside `get:`, not under the method.', 'Under it: `bookId:` and then `type: integer`.', '`author?:` goes under `queryParameters:` of `GET /books`, next to `limit?:`.'],
        goals: [
          { say: '/books/{bookId} declares bookId as an integer', endpoint: '/books/{bookId}', uriParam: 'bookId', paramType: 'integer' },
          { say: 'GET /books has an optional author in the query', endpoint: '/books', method: 'get', param: 'author', paramType: 'string', paramIn: 'query', paramRequired: false },
        ] } },
    { id: '2.2', title: 'Headers', minutes: 5, files: { 'library.raml': S21 }, solution: { 'library.raml': S22 },
      body: [
        { p: 'Headers carry details *about* a call. Request headers go under the method, like query parameters, and follow the same rules (required unless the name ends in `?`):' },
        { code: 'post:\n  headers:\n    X-Correlation-ID?:\n      type: string' },
        { p: 'Response headers go under the status code. The classic one: a `201 Created` says where the new item lives in a `Location` header.' },
        { code: 'responses:\n  201:\n    headers:\n      Location:\n        type: string' },
        { h: 'Headers you\'ll meet in Anypoint' },
        { table: [['Header', 'Job'],
          ['`client_id`, `client_secret`', 'Identify the calling app, for Client ID enforcement and SLA tiers (lesson 2.10)'],
          ['`Authorization`', '`Bearer <token>` for OAuth 2.0, or `Basic ...`'],
          ['`X-Correlation-ID`', 'One id that follows a call through every layer, for tracing in the logs'],
          ['`Content-Type`, `Accept`', 'The body\'s format, and the format wanted back'],
          ['`Location`', 'Where a created item lives'],
          ['`ETag`, `If-None-Match`, `Cache-Control`', 'Caching (lesson 4.4)']] },
        { p: 'Put things in headers when they\'re about the call (who, how, tracing), and in the query when they\'re about the data (which, how many).' },
      ],
      check: { kind: 'build', prompt: 'Let `POST /books` take an optional `X-Correlation-ID` header, and make its `201` response return a `Location` header.', hints: ['`headers:` goes under `post:`, beside `body:` and `responses:`.', 'The response header goes under `201:`, next to `description:`: `headers:` then `Location:`.'],
        goals: [
          { say: 'POST /books takes an X-Correlation-ID header', endpoint: '/books', method: 'post', param: 'X-Correlation-ID', paramIn: 'header' },
          { say: 'Its 201 returns a Location header', endpoint: '/books', method: 'post', response: '201', responseHeader: 'Location' },
        ] } },
    { id: '2.3', title: 'Reading a spec, writing the call', minutes: 5, files: { 'library.raml': READ23 }, readOnly: true,
      body: [
        { p: 'An exam favourite: here is a spec, which request is right? Build the call from the outside in:' },
        { steps: ['baseUri', 'resource path', 'URI parameters', 'query', 'headers'] },
        { list: ['Start from `baseUri`, with `{version}` replaced by `version`: here `https://api.example.com/library/v2`.', 'Add the nested path, filling each URI parameter: `/members/7/loans`.', 'Add every *required* query parameter after `?`, joined with `&`, and any optional ones you need.', 'Put declared headers in headers, never in the query.'] },
        { p: 'Check each part against its facets too: an `enum` allows only its values, a `maximum` caps a number, and a missing required parameter is a `400`.' },
        { callout: 'On the right', text: 'The spec the questions are about. Read it before answering.' },
      ],
      check: { kind: 'quiz', questions: [
        { question: 'Which request lists the open loans of member 7?', options: [
          { text: '`GET https://api.example.com/library/v2/members/7/loans?status=open` with a `client_id` header', correct: true, why: 'Right. The version fills `{version}`, 7 fills `{memberId}`, the required `status` is in the query, and `client_id` is a header.' },
          { text: '`GET https://api.example.com/library/v2/members/loans?memberId=7&status=open` with a `client_id` header', why: '`memberId` is a URI parameter: it goes in the path, not the query.' },
          { text: '`GET https://api.example.com/library/v1/members/7/loans?status=open&client_id=...`', why: 'Two mistakes: the version is v2, and `client_id` is declared as a header.' },
        ] },
        { question: 'What is the fewest query parameters a valid call can send?', options: [
          { text: 'None', why: '`status` has no `?` and no `required: false`, so it\'s required.' },
          { text: 'One: `status`', correct: true, why: 'Right. `limit?` is optional, `status` isn\'t.' },
          { text: 'Two: `status` and `limit`', why: '`limit?` ends in `?`, so it can be left out.' },
        ] },
        { question: 'A call sends `status=lost`. With APIkit behind this spec, what does it get?', options: [
          { text: '`200` with no loans', why: 'APIkit checks parameters against the spec before any flow runs.' },
          { text: '`400`', correct: true, why: 'Right. `lost` isn\'t one of the enum\'s values, so the request is invalid: APIKIT:BAD_REQUEST, a 400.' },
          { text: '`404`', why: 'The path exists. It\'s the query that\'s wrong, which is a 400.' },
        ] },
      ] } },
    { id: '2.4', title: 'Types and facets', minutes: 8, files: { 'library.raml': BASE2 }, solution: { 'library.raml': S24 },
      wrong: [{ 'library.raml': S24.replace('    enum: [fiction, science, history]\n', '    enum: [fiction, science, history]\n    example: poetry\n') }],
      body: [
        { h: 'The built-in types' },
        { table: [['Type', 'Holds', 'Example'],
          ['`string`', 'text', '`Dune`'],
          ['`number`, `integer`', 'numbers, whole numbers', '`9.5`, `1965`'],
          ['`boolean`', 'true or false', '`true`'],
          ['`date-only`', 'a date', '`2026-11-03`'],
          ['`time-only`', 'a time of day', '`10:30:00`'],
          ['`datetime-only`', 'both, no time zone', '`2026-11-03T10:30:00`'],
          ['`datetime`', 'both, with a time zone (RFC 3339)', '`2026-11-03T10:30:00Z`'],
          ['`file`', 'a file upload', ''],
          ['`nil`', 'nothing: `null`', ''],
          ['`object`, `array`, `any`', 'properties, lists, anything', '']] },
        { h: 'Facets: rules on the values' },
        { table: [['On', 'Facets'],
          ['strings', '`minLength`, `maxLength`, `pattern` (a regular expression), `enum`'],
          ['numbers', '`minimum`, `maximum`, `multipleOf`, `format` (`int32`, `int64`...)'],
          ['arrays', '`items`, `minItems`, `maxItems`, `uniqueItems`'],
          ['objects', '`properties`, `minProperties`, `maxProperties`, `additionalProperties`'],
          ['any type', '`default`, `example`, `examples`, `description`, `displayName`, `required`']] },
        { code: 'Genre:\n  type: string\n  enum: [fiction, science, history]\n\nisbn?:\n  type: string\n  pattern: ^[0-9]{13}$' },
        { p: 'A property written short (`year: integer`) and long (`year:` then `type: integer` under it) mean the same: the long form has room for facets. A named type like `Genre` can then be a property\'s type, the same as `string`.' },
        { p: 'Objects accept extra properties unless `additionalProperties: false`. AMF checks every example against all of this.' },
      ],
      check: { kind: 'build', prompt: 'Declare a `Genre` string type that only allows `fiction`, `science` and `history`, and give `Book` an optional `genre` of that type.', hints: ['`Genre:` goes under `types:`, next to `Book:`, with `type: string` and `enum: [fiction, science, history]`.', 'In Book\'s properties: `genre?: Genre`.', 'Want more? Give `title` a `minLength: 1` and `isbn` a `pattern`.'],
        goals: [
          { say: 'Genre allows fiction, science and history', type: 'Genre', typeOf: 'string', enumHas: ['fiction', 'science', 'history'] },
          { say: 'Book has an optional genre of type Genre', type: 'Book', property: 'genre', propType: 'Genre', required: false },
        ] } },
    { id: '2.5', title: 'Inheritance and unions', minutes: 6, files: { 'library.raml': BASE2 }, solution: { 'library.raml': S25 },
      body: [
        { p: 'A type can *extend* another by naming it as its `type`. It gets all of its properties and adds its own:' },
        { code: 'Ebook:\n  type: Book\n  properties:\n    sizeMb: number' },
        { p: 'An Ebook is a Book with a size: anywhere a `Book` is expected, an `Ebook` fits too. A type can extend several at once: `type: [Book, Digital]`.' },
        { p: 'A *union* says "one of these": `Book | Ebook`. Unions are also how RAML says a value may be empty: `subtitle: string | nil` accepts a string or `null`.' },
        { h: 'Arrays, two ways' },
        { code: 'books: Book[]\n\nbooks:\n  type: array\n  items: Book\n  minItems: 1' },
        { p: 'The short form is the same as the long one; use the long one when you need facets like `minItems` or `uniqueItems`.' },
        { p: 'When a union of objects needs telling apart, a `discriminator` names the property that says which type each value is, and each type sets its `discriminatorValue`.' },
      ],
      check: { kind: 'build', prompt: 'Declare `Ebook`, extending `Book` with a required `sizeMb` (a number), and `Item`, a union of `Book` and `Ebook`.', hints: ['`Ebook:` goes under `types:` with `type: Book` and its own `properties:`.', 'A union fits on one line: `Item: Book | Ebook`.'],
        goals: [
          { say: 'Ebook extends Book', type: 'Ebook', typeOf: 'Book' },
          { say: 'Ebook adds a required sizeMb, a number', type: 'Ebook', property: 'sizeMb', propType: 'number', required: true },
          { say: 'Item is Book or Ebook', type: 'Item', typeOf: 'Book | Ebook' },
        ] } },
    { id: '2.6', title: 'Examples in depth', minutes: 6, files: { 'library.raml': BASE2 }, solution: { 'library.raml': S26 },
      wrong: [{ 'library.raml': S26.replace('      emma:\n        title: Emma\n        year: 1815\n', '      emma:\n        title: Emma\n') }],
      body: [
        { p: 'Examples can live on a *type* or on a *body*. On the type, every body using it gets them, so write them once there:' },
        { code: 'Book:\n  type: object\n  properties: ...\n  examples:\n    dune:\n      title: Dune\n      year: 1965\n    emma:\n      title: Emma\n      year: 1815' },
        { list: ['`example` holds one value. `examples` holds several, each under a name; the mock picks one by name with the `MS2-Example` header.', 'Examples are written in YAML and are *format independent*: the same example serves a JSON body and an XML one. That\'s the "format-independent examples" of the exam outline.', 'An example can also come from a file: `example: !include examples/dune.json`.', 'AMF checks each example against its type. To show an invalid value on purpose, write it as `value:` with `strict: false`.'] },
        { h: 'One type, two formats' },
        { p: 'A body can offer several media types, each with its type. Clients pick with `Accept`:' },
        { code: '200:\n  body:\n    application/json:\n      type: Book\n    application/xml:\n      type: Book' },
      ],
      check: { kind: 'build', prompt: 'Give `Book` two named examples (`dune` and `emma`), and let `GET /books/{bookId}` answer in `application/json` or `application/xml`.', hints: ['`examples:` goes inside `Book:`, at the level of `properties:`, with each name under it.', 'Every example needs the required `title` and `year`.', 'In the 200 of `GET /books/{bookId}`: under `body:`, an `application/json:` and an `application/xml:` key, each with `type: Book`.'],
        goals: [
          { say: 'Book has examples', type: 'Book', typeExample: true },
          { say: 'GET /books/{bookId} answers XML with a Book', endpoint: '/books/{bookId}', method: 'get', response: '200', media: 'application/xml', bodyType: 'Book' },
          { say: 'and JSON with a Book', endpoint: '/books/{bookId}', method: 'get', response: '200', media: 'application/json', bodyType: 'Book' },
        ] } },
    { id: '2.7', title: 'Resource types', minutes: 8, files: { 'library.raml': START27 }, solution: { 'library.raml': S27 },
      body: [
        { p: 'Most collections behave alike, and so do most items. A *resource type* is a template for a whole resource: write it once, apply it with `type:`.' },
        { code: 'resourceTypes:\n  collection:\n    get?:\n      responses:\n        200:\n          body:\n            type: <<item>>[]\n    post?:\n      body:\n        type: <<item>>\n\n/books:\n  type: { collection: { item: Book } }\n  get:\n  post:' },
        { list: ['`<<item>>` is a *parameter*: each resource that uses the type gives it a value, `{ item: Book }`.', 'A method ending in `?` (`get?`) is *optional*: it\'s added only to resources that declare that method themselves. Without the `?`, every resource of this type gets it.', 'Whatever the resource writes itself wins over what the type brings.', 'A resource has one resource type; it can use any number of traits.'] },
        { h: 'Parameters RAML fills in for you' },
        { table: [['Parameter', 'For `/books/{bookId}`'],
          ['`<<resourcePath>>`', '`/books/{bookId}`'],
          ['`<<resourcePathName>>`', '`books` (the last part that isn\'t a URI parameter)'],
          ['`<<methodName>>` (in traits)', '`get`, `post`...']] },
        { p: 'Functions change a value: `<<resourcePathName | !singularize>>` gives `book`, and there are `!pluralize`, `!uppercase`, `!lowercase`, `!uppercamelcase`, `!lowerhyphencase` and more.' },
        { callout: 'Below the editor', text: 'AMF shows each resource with its type. The methods it brings appear in the API console once the type is applied.' },
      ],
      check: { kind: 'build', prompt: 'Declare a `collection` and a `member` resource type with an `<<item>>` parameter, and apply them to `/books` and `/books/{bookId}` with `item: Book`.', hints: ['`resourceTypes:` goes at the left edge. `collection` gets `get?` and `post?`; `member` gets `get?` with 200 and 404.', 'Apply with `type: { collection: { item: Book } }` directly under `/books:`.', 'Keep `get:` (and `post:` on `/books`) in each resource so the optional methods are used.'],
        goals: [
          { say: 'There is a collection resource type', resourceTypeDecl: 'collection' },
          { say: 'There is a member resource type', resourceTypeDecl: 'member' },
          { say: '/books is a collection', endpoint: '/books', resourceType: 'collection' },
          { say: '/books/{bookId} is a member', endpoint: '/books/{bookId}', resourceType: 'member' },
        ] } },
    { id: '2.8', title: 'Traits in depth', minutes: 7, files: { 'library.raml': BASE2 }, solution: { 'library.raml': S28 },
      body: [
        { p: 'Traits take parameters too. Here each method says how big a page may be:' },
        { code: 'traits:\n  pageable:\n    queryParameters:\n      offset?:\n        type: integer\n      limit?:\n        type: integer\n        maximum: <<maxLimit>>\n\n/books:\n  get:\n    is: [pageable: { maxLimit: 50 }]' },
        { list: ['A method can use several traits: `is: [pageable, searchable]`. They\'re applied in order.', '`is:` on a *resource* applies the traits to every method of that resource (not to the resources nested in it).', 'The method\'s own declarations win over a trait\'s. Traits only fill in what\'s missing.', 'Traits can carry anything a method can: query parameters, headers, bodies, responses, `description`, `securedBy`.'] },
        { h: 'Trait or resource type?' },
        { table: [['', 'Trait', 'Resource type'],
          ['Describes', 'a behaviour of methods', 'a kind of resource'],
          ['Applied with', '`is: [...]`', '`type: ...`'],
          ['How many', 'any number', 'one per resource'],
          ['Examples', 'pageable, searchable, cacheable, client-id-required', 'collection, member, read-only collection']] },
      ],
      check: { kind: 'build', prompt: 'Declare a `pageable` trait with a `<<maxLimit>>` parameter and a `searchable` trait, and apply both to `GET /books` (with `maxLimit: 50`).', hints: ['`traits:` goes at the left edge. Give `pageable` an `offset?` and a `limit?` with `maximum: <<maxLimit>>`.', '`searchable` can have a `q?` query parameter.', 'Then under `get:` of `/books`: `is: [pageable: { maxLimit: 50 }, searchable]` (and remove the method\'s own `limit` so they don\'t overlap).'],
        goals: [
          { say: 'There is a pageable trait', trait: 'pageable' },
          { say: 'GET /books is pageable', endpoint: '/books', method: 'get', is: 'pageable' },
          { say: 'GET /books is searchable', endpoint: '/books', method: 'get', is: 'searchable' },
        ] } },
    { id: '2.9', title: 'Security schemes', minutes: 8, files: { 'library.raml': BASE2 }, solution: { 'library.raml': S29 },
      body: [
        { p: 'A *security scheme* describes how callers prove who they are. Declare it under `securitySchemes`, then say where it applies with `securedBy`:' },
        { code: 'securitySchemes:\n  oauth_2_0:\n    type: OAuth 2.0\n    describedBy:\n      headers:\n        Authorization:\n          type: string\n      responses:\n        401:\n          description: Bad or expired token\n    settings:\n      authorizationUri: https://auth.example.com/authorize\n      accessTokenUri: https://auth.example.com/token\n      authorizationGrants: [client_credentials]\n\nsecuredBy: [oauth_2_0]' },
        { table: [['`type`', 'Means'],
          ['`OAuth 2.0`', 'A bearer token from an authorization server. `settings` names its URLs and grants'],
          ['`OAuth 1.0`', 'The older, signed-request OAuth'],
          ['`Basic Authentication`', 'A user name and password in the `Authorization` header'],
          ['`Digest Authentication`', 'A hashed form of the same'],
          ['`Pass Through`', 'Headers or query parameters passed as they are, like an API key'],
          ['`x-{anything}`', 'Your own kind, like `x-custom`']] },
        { list: ['`describedBy` lists the headers, query parameters and responses the scheme adds, like a trait.', '`securedBy` at the top secures every method. On a resource or method it overrides that.', '`null` in the list means "also without credentials": `securedBy: [null, oauth_2_0]`.', 'OAuth scopes go with it: `securedBy: [oauth_2_0: { scopes: [admin] }]`.'] },
        { callout: 'Spec or policy?', text: 'The scheme *documents* what callers must send. Enforcing it is API Manager\'s job, with a policy like OAuth 2.0 token introspection or JWT validation (lesson 4.3). The two should agree.' },
      ],
      check: { kind: 'build', prompt: 'Declare an `oauth_2_0` scheme of type `OAuth 2.0` (with its `settings`), and secure the whole API with it.', hints: ['`securitySchemes:` goes at the left edge, then `oauth_2_0:` and `type: OAuth 2.0` under it.', 'OAuth 2.0 needs `settings:` with `authorizationUri`, `accessTokenUri` and `authorizationGrants`.', 'Then, at the left edge: `securedBy: [oauth_2_0]`.'],
        goals: [
          { say: 'There is an OAuth 2.0 scheme named oauth_2_0', scheme: 'oauth_2_0', schemeType: 'OAuth 2.0' },
          { say: 'The whole API is secured by it', securedBy: 'oauth_2_0' },
        ] } },
    { id: '2.10', title: 'Client ID enforcement', minutes: 6, files: { 'library.raml': BASE2 }, solution: { 'library.raml': S210 },
      body: [
        { p: 'The most common policy in Anypoint is *Client ID enforcement*: every call must say which registered app is calling, with a client id and secret. Apps get those by requesting access to the API in Exchange.' },
        { steps: ['Consumer finds the API in Exchange', 'Requests access (picks an SLA tier)', 'Gets a client id and secret', 'Sends them on every call', 'API Manager\'s policy checks them'] },
        { p: 'The policy reads them, in its usual setup, from two headers: `client_id` and `client_secret`. The spec should say so, so consumers know, and the usual way is a trait. API Manager even offers it as a RAML snippet when you apply the policy:' },
        { code: 'traits:\n  client-id-required:\n    headers:\n      client_id:\n        type: string\n      client_secret:\n        type: string\n    responses:\n      401:\n        description: Missing or wrong credentials' },
        { list: ['A call without valid credentials is refused with `401` before it reaches the Mule app.', 'With *SLA tiers*, each tier has its own rate limit; the *Rate limiting: SLA based* policy uses the client id to know whose quota to count, and answers `429` when it\'s used up.', '`is:` on a resource applies the trait to all of its methods; nested resources need their own.'] },
      ],
      check: { kind: 'build', prompt: 'Declare a `client-id-required` trait with `client_id` and `client_secret` headers, and apply it to both `/books` and `/books/{bookId}`.', hints: ['`traits:` at the left edge, then `client-id-required:` and `headers:` with the two names.', 'Apply it to a whole resource with `is: [client-id-required]` directly under `/books:`.', '`/{bookId}` is nested, so it needs its own `is:`.'],
        goals: [
          { say: 'There is a client-id-required trait', trait: 'client-id-required' },
          { say: 'Every method of /books uses it', endpoint: '/books', is: 'client-id-required' },
          { say: 'Every method of /books/{bookId} uses it', endpoint: '/books/{bookId}', is: 'client-id-required' },
        ] } },
    { id: '2.11', title: 'Documentation and annotations', minutes: 5, files: { 'library.raml': BASE2 }, solution: { 'library.raml': S211 },
      body: [
        { p: 'A spec is also the API\'s manual. Three places hold words for people:' },
        { list: ['`description` on the API, a resource, a method, a type or a parameter. Markdown works.', '`displayName` gives a resource or type a friendlier name in the API console.', '`documentation` at the top: pages, each with a `title` and `content`. Exchange shows them on the asset\'s page.'] },
        { code: 'documentation:\n  - title: Getting started\n    content: |\n      Ask the library team for a client id.' },
        { h: 'Annotations: your own keys' },
        { p: 'RAML only accepts keys it knows. To add your own (an owner, a deprecation note, a data classification), declare an *annotation type*, then use it in parentheses:' },
        { code: 'annotationTypes:\n  deprecated: string\n\n/books:\n  get:\n    (deprecated): Use GET /catalogue/items' },
        { p: 'Annotations don\'t change how the API behaves. Tools read them: governance rulesets, documentation, your own scripts.' },
      ],
      check: { kind: 'build', prompt: 'Add a `Getting started` documentation page, declare a `deprecated` annotation type, and mark `GET /books` with it.', hints: ['`documentation:` at the left edge, then `- title: Getting started` and `content:` under it.', '`annotationTypes:` at the left edge with `deprecated: string`.', 'Under `get:` of `/books`: `(deprecated): some text`.'],
        goals: [
          { say: 'There is a Getting started page', doc: 'Getting started' },
          { say: 'There is a deprecated annotation type', annotationType: 'deprecated' },
        ] } },
    { id: '2.12', title: 'Fragments', minutes: 7, files: { 'library.raml': START212, 'types/book.raml': '', 'traits/pageable.raml': '' }, solution: { 'library.raml': S212, 'types/book.raml': FRAG_BOOK, 'traits/pageable.raml': FRAG_PAGEABLE },
      body: [
        { p: 'A *fragment* is one piece of a spec in its own file, with its own first line, pulled in with `!include`:' },
        { table: [['First line', 'Holds', 'Included as'],
          ['`#%RAML 1.0 DataType`', 'one type', '`Book: !include types/book.raml`'],
          ['`#%RAML 1.0 Trait`', 'one trait', '`pageable: !include traits/pageable.raml`'],
          ['`#%RAML 1.0 ResourceType`', 'one resource type', 'under `resourceTypes:`'],
          ['`#%RAML 1.0 SecurityScheme`', 'one security scheme', 'under `securitySchemes:`'],
          ['`#%RAML 1.0 NamedExample`', 'named examples', '`examples: !include examples/books.raml`'],
          ['`#%RAML 1.0 DocumentationItem`, `AnnotationTypeDeclaration`', 'a page, an annotation type', 'where those go'],
          ['(none)', 'plain JSON, XML or text', '`example: !include examples/dune.json`']] },
        { p: 'A fragment has no name of its own: the key you include it under is its name. Paths are relative to the including file, or start with `/` for the project\'s root.' },
        { p: 'Fragments are what teams publish to Exchange as *RAML fragments*, so other APIs depend on them (lesson 3.2). In Design Center you make one as a *fragment project*.' },
        { callout: 'Three files', text: 'Switch between them with the tabs above the editor.' },
      ],
      check: { kind: 'build', prompt: 'Move `Book` into the DataType fragment `types/book.raml` and `pageable` into the Trait fragment `traits/pageable.raml`, and include both from library.raml.', hints: ['types/book.raml starts with `#%RAML 1.0 DataType`, then Book\'s content (from `type: object`) at the left edge.', 'traits/pageable.raml starts with `#%RAML 1.0 Trait`, then `queryParameters:` at the left edge.', 'In library.raml: `Book: !include types/book.raml` and `pageable: !include traits/pageable.raml`.'],
        goals: [
          { say: 'types/book.raml is a DataType fragment in use', fragment: 'types/book.raml', kind: 'DataType' },
          { say: 'traits/pageable.raml is a Trait fragment in use', fragment: 'traits/pageable.raml', kind: 'TraitFragment' },
          { say: 'Book still has its required title', type: 'Book', property: 'title', required: true },
          { say: 'GET /books is still pageable', endpoint: '/books', method: 'get', is: 'pageable' },
        ] } },
    { id: '2.13', title: 'Libraries', minutes: 6, files: { 'library.raml': ROOT213, 'libraries/types.raml': '#%RAML 1.0 Library\nusage: The Library API\'s data types\n' },
      solution: { 'library.raml': ROOT213.replace(/types:\n {2}Book:[\s\S]*?isbn\?: string\n\n/, 'uses:\n  lib: libraries/types.raml\n\n').replace('type: Book', 'type: lib.Book'), 'libraries/types.raml': LIB213 },
      body: [
        { p: 'A fragment holds one thing. A *library* holds many: types, traits, resource types, security schemes and annotation types, together. It starts with `#%RAML 1.0 Library`, and the root file brings it in with `uses`, giving it a short name, a *namespace*:' },
        { code: 'uses:\n  lib: libraries/types.raml\n\n# then, anywhere in the root file:\ntype: lib.Book\nis: [lib.pageable]' },
        { table: [['', 'Fragment', 'Library'],
          ['Holds', 'one declaration', 'any number'],
          ['Brought in with', '`!include` where the value goes', '`uses:` at the top'],
          ['Referred to as', 'whatever name you include it under', '`alias.Name`']] },
        { list: ['A library can `uses:` other libraries too.', 'Libraries are how teams share types across APIs: published to Exchange, they become *Exchange dependencies* of other projects.', 'The root file is the one Design Center checks and publishes. The others are reached from it.'] },
        { callout: 'Two files', text: 'Switch between them with the tabs above the editor.' },
      ],
      check: { kind: 'build', prompt: 'Move `Book` into the library `libraries/types.raml`, bring it in with `uses` as `lib`, and use it as `lib.Book`.', hints: ['Cut the whole `types:` block from library.raml and paste it at the end of libraries/types.raml.', 'In library.raml, where `types:` was: `uses:` and, under it, `lib: libraries/types.raml`.', 'Then the response body becomes `type: lib.Book`.'],
        goals: [
          { say: 'Book is declared in libraries/types.raml', type: 'Book', file: 'libraries/types.raml' },
          { say: 'GET /books/{bookId} returns lib.Book', endpoint: '/books/{bookId}', method: 'get', response: '200', bodyType: 'lib.Book' },
        ] } },
    { id: '2.14', title: 'Overlays and extensions', minutes: 4, files: { 'extension.raml': EXTENSION, 'overlay.raml': OVERLAY, 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: 'Two kinds of file change an API without editing it. Both start with `extends:`, naming the spec they apply to:' },
        { table: [['', 'Overlay', 'Extension'],
          ['First line', '`#%RAML 1.0 Overlay`', '`#%RAML 1.0 Extension`'],
          ['May add', 'only words: descriptions, documentation, examples, annotations', 'anything: new methods, resources, parameters'],
          ['Typical use', 'a translation, documentation for another audience', 'an internal version with extra methods']] },
        { p: 'The API itself never mentions them: you open the overlay or extension as the file to read, and it brings the spec with it.' },
        { callout: 'Proven by AMF', text: 'An overlay that adds a method is an error ("not allowed to be overriden or added in overlays"). The extension on the right adds `DELETE /books/{bookId}`, and AMF accepts it.' },
      ],
      check: { kind: 'choice', question: 'Partners need the Library API documented in Spanish, without changing the API. Which do you write?', options: [
        { text: 'An Overlay', correct: true, why: 'Right. An overlay only adds or replaces descriptions, documentation, examples and annotations, which is exactly a translation.' },
        { text: 'An Extension', why: 'An extension would work, but it\'s for changing behaviour. An overlay guarantees only the words change.' },
        { text: 'A copy of the spec in Spanish', why: 'Then there are two specs to keep in step. An overlay applies to the one spec.' },
      ] } },
    { id: '2.15', title: 'RAML at a glance', minutes: 6, files: { 'library.raml': GLANCE, 'libraries/common.raml': GLANCE_LIB }, readOnly: true,
      body: [
        { p: 'On the right: one spec with nearly everything from Parts 1 and 2, valid in AMF. Read it top to bottom; each part is a lesson you\'ve done.' },
        { table: [['Where', 'What', 'Lesson'],
          ['top', '`title`, `version`, `baseUri`, `protocols`, `mediaType`, `documentation`', '1.5, 2.11'],
          ['`uses:`', 'a library, used as `common.Error`', '2.13'],
          ['`securitySchemes:`, `securedBy:`', 'OAuth 2.0 for everything, with a scope on DELETE', '2.9'],
          ['`types:`', 'an enum, facets, inheritance', '2.4, 2.5'],
          ['`resourceTypes:`', '`collection`, with optional methods and a parameter', '2.7'],
          ['`traits:`', '`pageable`, with a parameter', '2.8'],
          ['`/books`', 'a resource type, a trait, a query parameter of a named type', '1.10, 2.1'],
          ['`/{bookId}`', 'a typed URI parameter, an annotation', '2.1, 2.11']] },
      ],
      check: { kind: 'quiz', questions: [
        { question: 'In this spec, what does `GET /books` accept as `limit`?', options: [
          { text: 'Any integer', why: 'The `pageable` trait sets `maximum: <<maxLimit>>`, and `/books` passes 50.' },
          { text: 'An integer up to 50', correct: true, why: 'Right. The trait\'s parameter becomes the maximum.' },
          { text: 'Nothing: `limit` isn\'t declared on `/books`', why: 'It comes from the trait, applied with `is:`.' },
        ] },
        { question: 'Which credentials does `GET /books/{bookId}` need?', options: [
          { text: 'None: it has no `securedBy` of its own', why: 'The top-level `securedBy` applies to every method that doesn\'t override it.' },
          { text: 'An OAuth 2.0 token', correct: true, why: 'Right, from the top-level `securedBy: [oauth_2_0]`. DELETE also needs the admin scope.' },
        ] },
        { question: 'Where is `Error` declared?', options: [
          { text: 'In library.raml\'s types', why: 'It\'s written `common.Error`: the part before the dot is a library\'s namespace.' },
          { text: 'In libraries/common.raml', correct: true, why: 'Right. `uses:` names that library `common`.' },
        ] },
        { question: '`POST /books` declares no body in the resource. What does it take?', options: [
          { text: 'Nothing', why: 'The resource type brings `post?` with a body of `<<item>>`, and `post:` is declared, so it\'s used.' },
          { text: 'A `Book`', correct: true, why: 'Right. `collection` with `item: Book` gives it `body: type: Book`, and a 201 with a Location header.' },
        ] },
      ] } },
  ] },
  { title: 'Part 3 · The Design Center way', note: 'How real projects are made, shared, mocked, published and checked.', lessons: [
    { id: '3.1', title: 'Design Center', minutes: 5, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: '*Design Center* is where specs are written in Anypoint. Its API Designer is a code editor with help around it, and Design Studio keeps the same layout and words.' },
        { table: [['Part', 'What it does'],
          ['Project types', 'An API specification (RAML 1.0, OAS 2.0 or 3.0) or a fragment (a library, a type, a trait, examples...)'],
          ['Files', 'The project\'s files, one of them the *root file*: the one that is checked, mocked and published'],
          ['The shelf', 'Under the editor: what can go where the cursor is (methods, types, traits, parameters...), click to insert'],
          ['Project errors', 'What the parser found, file by file'],
          ['Documentation', 'The API console: the spec as readable docs, with a Try it on each method'],
          ['Mocking service', 'A temporary server that answers from the spec (lesson 3.3)'],
          ['Exchange dependencies', 'Fragments and libraries from Exchange, used by this project'],
          ['Publish', 'Sends the spec to Exchange as a new asset version (lesson 3.4)']] },
        { p: 'Projects are kept with branches and a history, and only one person edits a branch at a time: Design Center takes a *lock* while you edit, and others see it read only.' },
        { p: 'Specs that only exist in Design Center can\'t be used by other projects. *Publishing* to Exchange is what makes them visible and reusable.' },
      ],
      check: { kind: 'choice', question: 'Your project has five RAML files. Which one does Design Center publish and mock?', options: [
        { text: 'All of them, one asset each', why: 'One project is one asset. The other files are included from one of them.' },
        { text: 'The root file, with what it includes and uses', correct: true, why: 'Right. The root file is the API; the others are reached from it.' },
        { text: 'The one open in the editor', why: 'What\'s open doesn\'t matter. The root file is set once, with "Set as root file".' },
      ] } },
    { id: '3.2', title: 'Exchange and dependencies', minutes: 5, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: '*Exchange* is Anypoint\'s catalogue. Published specs, fragments, connectors, templates, examples, policies and rulesets live there, each as an *asset* with a group (your organization), an id and versions.' },
        { list: ['A **REST API** asset is a full spec. Its page shows the documentation, a mock to try, and lets consumers request access to its API instances.', 'A **RAML fragment** asset is a library or fragment, made to be depended on.', 'Assets can be shared inside your organization, or put on a public *API portal*.'] },
        { h: 'Dependencies' },
        { p: 'When a project depends on an Exchange asset, Design Center lists it in `exchange.json` and keeps a copy under `exchange_modules/<group>/<asset>/<version>/`. You then `uses:` or `!include` it from there, like any file in the project. The copy is read only: to change it, change the asset and publish a new version.' },
        { code: 'uses:\n  common: exchange_modules/acme/common-types/1.0.3/common.raml' },
        { list: ['A shared library of types is the most common dependency: every API of a team uses the same `Customer` and `Error`.', 'Changing a dependency\'s version updates the folder and every path that points into it.'] },
        { p: 'In Design Studio, the Dependencies panel on the left adds, updates and removes them.' },
      ],
      check: { kind: 'quiz', questions: [
        { question: 'You need a fix that was made in version 1.0.3 of a shared types library your API depends on (you have 1.0.1). What do you do?', options: [
          { text: 'Edit the files under `exchange_modules/`', why: 'Those are a read only copy of the published asset. Edits there aren\'t yours to make and would be lost.' },
          { text: 'Change the dependency to version 1.0.3', correct: true, why: 'Right. The new version is fetched, and the paths pointing into the old folder are updated.' },
          { text: 'Copy the fixed type into your own spec', why: 'Then your API stops sharing the type with the others, which is what the library is for.' },
        ] },
        { question: 'A team wants every API in the organization to use the same `Error` type. What do they publish?', options: [
          { text: 'A REST API asset with an `Error` type in it', why: 'A full spec can\'t be depended on like a library. Shared pieces are published as fragments.' },
          { text: 'A RAML fragment (a library) holding `Error`', correct: true, why: 'Right. Other projects add it as an Exchange dependency and `uses:` it.' },
        ] },
      ] } },
    { id: '3.3', title: 'Mock and try it', minutes: 4, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: 'A *mock* is a pretend server that answers from the spec: with each response\'s example, or a value made up from its type. Callers can build against it before the API exists, and their feedback comes while the design is still cheap to change.' },
        { p: 'In Design Center, the *mocking service* gives the spec a temporary URL; it can be made public so people outside the editor can call it. A few headers pick the answer, and Design Studio\'s local mock reads the same:' },
        { table: [['Header', 'Does'],
          ['`MS2-Status-Code: 404`', 'Answers with that response'],
          ['`MS2-Example: emma`', 'Picks a named example'],
          ['`MS2-Error-Rate: 0.5`', 'Fails that share of calls, to test the client'],
          ['`MS2-Randomize: true`', 'Makes up values instead of using the examples'],
          ['`MS2-Delay: 2000`', 'Waits before answering']] },
        { p: 'The mock checks requests like the real thing would: a missing required parameter gets a 400. In Design Studio, the Documentation panel has a Try it on every method, and it calls the local mock, with your unsaved edits included.' },
      ],
      check: { kind: 'choice', question: 'Your spec gives `GET /books/{bookId}` a 200 and a 404. How do you see the 404 on the mock?', options: [
        { text: 'Ask for a book id that doesn\'t exist', why: 'The mock doesn\'t store books, so it can\'t know which ids exist. It answers from the spec.' },
        { text: 'Send the header `MS2-Status-Code: 404`', correct: true, why: 'Right. The mock then answers with the 404 response from the spec.' },
        { text: 'You can\'t: the mock only gives 200', why: 'It can give any response the spec declares. A header picks which.' },
      ] } },
    { id: '3.4', title: 'Publishing and versions', minutes: 7, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: '*Publish* sends the spec to Exchange as a new version of its asset. Asset versions follow *semantic versioning*, `major.minor.patch`:' },
        { table: [['Change', 'Bump', 'Examples'],
          ['Breaks existing callers', '**major**: 1.4.2 to 2.0.0', 'a removed resource or method, a new *required* parameter or property, a changed type, a renamed field'],
          ['Adds, breaks nothing', '**minor**: 1.4.2 to 1.5.0', 'a new resource, method, optional parameter or optional property'],
          ['Changes nothing callers see', '**patch**: 1.4.2 to 1.4.3', 'a fixed description or example']] },
        { h: 'Two different versions' },
        { p: 'Don\'t mix them up, it\'s a classic exam trap:' },
        { list: ['The **API version** is the spec\'s `version: v1`. It\'s in the URL through `{version}` and moves only on breaking changes.', 'The **asset version** is Exchange\'s `1.4.2`. Every publish has a new one. Its major follows the API version: assets 1.x.x are `v1`, 2.x.x are `v2`.'] },
        { h: 'A breaking change, step by step' },
        { steps: ['`version: v2` in the spec', 'Publish asset 2.0.0', 'New API instance in API Manager', 'Run v1 and v2 side by side', 'Deprecate v1 in Exchange, then retire it'] },
        { p: 'An API instance in API Manager can move to newer minor and patch versions of its asset. A new major gets its own instance, so v1 consumers keep working while they move.' },
        { p: 'A version can be **Stable** (the default) or **Development**. A Stable version is final: it can\'t be published again. A Development version can be republished while you iterate. Design Studio\'s Exchange panel compares your spec with the last published version and suggests the next number.' },
      ],
      check: { kind: 'quiz', questions: [
        { question: 'Version 1.4.2 is published. You add an optional `sort` query parameter to `GET /books`. What\'s the next version?', options: [
          { text: '2.0.0', why: 'An optional parameter breaks no existing call, so it isn\'t a major change.' },
          { text: '1.5.0', correct: true, why: 'Right. Something new, nothing broken: a minor version, with patch back to 0.' },
          { text: '1.4.3', why: 'Patch is for changes that don\'t touch the API. A new parameter does.' },
        ] },
        { question: 'Version 1.5.0 is out. You make `isbn` a *required* property of the `Book` that `POST /books` takes. What now?', options: [
          { text: 'Publish 1.6.0', why: 'Callers that don\'t send an isbn would start getting 400s. That breaks them.' },
          { text: 'Publish 2.0.0 with `version: v2`, and keep v1 running until consumers move', correct: true, why: 'Right. A new required field is a breaking change: a new major, and a new API version beside the old one.' },
          { text: 'Republish 1.5.0', why: 'A Stable version can\'t be published again, and it would break callers anyway.' },
        ] },
      ] } },
    { id: '3.5', title: 'Governance', minutes: 4, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: 'Teams agree on rules for their APIs: names in kebab-case, every response with an example, an error type on every 4xx, OAuth on everything. Written down for a machine, these are *rulesets*, published to Exchange like any asset.' },
        { p: 'A project that depends on a ruleset is checked against it: Design Center\'s Governance shows each rule the API breaks, as a violation, a warning or information. MuleSoft publishes rulesets too, like the *Anypoint Best Practices* and *OWASP API Security Top 10*. API Governance in Anypoint applies rulesets across many APIs at once, and reports conformance.' },
        { list: ['Add a ruleset as a dependency, then read its findings in the Governance tab.', 'A rule that doesn\'t fit this API can be switched off for it, without editing the ruleset.', 'Rulesets are often the C4E\'s way of writing its standards down.'] },
      ],
      check: { kind: 'choice', question: 'Your team\'s ruleset says every resource name must be kebab-case. What happens to an API with `/bookLoans`?', options: [
        { text: 'AMF reports it as an invalid spec', why: 'The spec is valid RAML. Governance rules are a team\'s own agreement, checked on top.' },
        { text: 'Governance reports a finding for that rule', correct: true, why: 'Right. It shows in Governance as a violation or warning, with where it is, so it can be renamed to `/book-loans`.' },
        { text: 'It can\'t be published to Exchange', why: 'Publishing doesn\'t depend on governance findings. They\'re there to be fixed, not to block.' },
      ] } },
  ] },
  { title: 'Part 4 · From spec to running API', note: 'What happens to the spec after Design Center: APIkit, consumers, API Manager.', lessons: [
    { id: '4.1', title: 'APIkit', minutes: 8, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: '*APIkit* turns a spec into the skeleton of a Mule application. In Anypoint Studio, create a project from the spec (from Exchange, Design Center or a local file) and APIkit *scaffolds* it:' },
        { list: ['A **main flow**, `library-main`: an HTTP Listener (on `/api/*` by default) and the **APIkit Router**.', 'A **console flow**, `library-console`, serving the API console for the spec.', 'One **flow per method and resource**, named after them. Its body starts as the spec\'s example, so it answers right away.', 'An **error handler** in the main flow mapping APIkit\'s errors to status codes.'] },
        { code: 'get:\\books:library-config\npost:\\books:library-config\nget:\\books\\(bookId):library-config' },
        { p: 'The names read: method, then the path with `\\` for `/` and `(bookId)` for `{bookId}`, then the router configuration. The router sends each request to the flow with the matching name.' },
        { h: 'The router checks every request against the spec' },
        { table: [['Error', 'Status', 'When'],
          ['`APIKIT:BAD_REQUEST`', '400', 'a required parameter or header is missing, a value breaks its type or facets, the body doesn\'t fit'],
          ['`APIKIT:NOT_FOUND`', '404', 'no resource matches the path'],
          ['`APIKIT:METHOD_NOT_ALLOWED`', '405', 'the resource exists, the method doesn\'t'],
          ['`APIKIT:NOT_ACCEPTABLE`', '406', 'the `Accept` asks for a format the spec doesn\'t offer'],
          ['`APIKIT:UNSUPPORTED_MEDIA_TYPE`', '415', 'the body\'s `Content-Type` isn\'t one the spec takes'],
          ['`APIKIT:NOT_IMPLEMENTED`', '501', 'the spec declares it, but there\'s no flow for it']] },
        { p: 'When the spec changes, scaffold again: APIkit adds flows for what\'s new and leaves your existing flows alone. You can also build the interface by hand, an HTTP Listener per path, but then nothing checks requests against the spec for you.' },
      ],
      check: { kind: 'quiz', questions: [
        { question: 'Which flow handles `GET /books/42` in a project scaffolded from this spec (router config `library-config`)?', options: [
          { text: '`get:\\books\\42:library-config`', why: 'Flows are named after the spec\'s resource, with the URI parameter, not the value.' },
          { text: '`get:\\books\\(bookId):library-config`', correct: true, why: 'Right. `{bookId}` becomes `(bookId)`, and the router matches `/books/42` to it.' },
          { text: '`library-main`', why: 'The main flow receives the request, and its router passes it on to the method\'s flow.' },
        ] },
        { question: 'A client calls `DELETE /books/42`, which the spec doesn\'t declare. What does it get?', options: [
          { text: '404 Not Found', why: 'The resource `/books/{bookId}` exists. It\'s the method that doesn\'t.' },
          { text: '405 Method Not Allowed', correct: true, why: 'Right: APIKIT:METHOD_NOT_ALLOWED.' },
          { text: '501 Not Implemented', why: '501 is for a method the spec declares but that has no flow.' },
        ] },
        { question: 'You add `PUT /books/{bookId}` to the spec and scaffold again. What happens to `get:\\books:library-config`, which you\'ve already built?', options: [
          { text: 'It\'s regenerated, and your work is lost', why: 'APIkit doesn\'t overwrite flows that already exist.' },
          { text: 'It\'s left as it is, and a new flow is added for the PUT', correct: true, why: 'Right. Scaffolding only adds what\'s missing.' },
        ] },
      ] } },
    { id: '4.2', title: 'Consuming an API', minutes: 5, files: { 'library.raml': SAMPLE }, readOnly: true,
      body: [
        { p: 'The other side: a Mule app that *calls* the Library API. Two ways:' },
        { table: [['', 'HTTP Request', 'A REST connector (REST Connect)'],
          ['What it is', 'The generic HTTP operation: you set method, path, parameters and body', 'A connector Exchange generates from a published REST API spec'],
          ['Where it comes from', 'The HTTP connector, always there', 'Exchange, added to the project from Studio\'s palette'],
          ['Operations', 'One: request', 'One per method and resource, with typed parameters and DataSense metadata from the spec\'s types']] },
        { p: 'Exchange generates the connector by itself when a RAML or OAS spec is published as a REST API asset, so consumers don\'t write one. Until the implementation exists, consumers can point either at the mock.' },
        { h: 'Reading a spec as a consumer' },
        { list: ['Which methods and resources there are, and which parameters are required: the API console in Exchange shows them.', 'Which credentials: `securedBy` and traits like `client-id-required`, and the API instance\'s policies.', 'Which errors to expect: the responses, and the 401, 429 and 5xx every managed API can give.'] },
      ],
      check: { kind: 'choice', question: 'Your team publishes the Library API spec to Exchange. Another team wants typed operations for it in Anypoint Studio, without writing a connector. What do they use?', options: [
        { text: 'The connector Exchange generated from the spec (REST Connect)', correct: true, why: 'Right. Publishing a REST API spec makes Exchange generate a connector with an operation per method.' },
        { text: 'APIkit', why: 'APIkit builds the *implementation* of an API from its spec, not a client for it.' },
        { text: 'The Database connector', why: 'Consumers call the API, not the database behind it.' },
      ] } },
    { id: '4.3', title: 'API Manager and policies', minutes: 8, files: {},
      aside: { title: 'Policies you should know', body: [
        { table: [['Policy', 'Does', 'Refuses with'],
          ['Client ID enforcement', 'Only registered apps, with a client id and secret', '401'],
          ['Rate limiting', 'At most N calls per time window, for everyone', '429'],
          ['Rate limiting: SLA based', 'A quota per client app, from its SLA tier', '429 (and 401 without a client id)'],
          ['Spike control', 'Smooths bursts: queues and retries before refusing', '429'],
          ['IP allowlist, IP blocklist', 'Only, or not, these addresses', '403'],
          ['Basic authentication', 'A user and password', '401'],
          ['OAuth 2.0 token introspection, JWT validation', 'A valid token from your identity provider', '401 or 403'],
          ['HTTP caching', 'Keeps responses and answers repeats from the cache', ''],
          ['Header injection, header removal', 'Adds or strips headers', ''],
          ['CORS', 'Lets browsers on other sites call the API', '']] },
      ] },
      body: [
        { p: '*API Manager* is where a running API is secured and governed, without changing its code. Its building block is the *API instance*: one managed version of an API from Exchange, in one environment.' },
        { h: 'Connecting the implementation' },
        { list: ['**Autodiscovery**: the Mule app declares the API instance\'s id (`api.id`), and runs with the environment\'s client id and secret. At start it registers with API Manager and fetches its policies. Policies run in the Mule runtime itself.', '**Proxy**: for an implementation that isn\'t Mule (or can\'t be changed), API Manager deploys a proxy app in front of it, and policies run there.'] },
        { h: 'Policies' },
        { p: 'A *policy* is a rule applied to every call of an API instance (or to some methods and resources), like the ones on the right. They can be stacked, and their order matters.' },
        { h: 'SLA tiers and contracts' },
        { p: '*SLA tiers* (Gold: 1000 calls a minute, Free: 10) are defined on the API instance, each approved automatically or by hand. A consumer\'s *client application* requests access in Exchange for a tier; once approved, there\'s a *contract*, and the app\'s client id and secret work. An SLA-based policy then counts each app against its own tier.' },
        { p: 'This is why the spec declares `client_id` and `client_secret` (lesson 2.10): the policy enforces them, the spec tells consumers to send them.' },
      ],
      check: { kind: 'quiz', questions: [
        { question: 'Partners on a Gold plan may make 1000 calls a minute, Free ones 10. Which policy?', options: [
          { text: 'Rate limiting', why: 'Plain rate limiting has one limit for everyone. It can\'t tell partners apart.' },
          { text: 'Rate limiting: SLA based', correct: true, why: 'Right. Each tier has its quota, and the client id says which app (and tier) is calling.' },
          { text: 'Spike control', why: 'Spike control smooths bursts. It doesn\'t give different apps different quotas.' },
        ] },
        { question: 'The Library API is a Node.js service the team can\'t change. How do you apply policies to it?', options: [
          { text: 'Autodiscovery', why: 'Autodiscovery is configured inside a Mule application.' },
          { text: 'Deploy an API proxy from API Manager in front of it', correct: true, why: 'Right. The proxy receives the calls, runs the policies, and forwards to the service.' },
        ] },
        { question: 'A call arrives with no `client_id` at an API with Client ID enforcement. What does the caller get?', options: [
          { text: '401 Unauthorized', correct: true, why: 'Right. The policy refuses it before the request reaches the implementation.' },
          { text: '400 Bad Request', why: 'The policy answers before APIkit sees the request, and missing credentials are a 401.' },
          { text: '429 Too Many Requests', why: '429 is for rate limits, not missing credentials.' },
        ] },
      ] } },
    { id: '4.4', title: 'Caching, retries and tracing', minutes: 6, files: {},
      aside: { title: 'The headers involved', body: [
        { table: [['Header', 'Sent by', 'Means'],
          ['`Cache-Control: max-age=60`', 'the API', 'This answer may be reused for 60 seconds'],
          ['`Cache-Control: no-store`', 'the API', 'Never keep this answer'],
          ['`ETag: "v7"`', 'the API', 'A tag for this version of the resource'],
          ['`If-None-Match: "v7"`', 'the client', 'Only send it if it changed (else 304)'],
          ['`Retry-After: 30`', 'the API', 'Try again in 30 seconds (with 429 or 503)'],
          ['`X-Correlation-ID`', 'everyone', 'The same id on every hop of one call']] },
      ] },
      body: [
        { p: 'Production APIs (the Developer II side of things) need a few more ideas, and each one shows up in the spec.' },
        { h: 'Caching' },
        { p: 'Reading the same book a thousand times shouldn\'t hit the database a thousand times. The *HTTP caching* policy keeps responses (keyed by the request path by default) and answers repeats from the cache for a time to live; it can honour the `Cache-Control` headers of the request and response. Only safe methods, like GET, should be cached. Declare those headers on the responses, so consumers know.' },
        { h: 'Retries and idempotency' },
        { p: 'Networks fail, so clients retry. A retry is safe only for idempotent methods (GET, PUT, DELETE). For POST, a client can send an idempotency key header, and the implementation remembers keys it has already seen (Mule\'s Idempotent Message Validator does exactly that) so a retried POST doesn\'t create a second book.' },
        { h: 'Tracing' },
        { p: 'A call to an Experience API becomes several calls below it. One `X-Correlation-ID`, passed along on every hop and written in every log line, lets you follow it. Declare it in a trait so every method shows it.' },
      ],
      check: { kind: 'quiz', questions: [
        { question: 'Which methods should the HTTP caching policy cache?', options: [
          { text: 'GET (and HEAD)', correct: true, why: 'Right. They only read; caching a POST would skip creating things.' },
          { text: 'All of them', why: 'A cached POST or DELETE wouldn\'t reach the implementation, so nothing would change.' },
        ] },
        { question: 'A client retries a `POST /loans` after a timeout. How do you avoid lending the book twice?', options: [
          { text: 'Make loans a PUT instead', why: 'PUT replaces a resource the client already knows the address of. A new loan is a create.' },
          { text: 'Have the client send an idempotency key, and reject keys already processed', correct: true, why: 'Right. The same key on the retry is recognized, so the loan is made once.' },
          { text: 'Rate limit the API', why: 'A rate limit counts calls; it can\'t tell a retry from a new loan.' },
        ] },
      ] } },
  ] },
  { title: 'Part 5 · OAS', note: 'The same ideas in the other language Design Center speaks.', lessons: [
    { id: '5.1', title: 'OAS for RAML designers', minutes: 6, files: { 'library.yaml': OAS31 }, solution: { 'library.yaml': OAS31_SOLVED },
      body: [
        { p: '*OAS* (OpenAPI) describes the same things as RAML with different words:' },
        { table: [['RAML', 'OAS 3.0'],
          ['Nested resources', '`paths`, written flat: `/books` and `/books/{bookId}` side by side'],
          ['`200:`', '`\'200\':`, quoted, and every response needs a `description`'],
          ['`body:` with `mediaType` set once', '`content:` then `application/json:` then `schema:`, on every body'],
          ['`types:`, used by name', '`components: schemas:`, used with `$ref: \'#/components/schemas/Book\'`'],
          ['`isbn?` for optional', '`required: [title, year]` lists the required ones'],
          ['`queryParameters`, `headers`, `uriParameters`', '`parameters:` with `in: query`, `header` or `path`'],
          ['`securitySchemes`, `securedBy`', '`components: securitySchemes`, `security`'],
          ['traits, resource types', 'no equivalent: OAS repeats, or uses `$ref` for single pieces']] },
        { code: "paths:\n  /books:\n    get:\n      responses:\n        '200':\n          description: The books\n          content:\n            application/json:\n              schema:\n                type: array\n                items:\n                  $ref: '#/components/schemas/Book'" },
      ],
      check: { kind: 'build', prompt: 'Add `GET /books`, answering 200 with a list of `Book`, and declare `Book` with a required `title` and `year`.', hints: ['Replace `paths: {}` with `paths:` and `/books:` under it.', 'The schema of a list: `type: array` and `items:` with the `$ref` under it.', '`components:` goes at the left edge, with `schemas:` and `Book:` under it.'],
        goals: [
          { say: 'GET /books answers 200 with Book[]', endpoint: '/books', method: 'get', response: '200', bodyType: 'Book[]' },
          { say: 'Book has a required title', type: 'Book', property: 'title', required: true },
          { say: 'Book has a required year, an integer', type: 'Book', property: 'year', propType: 'integer', required: true },
        ] } },
    { id: '5.2', title: 'RAML or OAS?', minutes: 2, files: { 'library.yaml': OAS31_SOLVED }, readOnly: true,
      body: [
        { p: 'Both work in Design Center, Exchange, APIkit and API Manager. Pick by who reads the spec:' },
        { list: ['**RAML** when the API lives in Anypoint: libraries, traits and resource types make big families of APIs short and consistent, and most MuleSoft projects use it.', '**OAS** when the API is shared outside: almost every tool and gateway reads OpenAPI.'] },
        { p: 'You don\'t have to choose forever: Design Studio\'s Duplicate As turns a RAML spec into OAS 3.0 or 2.0 with AMF.' },
      ],
      check: { kind: 'choice', question: 'Your API will be called by a partner who builds their client from the spec with a generic OpenAPI tool. Which language do you hand them?', options: [
        { text: 'RAML', why: 'RAML works in Anypoint, but a generic tool outside it expects OpenAPI.' },
        { text: 'OAS', correct: true, why: 'Right. And if the design is in RAML, Duplicate As converts it.' },
      ] } },
  ] },
  { title: 'Part 6 · Exam practice', note: 'Mixed questions in the style of the MuleSoft Developer exams. Each answer says why.', lessons: [
    { id: '6.1', title: 'Developer I: designing APIs', minutes: 12, files: { 'library.raml': GLANCE, 'libraries/common.raml': GLANCE_LIB }, readOnly: true,
      body: [
        { p: 'Ten questions on application networks, HTTP, RAML and APIkit, like the design part of the Developer I exam. Some refer to the spec on the right.' },
        { callout: 'How to use it', text: 'Answer before reading the explanations. A wrong pick shows why; pick again until all ten are right. Lessons to revisit are named in the answers.' },
      ],
      check: { kind: 'quiz', questions: [
        { question: 'What is an API *interface*?', options: [
          { text: 'The Mule application that runs the API', why: 'That\'s the API implementation (1.1).' },
          { text: 'The contract: the RAML or OAS spec of resources, methods and types', correct: true, why: 'Right (1.1).' },
          { text: 'The app that calls the API', why: 'That\'s the API consumer (1.1).' },
        ] },
        { question: 'Which part of API-led connectivity unlocks data from a system of record?', options: [
          { text: 'Experience APIs', why: 'They shape data for consumers (1.3).' },
          { text: 'Process APIs', why: 'They orchestrate System APIs (1.3).' },
          { text: 'System APIs', correct: true, why: 'Right (1.3).' },
        ] },
        { question: 'An API needs to return books written by a given author. How should the author be passed?', options: [
          { text: 'As a URI parameter: `/books/{author}`', why: 'URI parameters identify one resource. Filtering a collection is a query parameter (2.1).' },
          { text: 'As a query parameter: `/books?author=Herbert`', correct: true, why: 'Right (2.1).' },
          { text: 'In the request body of a GET', why: 'GET requests don\'t carry bodies in practice; filters go in the query (1.2).' },
        ] },
        { question: 'In RAML, how is a query parameter made optional?', options: [
          { text: '`optional: true`', why: 'There\'s no such facet in RAML 1.0.' },
          { text: 'A `?` after its name, or `required: false`', correct: true, why: 'Right (1.10).' },
          { text: 'They are optional unless `required: true`', why: 'It\'s the other way around: required unless marked (1.10).' },
        ] },
        { question: 'Which RAML declares an `Ebook` that has everything a `Book` has, plus `sizeMb`?', options: [
          { text: '`Ebook: { type: Book, properties: { sizeMb: number } }`', correct: true, why: 'Right: naming a type as `type` extends it (2.5).' },
          { text: '`Ebook: Book | { sizeMb: number }`', why: 'A union is one *or* the other, not both (2.5).' },
          { text: '`Ebook: { is: [Book] }`', why: '`is:` applies traits to methods, not types (2.8).' },
        ] },
        { question: 'In the spec on the right, which is a valid call to read book 42?', options: [
          { text: '`GET https://api.example.com/library/v1/books/42` with an OAuth 2.0 token', correct: true, why: 'Right: baseUri with v1, the path with 42, and the top-level securedBy (2.3, 2.9).' },
          { text: '`GET https://api.example.com/library/books/42?version=v1`', why: '`{version}` is part of the baseUri\'s path, not a query parameter (2.3).' },
          { text: '`GET https://api.example.com/library/v1/books?bookId=42`', why: '`bookId` is a URI parameter (2.1).' },
        ] },
        { question: 'What makes RAML examples "format independent"?', options: [
          { text: 'They are written in YAML and serve JSON and XML bodies of the same type alike', correct: true, why: 'Right (2.6).' },
          { text: 'They are never checked against their type', why: 'AMF checks every example against its type (1.9, 2.6).' },
        ] },
        { question: 'A resource type declares `get?`. What does that do to a resource of that type that has no `get:`?', options: [
          { text: 'Adds a GET to it', why: 'Without the `?` it would. With it, the method is only added where the resource declares it (2.7).' },
          { text: 'Nothing: optional methods only apply where the resource declares the method', correct: true, why: 'Right (2.7).' },
        ] },
        { question: 'Which APIkit flow handles `POST /books`, with router config `api-config`?', options: [
          { text: '`post:\\books:api-config`', correct: true, why: 'Right (4.1).' },
          { text: '`books-post-flow`', why: 'APIkit names flows by method, path and router config (4.1).' },
          { text: '`api-main`', why: 'The main flow routes requests to the method flows (4.1).' },
        ] },
        { question: 'A request to an APIkit app is missing a required header. What does the caller get?', options: [
          { text: '400 Bad Request', correct: true, why: 'Right: APIKIT:BAD_REQUEST (4.1).' },
          { text: '401 Unauthorized', why: '401 is about credentials, from a policy. A missing declared header is a bad request (4.1, 4.3).' },
          { text: '404 Not Found', why: 'The path exists (4.1).' },
        ] },
      ] } },
    { id: '6.2', title: 'Developer II: production APIs', minutes: 10, files: {},
      aside: { title: 'Before you start', body: [
        { p: 'These cover versioning, policies, SLA tiers, caching and the spec\'s part in each: lessons 2.9, 2.10, 3.4, 4.3 and 4.4.' },
        { p: 'The Developer II exam goes further into Mule itself (Maven, MUnit, error handling, reliability, security of data in transit and at rest). This course covers its API design and management side.' },
      ] },
      body: [
        { p: 'Eight questions on running APIs in production, like the API part of the Developer II exam.' },
        { callout: 'How to use it', text: 'A wrong pick shows why; pick again until all eight are right.' },
      ],
      check: { kind: 'quiz', questions: [
        { question: 'The Library API\'s asset is at 1.3.0 and its spec says `version: v1`. You remove `DELETE /books/{bookId}`. What do you publish?', options: [
          { text: 'Asset 1.4.0, `version: v1`', why: 'Removing a method breaks callers that use it (3.4).' },
          { text: 'Asset 2.0.0, `version: v2`', correct: true, why: 'Right: a breaking change means a new major, and the API version follows (3.4).' },
          { text: 'Asset 1.3.1, `version: v1`', why: 'Patch is for changes callers can\'t see (3.4).' },
        ] },
        { question: 'v2 of an API is live. What happens to v1?', options: [
          { text: 'It\'s deleted at once', why: 'v1 consumers would break. Both run while consumers move (3.4).' },
          { text: 'It keeps running on its own API instance, is deprecated in Exchange, and retired once consumers have moved', correct: true, why: 'Right (3.4).' },
        ] },
        { question: 'Where do the credentials checked by Client ID enforcement come from?', options: [
          { text: 'A client application\'s contract with the API instance, approved in Exchange and API Manager', correct: true, why: 'Right: the app requests access, and its client id and secret work once the contract is approved (4.3).' },
          { text: 'The Mule app\'s own properties', why: 'Those are the Mule app\'s platform credentials, for autodiscovery, not its consumers\' (4.3).' },
        ] },
        { question: 'How should the spec tell consumers about Client ID enforcement?', options: [
          { text: 'A trait (like `client-id-required`) declaring the `client_id` and `client_secret` headers, applied to the methods', correct: true, why: 'Right, and API Manager offers that snippet (2.10).' },
          { text: 'It shouldn\'t: policies are invisible to consumers', why: 'Consumers must send the credentials, so the spec should say so (2.10).' },
        ] },
        { question: 'Free apps get 10 calls a minute and Gold apps 1000. A Free app makes its 11th call in a minute. What does it get?', options: [
          { text: '429 Too Many Requests', correct: true, why: 'Right: the SLA-based rate limit is used up (4.3).' },
          { text: '401 Unauthorized', why: 'The app is known and allowed, just over its quota (4.3).' },
          { text: '503 Service Unavailable', why: '503 says the service is down, not that the caller is over quota (1.2, 4.3).' },
        ] },
        { question: 'Which policy answers repeated `GET /books/42` calls without reaching the implementation?', options: [
          { text: 'HTTP caching', correct: true, why: 'Right (4.4).' },
          { text: 'Spike control', why: 'Spike control delays and limits bursts; it doesn\'t answer for the API (4.3).' },
        ] },
        { question: 'An OAuth 2.0 security scheme is declared in the spec. What actually checks the tokens at runtime?', options: [
          { text: 'The security scheme in the spec', why: 'The scheme documents what callers send; it doesn\'t run (2.9).' },
          { text: 'A policy on the API instance, like OAuth 2.0 token introspection or JWT validation', correct: true, why: 'Right (2.9, 4.3).' },
        ] },
        { question: 'You publish a fix to a Development version of the spec, 1.4.0. Later you want to publish more fixes as 1.4.0. Is that possible?', options: [
          { text: 'Yes, Development versions can be published again', correct: true, why: 'Right. Once it\'s Stable, 1.4.0 is final (3.4).' },
          { text: 'No, every version is final', why: 'That\'s true of Stable versions only (3.4).' },
        ] },
      ] } },
  ] },
];
export const LESSONS = PARTS.flatMap((p) => p.lessons);
