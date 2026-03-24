# spec-sniffer

[![Built with Claude Code](https://img.shields.io/badge/Built%20with-Claude%20Code-blue?logo=anthropic&logoColor=white)](https://claude.ai/code)


Reverse-engineers API documentation by crawling a web app with a headless browser. Point it at any web application and get a complete OpenAPI 3.0 specification of the API endpoints it discovers.

## How It Works

1. **Crawl** - Launches headless Chromium, visits pages, clicks links/buttons, fills forms with dummy data
2. **Intercept** - Captures all XHR/fetch network requests: method, URL, headers, request/response bodies
3. **Analyze** - Deduplicates endpoints, infers path parameters, builds JSON schemas from observed payloads
4. **Generate** - Produces OpenAPI 3.0 YAML/JSON spec with discovered endpoints, schemas, and parameters
5. **Enrich** (optional) - Sends endpoint data to an LLM for human-readable descriptions

## Installation

```bash
npm install -g spec-sniffer
# Playwright will auto-install Chromium on first run
```

## Usage

```bash
# Basic: crawl and generate YAML spec
spec-sniffer http://localhost:3000 -o api-docs.yaml

# Output as JSON
spec-sniffer http://localhost:3000 -f json -o api-docs.json

# With AI-generated descriptions
export OPENAI_API_KEY=sk-xxx
spec-sniffer http://localhost:3000 --enrich

# Show browser during crawl (debug mode)
spec-sniffer http://localhost:3000 --no-headless -v

# Limit crawl depth and pages
spec-sniffer http://localhost:3000 --max-pages 20 --max-depth 2

# Skip form filling (read-only crawl)
spec-sniffer http://localhost:3000 --no-forms --no-buttons
```

## Features

- **Smart Path Params**: Detects UUIDs, numeric IDs, and MongoDB IDs in paths and converts to `{paramName}`
- **Schema Inference**: Builds JSON schemas from request/response bodies, merges across multiple samples
- **Query Param Tracking**: Records query parameter names, types, and whether they're required
- **Form Filling**: Fills forms with realistic dummy data (email, passwords, names, etc.)
- **Button Clicking**: Triggers JavaScript actions to discover AJAX endpoints
- **De-duplication**: Groups identical endpoint patterns even with different path parameter values
- **Credential Redaction**: Automatically redacts Authorization and Cookie headers

## Output

The generated OpenAPI spec includes:

- Server URL and metadata
- All discovered paths with HTTP methods
- Path parameters with types
- Query parameters with required/optional status
- Request body schemas (for POST/PUT/PATCH)
- Response schemas per status code
- Tag grouping by first path segment

## Limitations

- Only captures client-side API calls (XHR/fetch) - server-rendered content is not detected
- Cannot discover endpoints that require authentication (unless you provide session cookies)
- Form filling uses dummy data which may not pass complex validation
- Path parameter detection is heuristic-based (UUIDs, numeric IDs)

## License

MIT
