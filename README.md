# uplyo-mcp

An [MCP](https://modelcontextprotocol.io) server for **evidence-based website audits**.
It gives any MCP client (Claude Code, Claude Desktop, Cursor, ...) tools to check a
site's technical SEO and conversion basics, measure real Core Web Vitals, and look up a
company in the official French registry.

Every audit separates what was **observed** (direct evidence, safe to quote to a client)
from what is **to verify** (a hypothesis, phrased as a question, never as a fact). No tool
estimates rankings or traffic, and none writes to a site: the server is read-only.

> Tool descriptions and tool output are in **French**. The structured output
> (`structuredContent`) is machine-readable JSON, so a client can translate or reformat it.

## Tools

| Tool | What it does |
|---|---|
| `uplyo_audit_page` | Audits a few pages of a site: title, meta description, H1s, canonical, JSON-LD, image alt text, mixed content, CMS fingerprints, forms, robots.txt, sitemap. Returns observed findings and a to-verify list. |
| `uplyo_crawl_site` | Crawls every page of the sitemap (sitemap indexes are resolved). Long operation: returns a `job_id`. |
| `uplyo_pagespeed` | Real Core Web Vitals through the PageSpeed Insights API (needs your free API key). |
| `uplyo_company_lookup` | Looks a company up in the official French registry (`recherche-entreprises.api.gouv.fr`, open INSEE/SIRENE data, no key needed). |
| `uplyo_job_status`, `uplyo_job_result`, `uplyo_list_jobs`, `uplyo_cancel_job` | Follow a long operation, fetch the files it produced into the conversation, list or cancel jobs. |

## Safety built in

- **Politeness floor that cannot be bypassed:** at least 1 second between requests. Before
  any crawl, one `HEAD` request looks for a CDN in the headers. If the origin is bare
  (Apache or nginx with nothing in front), the delay is **raised automatically**. Crawling
  a small origin server with no pause can take it offline.
- **Browser-built pages:** Elementor and Divi render forms with JavaScript, so zero `<form>`
  tags proves nothing. When a page builder is detected, that finding is downgraded to
  "to verify".
- **Long operations never block the client:** they return a `job_id` to poll.
- The PageSpeed key is read from `.env`, never returned in a tool result and never logged.

Only audit sites you own or have permission to audit.

## Install

Requires Node.js 20 or newer, `bash`, `curl`, `perl`, and `jq`.

```bash
git clone https://github.com/isma2034/uplyo-mcp.git
cd uplyo-mcp
npm install
npm run build
```

Optional, for `uplyo_pagespeed`: copy `.env.example` to `.env` and add a free
[PageSpeed Insights API key](https://console.cloud.google.com/apis/credentials).

### Claude Code

```bash
claude mcp add uplyo --scope user -- node /absolute/path/to/uplyo-mcp/dist/index.js
```

### Claude Desktop, Cursor and other clients

```json
{
  "mcpServers": {
    "uplyo": {
      "command": "node",
      "args": ["/absolute/path/to/uplyo-mcp/dist/index.js"]
    }
  }
}
```

Try it without any client: `npm run inspect` opens the MCP Inspector.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `UPLYO_SKILL_DIR` | the repository root | Folder that contains `scripts/` and `.env`. |
| `UPLYO_OUTPUT_DIR` | `~/Uplyo-MCP` | Where audit files (JSON and summaries) are written. |

## How it works

The server does not reimplement the audit. It wraps
[`scripts/technical_audit.sh`](scripts/technical_audit.sh), the same engine as the
[web-optimization](https://github.com/isma2034/web-optimization-skill) skill, and adds
validated inputs, actionable errors, the politeness floor, and job handling. The raw files
the script produces are returned **inside the conversation**, so the tools also work from a
client that has no access to your disk.

## Tests

```bash
npm test
```

Starts the server over stdio, checks the tool inventory, schemas and error messages, then
runs one real audit of `example.com`. It needs network access.

## License

MIT, see [`LICENSE`](LICENSE).
