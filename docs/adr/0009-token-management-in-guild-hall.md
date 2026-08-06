# ADR-0009 — Agent tokens are listed and revoked in Guild Hall

- **Status:** accepted
- **Date:** 2026-08-03

## Context

Spec 17.2 requires agent tokens to be revocable. Only the HTTP API offered it: `GET`/`POST` on
`/api/projects/:ref/tokens` and `POST /api/tokens/:id/revoke` existed from the start, but no
console screen used them, so revoking a token meant `curl` with a hand-extracted session cookie.

That mattered more than it looks. `expires_in_days` is optional and the service stores `null` when
it is omitted, so a token can never expire — for those, revocation is the only control there is.
Meanwhile the device flow mints a token on every `saga connect`, through the console, so tokens
accumulate during ordinary use while remaining invisible. Easy to create, impossible to review,
hard to revoke.

Spec 16.3 fixes the Project Detail tabs at six. The spec states prohibitions explicitly where it
means them (16.7 bans a command runner; 17.2 bans cross-project tokens) and none covers a token
screen, and `DevicePage` is already a security screen absent from section 16 — so the tab list
reads as an inventory of what must exist, not a cap on what may.

## Decision

Guild Hall gains a project-scoped **Tokens** tab at `projects/:projectRef/tokens`, offering
listing and revocation. Spec 16.3's tab inventory is extended from six to seven. The tab is hidden
from callers without `security:manage`; the page refuses on its own regardless, so hiding it is
courtesy rather than the access control.

Token **creation is deliberately excluded**. Minting a token in the browser would make Guild Hall
the first place in Saga to render a secret on screen — today `raw_token` is returned only to the
CLI, over the device flow, and lands in the operating-system keychain. Adding a create form would
be a new decision, not an extension of this one.

## Consequences

- An administrator can audit and revoke without a terminal, which is what 17.2 asks for in
  practice rather than only in the API.
- The list is safe to render: `token_prefix` is derived from the token's hash, not the token, and
  `TOKEN_COLUMNS` never selects `token_hash`.
- Guild Hall still never displays a secret.
- **Known limitation.** Device-flow tokens default to one shared name per project
  (`` `${project.name} agent` ``) and a constant `client` of `saga-cli`, so rows are told apart by
  prefix, creation time and last use. The `workspace_label` that would identify them is collected
  at `saga connect`, shown on the approval screen, and then dropped — `approveDeviceFlow` copies
  only `client` onto the token. Prefilling the token name from the pending request's workspace
  label, or carrying that label onto the token row, would fix it; neither is done here.
- Nothing deletes an agent token, so revoked rows accumulate. The page hides them behind a
  "Show revoked" checkbox rather than growing a retention job.
