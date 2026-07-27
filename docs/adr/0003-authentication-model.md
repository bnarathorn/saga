# ADR-0003 — Two separate authentication models

- **Status:** accepted
- **Date:** 2026-07-27

## Context

Guild Hall is used by humans in a browser. Agents and CI are non-interactive processes that must
be scoped to a single project. Sharing one credential type between them would either give agents
browser-wide privileges or force humans through a token flow.

## Decision

Two independent authenticators, both resolved by one Fastify `preHandler` into a single
`request.actor` discriminated union.

**Web sessions** — opaque 32-byte random session IDs stored hashed in `security.web_sessions`,
delivered in an `HttpOnly`, `SameSite=Lax`, `Secure`-when-configured cookie named `saga_session`.
No JWTs: revocation must be immediate and server-side. The session ID is rotated on login.
State-changing requests additionally require a `X-Saga-CSRF` header matching the non-`HttpOnly`
`saga_csrf` cookie (double-submit), because `SameSite=Lax` alone does not cover all cases.

**Agent tokens** — `saga_<projectShort>_<40 base32url chars>` presented as
`Authorization: Bearer`. Only a SHA-256 hash is stored. Each token is bound to exactly one
project and an explicit scope list. The raw value is returned exactly once, at creation.

Passwords use Argon2id (`@node-rs/argon2`, `m=19456 KiB, t=2, p=1` — the OWASP second-choice
profile, chosen because Saga's reference deployment target is a small self-hosted machine).

## Consequences

- A leaked agent token cannot read another project, satisfying acceptance criterion 23.
- Web session revocation is a single `UPDATE`.
- Every browser mutation needs the CSRF header; the Guild Hall API client adds it centrally.
