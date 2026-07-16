---
title: "ADR-0005: Explicit provider bindings"
summary: "Allow one platform account to bind one account from each configured provider instance without merging accounts by email."
status: accepted
type: decision
scope: community
audience:
  - contributor
  - operator
  - coding-agent
topics:
  - identity
  - external-git
  - oauth
related:
  - docs/community/architecture/external-repositories.md
  - docs/community/architecture/identity-and-access.md
  - docs/community/configuration/external-git.md
code_paths:
  - backend/src/access/federated_account.rs
  - backend/src/external_repositories/connection
  - backend/migrations
---

# ADR-0005: Explicit provider bindings

## Decision

A platform account has one stable internal user ID and may bind one external
account from each configured provider instance. Each binding is explicit and
is keyed by the provider instance and its stable subject; matching email is
never sufficient to create a binding.

An external provider with login enabled contributes a login method. A provider
configured only for repository access contributes a repository grant but not a
login method. The first provider used to create an account is not permanently
primary.

## Consequences

- the same platform account may use GitHub, GitLab, Codeberg, and Gitea;
- one provider account cannot be bound to two platform accounts;
- one platform account cannot silently replace its account for one provider
  instance;
- a signed-out email collision requires authentication through an existing
  method before the additional provider can be connected;
- disconnecting a provider removes its grant and, when present, its login
  identity;
- the last usable login method cannot be disconnected;
- providers still used by linked projects cannot be disconnected;
- repository operations name their provider instance explicitly instead of
  selecting an arbitrary grant for the user.

## Related

- [External repositories](../architecture/external-repositories.md)
- [Identity and access](../architecture/identity-and-access.md)
- [External Git configuration](../configuration/external-git.md)
