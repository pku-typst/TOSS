---
title: "External repositories"
summary: "Provider-neutral account, linking, import, inbound sync, and manual checkpoint architecture."
status: current
type: architecture
scope: community
audience:
  - backend-contributor
  - frontend-contributor
  - operator
  - coding-agent
topics:
  - external-git
  - oauth
  - import
  - checkpoint
related:
  - docs/community/configuration/external-git.md
  - docs/community/architecture/versioning.md
  - docs/community/architecture/identity-and-access.md
  - docs/community/product/overview.md
code_paths:
  - backend/src/external_repositories
  - web/src/pages/workspace/external-git
  - docs/community/configuration/deployment.example.toml
---

# External repositories

External repository integration is provider-neutral above the adapter layer.
GitHub, GitLab, Gitea, and Forgejo/Codeberg share linking, inbound, checkpoint,
retry, and persistence workflows without pretending their REST APIs or OAuth
semantics are identical.

## Provider model

| Value | Purpose |
| --- | --- |
| `ProviderInstanceId` | Deployment-stable identifier persisted by grants, attempts, jobs, and links, such as `github` or `engineering-gitlab` |
| `ProviderKind` | Protocol adapter: `github`, `gitlab`, `gitea`, or `forgejo` |
| `ProviderBrand` | Explicit login/repository visual identity; never used for adapter dispatch |

Codeberg is a configured Forgejo instance with `kind = "forgejo"` and
`brand = "codeberg"`. Gitea and Forgejo use explicit dialects of the shared
Forge API family. No adapter or UI infers kind or brand from a hostname,
instance ID, display name, or URL.

Provider-specific DTOs, pagination, permission translation, refresh behavior,
and URL rules stay below `backend/src/external_repositories/provider/`.

## User binding invariant

One stable platform account may hold one external repository grant per provider
instance:

```text
platform user
  -> GitHub instance + GitHub account + encrypted grant
  -> GitLab instance + GitLab account + encrypted grant
  -> Forge instance + Forge account + encrypted grant
```

The provider instance and account ID are immutable within one binding.
Reauthorization may rotate tokens and update username, expiry, scopes, or
status only when both identities still match. Connecting another instance is
independent; replacing the account for an already-bound instance is rejected.
Repository discovery, import, creation, and linking name the provider instance
explicitly.

Disconnecting a provider removes its grant and matching external login
identity. It is rejected while projects still use the grant or when that
identity is the account's final login method. Unlinking one project removes
only that project link.

Organizations and groups are repository scopes, not additional user bindings.
A connected account may access organization repositories according to the
provider's own authorization model.

## Login and connection intents

Platform login and repository connection are two intents of one provider OAuth
attempt lifecycle. Each provider instance registers one callback. The one-time
attempt records the provider and intent, preventing the callback from guessing
state from a URL. Each attempt also receives an independent HTTP-only browser
cookie, so starting authorization in another tab or for another provider does
not overwrite an in-flight callback binding.

- External-provider login creates a federated platform identity and the grant
  for the exact same provider account.
- An authenticated user may connect one account from each provider instance.
- GitHub login account A connecting GitHub account B is unsupported and
  rejected.
- Email equality never merges identities.
- A signed-out email collision returns the user to sign-in; after an existing
  login method verifies the platform account, the user explicitly authorizes
  the additional provider.

GitHub installation is separate from user authorization: installation controls
which repositories the user token can access.

## Project link

A project link stores provider instance, provider repository ID, managed branch,
and the connector platform user. Background work always resolves the provider
instance from the registry and uses that connector's grant. Other project
collaborators need platform permission but no provider account or repository
write permission.

Only the project owner can create, link, unlink, checkpoint, or request inbound
replacement.

## Inbound import and sync

Import creates a new project; sync replaces an existing linked Workspace.
Both create durable jobs.

1. Resolve the link/grant and provider-neutral repository and branch.
2. Fetch Git and LFS into an isolated checkout with bounded command time.
3. Validate paths, symlinks, entry file, file counts, per-file bytes, and total
   bytes.
4. Stage asset objects before changing live Workspace state.
5. Flush the previous Workspace to local Git when replacing an existing
   project.
6. Atomically replace Workspace content, the entry-file setting, content
   generation, and job apply metadata.
7. Finalize the imported local revision. A failure after apply retries only
   this revision phase and never applies the destructive snapshot twice.

Active Collaboration sessions are invalidated after commit and reload against
the new generation.

## Outbound checkpoint

An owner explicitly requests a checkpoint. The durable worker captures a
target Workspace version, asks Versioning for the corresponding local commit,
and pushes the distribution-managed branch without force. Edits made after the
captured version remain dirty and require another user request.

Inbound and outbound operations are mutually exclusive per project. Transient
provider, Git, and LFS failures use bounded retry. Authorization failures pause
for reauthorization, and remote divergence becomes a visible conflict.
Provider downtime never blocks ordinary Workspace editing.

Token refresh network I/O occurs outside database transactions. Rotated grant
material is stored with compare-and-swap so a stale concurrent refresh cannot
overwrite a newer token.

## Related

- [External Git configuration](../configuration/external-git.md)
- [Identity and access](./identity-and-access.md)
- [Versioning](./versioning.md)
- [API guide](../reference/api.md)
- [Decision: explicit provider bindings](../decisions/0005-explicit-provider-bindings.md)
