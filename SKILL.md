---
name: agent-native-mcp-architecture
description: This skill captures the architecture decisions behind well-built agent-native MCP servers so future MCP servers can reuse the same shape. It is not a code guide. It is a design guide for making an MCP pleasant for agents and useful for humans.
---

# Agent-Native MCP Architecture Notes

This note captures the architecture decisions behind the agent-native MCP servers so future MCP servers can reuse the same shape. It is not a code guide. It is a design guide for making an MCP pleasant for agents and useful for humans.

## Goal

Build MCP servers as agent-native interface surfaces, not thin document dumps.

An agent should be able to discover what the server knows, choose the right tool, make a compact first call, fetch the exact source it needs, and explain the result with provenance. The server should reduce reasoning overhead by exposing the domain model, the workflow, and the next action at each step.

## Core Principles

The server should make the correct path obvious.

Good agent ergonomics come from a small number of clear tools, stable response shapes, compact search results, and explicit next steps. The agent should not need to infer hidden sequencing from failures.

The server should separate discovery, retrieval, and source context.

Discovery tells the agent what exists and how to use it. Search finds compact candidates. Fetch returns full source-backed artifacts. Combining these into one large response wastes context and makes agents less reliable.

The server should treat provenance as a first-class feature.

Every answerable unit should trace back to a document, page, section, block, or stable artifact ID. The server should make citation easy enough that agents naturally cite the source instead of relying on memory.

The server should preserve faithful source text separately from derived knowledge.

For document corpora, keep a page-level faithful transcription. Then build summaries, procedures, commands, config references, troubleshooting records, and search chunks as derived artifacts. Do not force later passes to re-output the faithful transcription.

## Interface Shape

Expose a small tool set.

The TAKDOCS shape worked well with four tools:

- `get_manifest`: orientation, corpus contract, available filters, kinds, examples, and workflow playbooks.
- `list_documents`: source document IDs, titles, page counts, and status.
- `search_docs`: compact candidate retrieval with typed filters.
- `fetch_artifact`: full source context by stable ID.

This pattern generalizes. Most knowledge MCPs need discovery, list, search, and fetch. Add more tools only when a domain action cannot be cleanly expressed through those primitives.

Make search compact by default.

Search results should include enough to choose the next action: ID, kind, title, summary, document/page facets, section path, source refs, artifact ref, and a next-action hint. Search should not return full page text unless the user explicitly asked for exact text.

Make fetch authoritative.

Agents should fetch before giving operational instructions. Fetch should return the selected artifact in a predictable format, including provenance. The artifact can be a section, page transcription, retrieval record, source document, or other domain object.

## Manifest Design

The manifest is the server's agent onboarding document.

A useful manifest should include:

- corpus version and freshness metadata
- document IDs and source titles
- retrieval kind taxonomy
- recommended search mode per kind
- available filter fields and examples
- common entities, such as ports, files, commands, packages, and config names
- full JSON example calls
- workflow playbooks for common user goals
- tool list with when-to-use guidance
- response expectations and citation rules

The manifest should encode agent choreography.

For recurring tasks, write playbooks directly into the manifest. For example: install a single-node server, configure federation, troubleshoot client connection, or inspect firewall ports. Each playbook should tell the agent what kind filters to use, which search mode to prefer, and when to fetch.

This turns the MCP from a set of primitives into a runbook.

## Retrieval Model

Use typed retrieval records.

Undifferentiated chunks make agents guess. Typed chunks let agents ask for the right material:

- `procedure` for task-oriented setup and validation
- `command` for shell commands
- `config_reference` for files, XML keys, package names, service names, and paths
- `port_reference` for ports, protocols, firewall rules, and endpoints
- `troubleshooting` for symptoms, causes, checks, and validation guidance
- `section_markdown` for full section context
- `page_verbatim` for faithful source evidence

The kind taxonomy should match the questions users ask. It should not mirror implementation details.

Use hybrid search, but expose the modes.

Hybrid search should be the default for setup, configuration, and troubleshooting. Lexical search should be available for exact strings such as ports, file names, config keys, and commands. Dense search should be available for vague user intent when the user does not know the domain vocabulary.

Do not make the agent tune internals unless needed.

Parameters like candidate limits are useful for debugging, but they should not be part of normal agent reasoning. If exposed, document them as optional and rarely needed.

## Artifact Design

Use stable, readable IDs.

IDs should be deterministic, hierarchical, and versioned. They should be useful in logs, citations, caches, and follow-up turns.

Good IDs communicate what they point to:

- source document
- page number or section path
- artifact kind
- version

Keep artifacts composable.

The ingestion pipeline should produce parts that can be assembled:

- source document metadata
- page source metadata
- page faithful transcription
- page extraction
- section assembly
- retrieval records
- lexical model
- manifest

Each artifact should be independently inspectable. Later passes should depend on artifact IDs and source refs, not on re-emitting earlier work.

## Ingestion Pipeline

Use separate passes with narrow intent.

The ingestion method applies to any source material. The unit changes, not the architecture.

Choose the smallest stable source unit:

- PDF: page
- HTML or docs site: page, heading section, or DOM block
- Markdown: file section
- Git repo: file, symbol, function, config file, or README section
- Video or audio: transcript segment with timestamp
- Chat, email, or ticket systems: message, thread, issue, or comment segment
- API docs or OpenAPI: endpoint, operation, schema, auth section, or example
- Spreadsheet or CSV: sheet, table, row group, or column group

Then run staged AI passes over those units:

