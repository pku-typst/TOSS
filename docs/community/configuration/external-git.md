---
title: "External Git configuration"
summary: "Provider registry schema, OAuth callbacks, secrets, scopes, and validation for GitHub, GitLab, Gitea, and Forgejo."
status: current
type: reference
scope: community
audience:
  - operator
  - backend-contributor
  - coding-agent
topics:
  - external-git
  - oauth
  - github
  - gitlab
  - forgejo
  - gitea
related:
  - docs/community/configuration/README.md
  - docs/community/architecture/external-repositories.md
  - docs/community/architecture/identity-and-access.md
  - docs/community/operations/deployment.md
code_paths:
  - backend/src/external_repositories/config.rs
  - backend/src/external_repositories/provider
  - docs/community/configuration/deployment.example.toml
---

# External Git configuration

External repositories are optional. Their provider registry is the
`external_git` section of the strict schema-1 file selected by
`TOSS_DEPLOYMENT_CONFIG`. An empty section disables the feature without
affecting normal Workspace editing.

Start from [deployment.example.toml](./deployment.example.toml).

## Registry fields

```toml
schema = 1

[external_git]

[[external_git.providers]]
id = "engineering-gitlab"
kind = "gitlab"
brand = "gitlab"
display_name = "Engineering GitLab"
base_url = "https://gitlab.example.com"
api_url = "https://gitlab.example.com/api/v4"
client_id = "public-oauth-client-id"
redirect_uri = "https://typst.example.com/v1/external-git/providers/engineering-gitlab/callback"
login_enabled = true
```

| Field | Rule |
| --- | --- |
| `id` | Stable lowercase ID, at most 64 characters, using letters, digits, and internal hyphens |
| `kind` | `github`, `gitlab`, `gitea`, or `forgejo` |
| `brand` | Compatible explicit visual brand: GitHub/GitLab/Gitea match their kind; Forgejo accepts `forgejo` or `codeberg` |
| `display_name` | User-visible 1–100 character label; not used for dispatch |
| `base_url` | Absolute service origin; HTTPS except loopback development |
| `api_url` | Optional explicit API root; GitLab and Forge instances must share the base origin |
| `app_slug` | Required only for GitHub |
| `client_id` | Public OAuth/GitHub App client ID |
| `redirect_uri` | Absolute callback registered with the provider |
| `login_enabled` | Expose this instance on the platform sign-in page in addition to authenticated repository connection |

IDs are persisted. Never reuse an ID for a different service after grants,
links, or jobs exist. Multiple instances may share the same kind.

## Secrets

The deployment TOML contains no secret fields.

- `EXTERNAL_GIT_TOKEN_ENCRYPTION_KEY` must be standard-base64 encoding of
  exactly 32 random bytes. One deployment key encrypts all stored grants.
- A provider's client secret is
  `EXTERNAL_GIT_<INSTANCE_ID>_CLIENT_SECRET`, with the ID uppercased and hyphens
  replaced by underscores. `engineering-gitlab` therefore reads
  `EXTERNAL_GIT_ENGINEERING_GITLAB_CLIENT_SECRET`.

Back up and rotate the encryption key deliberately. Losing it makes existing
grants unreadable; replacing it without re-encryption requires users to
reauthorize.

## One callback per instance

Register exactly:

```text
<application-origin>/v1/external-git/providers/<instance-id>/callback
```

The callback completes either platform login or repository connection based on
the one-time server attempt. It is not necessary to register separate login
and connection callbacks.

Generic OIDC remains separate and uses `/v1/auth/oidc/callback`. The historical
`/v1/auth/gitlab/callback` route is an alias for that generic OIDC client, not a
repository-provider callback.

## Provider requirements

### GitHub App

- Enable user authorization.
- Request repository Contents read/write, Metadata read, and Email addresses
  read.
- Configure the App slug and the user-authorization callback above.
- Repository installation remains a separate GitHub operation that determines
  the repositories visible to the user token.
- Repository creation is not exposed by this adapter; users import or link an
  installed existing repository.

GitHub.com defaults to `https://api.github.com`. GitHub Enterprise Server
defaults to `<base_url>/api/v3` and should use a distinct provider instance.

### GitLab

Enable the `api` and `write_repository` scopes on the OAuth application. The
adapter uses `api` for identity and repository operations, and
`write_repository` for Git-over-HTTPS pull and push. It does not request the
redundant OpenID Connect scopes because identity is read from GitLab's REST API.
The default API root is `<base_url>/api/v4`. Each GitLab installation is a
separate instance.

### Gitea and Forgejo

For Gitea 1.23+ and Forgejo, request `openid`, `profile`, `email`, `write:user`,
`write:repository`, and `write:organization`. `write:user` is required by the
`POST /user/repos` personal-repository creation route and includes read access;
`write:organization` covers organization repository creation. The default API
root is `<base_url>/api/v1`.

Forgejo binds scopes to the provider-side grant created at first consent. A
confidential client may reuse that grant without expanding it when a later
authorization request asks for additional scopes. After required scopes change,
the user must revoke the application's authorization in Forgejo and connect it
again; signing out of this application does not revoke the Forgejo grant.

Codeberg is configured as `kind = "forgejo"`, `brand = "codeberg"`, and its own
provider instance. Self-hosted Forgejo normally uses `brand = "forgejo"`.

## Startup validation

Startup rejects unknown fields/schema versions, duplicate IDs, missing public
values or secrets, incompatible kind/brand pairs, unsafe URLs, cross-origin
GitLab/Forge API roots, invalid GitHub slugs, and malformed encryption keys.
The browser receives only sanitized provider metadata and capabilities.

## Related

- [External repository architecture](../architecture/external-repositories.md)
- [Identity and access](../architecture/identity-and-access.md)
- [Deployment](../operations/deployment.md)
- [Configuration index](./README.md)
