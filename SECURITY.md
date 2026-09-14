# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the repository owner, Ahmed Bahathiq. Do not include active credentials, private user data, or a destructive proof of concept in a public issue.

Useful reports identify the affected version, entry point, trust boundary, realistic impact, and a minimal non-destructive reproduction. Areas of particular interest include:

- bypasses of the read-only public API or signed administrative boundary;
- exposure of OpenAI keys, HMAC secrets, private diagnostics, model inputs, or `WorldTruth` to an agent;
- prompt injection that changes system instructions or grants a simulated character a real capability;
- dynamic execution, query, URL, or function dispatch derived from model text;
- replay-nonce, signature, rate-limit, WebSocket, Durable Object, D1, or R2 isolation failures;
- archive loss, checksum bypass, or silent mutation of versioned historical events.

## Security invariants

The model boundary intentionally has no shell, filesystem, SQL, HTTP, web search, MCP, code interpreter, function calling, or secrets capability. Do not add model tools. Never place environment bindings, raw database rows, hidden material properties, unperceived memories, or backend errors in `AgentDecisionInput`.

All world-authored text is untrusted data. It must remain outside system instructions and cannot select code, SQL, tables, functions, modules, or URLs. Database operations use fixed parameterized statements. Outbound model traffic is confined to the model provider's fixed OpenAI endpoints.

Moderation is a publication boundary, not a behavior resolver. Security fixes that affect world outcomes require a documented season migration unless they only prevent secret disclosure or redact presentation.

## Supported version

Security updates target the current `main` branch and the currently deployed V2 engine. Historical event readers remain backward compatible so fixes do not make archived seasons unreadable.