1. Faithful pass: direct transcription, normalization, or extraction of the source unit with no summary or interpretation.
2. Structure pass: headings, sections, entities, code blocks, commands, configs, warnings, examples, relationships, and anchors.
3. Task extraction pass: procedures, troubleshooting records, setup steps, validation checks, prerequisites, and operational cautions.
4. Retrieval pass: typed retrieval records optimized for agent search.
5. Assembly pass: larger sections and workflows built from source-backed units.

Do not ask an AI model to understand the whole corpus in one pass. Ask it to perform one narrow operation on one stable source unit, write a schema-shaped artifact, validate that artifact, and assemble the validated artifacts deterministically.

For PDFs, the concrete pipeline is:

1. Register source PDFs and compute stable source metadata.
2. Split pages and create per-page source artifacts.
3. Run a faithful transcription pass per page.
4. Run derived extraction passes for structure, commands, config, ports, warnings, entities, and troubleshooting signals.
5. Assemble pages into sections.
6. Build typed retrieval records from sections and page artifacts.
7. Build lexical indexes and dense embeddings.
8. Validate manifest and artifact schemas.
9. Load retrieval records into the vector store.

This keeps the faithful source separate from derived interpretation. It also keeps retries cheap. If extraction quality improves, regenerate derived artifacts without redoing faithful transcription.

Use structured outputs for AI passes.

Structured outputs make the pipeline auditable. Each AI pass should write a schema-conforming artifact. Invalid output should fail the pass rather than silently becoming weak retrieval data.

Keep source-derived and generated fields distinct.

A faithful transcription should contain direct source text. A summary, warning, procedure, or entity list is generated interpretation. Both are useful, but they must not be confused.

## Backend Architecture

Keep the surface layer thin.

The MCP handler should validate input, call the domain service, and format the response. It should not contain retrieval policy, artifact loading logic, ranking behavior, or business rules.

Keep reusable domain and infrastructure modules.

The domain layer should know about retrieval concepts: filters, search requests, artifact refs, source refs, and response shapes. The infrastructure layer should know about Qdrant, Voyage, filesystem artifacts, and lexical ranking. This allows the same domain logic to support MCP, HTTP, CLI, cron jobs, or tests.

Use strict internals and forgiving boundaries.

At the boundary, accept user-friendly inputs where reasonable. Inside the domain, normalize to strict values. This keeps the interface ergonomic without making the core unpredictable.

Return structured errors with useful recovery hints.

Agents recover well from errors when the response says what failed and what to do next. For example: invalid kind, unknown document ID, artifact not found, missing vector store, or missing embedding key.

## State And Deployment

Prefer stateless and idempotent server behavior.

A stateless MCP server is easier to deploy, scale, retry, and host on Railway. It can serve multiple clients without requiring sticky sessions or in-memory continuity. If MCP transport sessions are required, keep them protocol-level and externalize durable application state.

Externalize persistent state.

Use Qdrant for retrieval state, environment variables for secrets and connection settings, and the build artifact for static knowledge. Do not rely on local mutable files in the running container unless the deployment explicitly mounts persistent storage.

Make deployment boring.

The runtime image should contain only what the server needs to run: compiled server code, runtime knowledge artifacts, package metadata, and production dependencies. Build-time docs, debug files, prompts, schemas used only during generation, and local source PDFs should stay out of the image unless they are required at runtime.

Use Railway's `PORT`.

On Railway, bind to `0.0.0.0` and use the provided `PORT`. Avoid custom port assumptions in the service configuration.

## Public Release Hygiene

Separate private source material from public runtime artifacts.

A public repo can include the runtime corpus if that is intentional, but it should not include private working docs, local PDFs, API keys, personal deployment IDs, debug notes, or old history that contained those files.

For a clean public release, create a fresh repo from a clean working tree.

Deleting files from a repo does not remove them from Git history. If old commits contained private material, publish a fresh repository created from a clean snapshot, or rewrite history before making the repo public.

Keep hosted endpoints intentional.

If a skill or manifest includes a hosted MCP URL, treat it as public documentation. Include it only when the endpoint is meant for public use.

## Skill Design

Create a skill when the server needs agent-side choreography.

The skill should tell an agent when to use the MCP, which tool flow to follow, what to fetch before answering, and what not to invent. Keep it concise. The skill complements the manifest; it should not duplicate the entire manifest.

Use a descriptive skill name.

Names like `tak-server-guide` communicate the task better than project-internal names. The MCP tools can retain stable internal names such as `takdocs_search_docs`, but the skill should speak to the user's goal.

Put the MCP endpoint near the top.

Agents and users should see the connection target before the workflow details.

## Checklist For Future MCP Servers

- Define the user's real tasks before defining tools.
- Keep the MCP tool set small.
- Add a manifest that teaches the agent how to use the server.
- Use search for compact candidate selection.
- Use fetch for full source-backed context.
- Add typed retrieval kinds that match user intent.
- Preserve provenance at artifact, page, section, and block level.
- Use stable, readable, versioned IDs.
- Separate faithful source artifacts from derived artifacts.
- Use structured outputs for AI-generated ingestion passes.
- Keep the MCP handler thin.
- Put retrieval policy in domain services.
- Put vector stores, embeddings, and filesystems in infrastructure modules.
- Prefer stateless/idempotent request handling.
- Externalize persistent state.
- Validate builds, manifest schemas, and skill discovery before release.
- Publish from a clean tree when history contains private material.

## The Pattern In One Sentence

An agent-native MCP server is a small, discoverable interface over well-typed domain artifacts, with compact search, authoritative fetch, explicit provenance, and workflows encoded where agents can find them.

The server design referenced in this skill is located at `https://github.com/frontboat/TAKDOCS-public` for those looking for more guidance.
