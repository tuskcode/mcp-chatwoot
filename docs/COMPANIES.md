# Companies

Eight company tools belong to **Core**, are always registered in HTTP and STDIO,
and accept optional `account_id`. They do not require `MCP_ENABLE_ENTERPRISE`.
The Chatwoot account must enable its own `companies` feature; this is independent
of MCP bucket flags.

## Verified compatibility

The repository does not pin or identify the installed Chatwoot server version:
its Dockerfile builds the MCP server and its Compose file contains only that
service. No production instance was queried or changed.

Reference checked on **2026-10-28**: official Chatwoot **v4.19.1**, commit
[`caab07a8f00032d5205b5a5d7e2eb0ba2f3d2d82`](https://github.com/chatwoot/chatwoot/commit/caab07a8f00032d5205b5a5d7e2eb0ba2f3d2d82).
This is a tagged release, not `develop` and not a claim about the deployed version.
Older releases, custom forks, edition-specific policies and disabled account
features may differ. Compatibility requires the routes and payloads below;
there is no speculative fallback to legacy company names or contact filters.

Verified official sources at that tag:

- [Routes](https://github.com/chatwoot/chatwoot/blob/v4.19.1/config/routes.rb): account-scoped company CRUD, search and nested contacts routes.
- [Companies controller](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/controllers/api/v1/accounts/companies_controller.rb): feature gate, permitted parameters, sorting, pagination and update behavior.
- [Company model](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/models/company.rb): name/domain validation and name/domain substring search.
- [Nested contacts controller](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/controllers/api/v1/accounts/companies/contacts_controller.rb) and [base controller](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/controllers/api/v1/accounts/companies/base_controller.rb): native association listing and feature gate.
- [Contacts controller](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/controllers/api/v1/accounts/contacts_controller.rb): top-level `company_id`, account-scoped lookup and explicit null handling.
- [Company serializer](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/views/api/v1/models/_company.json.jbuilder), [company list](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/views/api/v1/accounts/companies/index.json.jbuilder) and [company contact list](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/views/api/v1/accounts/companies/contacts/index.json.jbuilder): response envelopes and pagination metadata.
- [Company policy](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/policies/company_policy.rb) and [delete job](https://github.com/chatwoot/chatwoot/blob/v4.19.1/app/jobs/companies/delete_job.rb): administrator deletion, asynchronous removal and contact unlinking.
- [Company request/controller specs](https://github.com/chatwoot/chatwoot/blob/v4.19.1/spec/controllers/api/v1/accounts/companies_controller_spec.rb) and [nested contacts specs](https://github.com/chatwoot/chatwoot/blob/v4.19.1/spec/controllers/api/v1/accounts/companies/contacts_controller_spec.rb): API contract cross-checks, including descending sort and custom-attribute merging.

## Tools and API contract

Paths below are relative to `/api/v1/accounts/{account_id}`.

| Tool | Method and path | Inputs beyond optional `account_id` |
|------|-----------------|-------------------------------------|
| `list_companies` | GET `/companies` | `page`, `sort` |
| `search_companies` | GET `/companies/search` | required `query` mapped to `q`, `page`, `sort` |
| `get_company` | GET `/companies/{company_id}` | required `company_id` |
| `get_company_contacts` | GET `/companies/{company_id}/contacts` | required `company_id`, `page` |
| `create_company` | POST `/companies` | required `name`, optional fields below |
| `update_company` | PATCH `/companies/{company_id}` | required `company_id`, optional fields below |
| `delete_company` | DELETE `/companies/{company_id}` | required `company_id` |
| `set_contact_company` | PATCH `/contacts/{contact_id}` | required `contact_id`, required nullable `company_id` |

Company lists/searches return `{ meta: { total_count, page }, payload: [...] }`,
50 records per page. Search matches a case-insensitive substring of **name or
domain**; a blank query is rejected by Chatwoot. Sort accepts `name`, `domain`,
`created_at`, `last_activity_at`, `contacts_count`; prefix `-` for descending.
The client defaults to page 1 and sort `name`.

`get_company_contacts` uses the **native association endpoint**, 25 contacts per
page, ordered by name then ID. It returns the server's `meta.total_count`,
`meta.page` and `payload` unchanged. Request successive pages until all contacts
are retrieved. It does not scan the account's contacts, infer associations from
names, or invent a `company_id` filter. It exposes no custom sort for this route.

Company detail/create/update responses retain `{ payload: { ...company } }`.
Deletion returns a scheduling acknowledgement, not confirmation that the
background job has finished. That job unlinks associated contacts and removes
their cached legacy company name; it does not delete the contacts.

## Supported write fields

Creation and update accept only these JSON fields:

| Field | Type | Behavior |
|-------|------|----------|
| `name` | string | Required and nonblank on creation; omit on update to retain it |
| `domain` | string or null | Domain without protocol; validated and unique per account; null clears it |
| `description` | string or null | Null clears it |
| `additional_attributes` | object | Arbitrary API-permitted JSON attributes; `social_profiles` values must be HTTP(S) URLs |
| `custom_attributes` | object | API-permitted custom attributes |

The client wraps these fields in the API-required `{ "company": { ... } }`.
Tool inputs remain flat, consistent with other Core tools. Routing parameters
are never included in the company payload. File/avatar uploads are not exposed:
Chatwoot's `avatar` is an attachment and requires multipart handling, not an
invented JSON `avatar_url` write field. Counts, timestamps and IDs are read-only.

Only supplied fields are updated. Omitted fields and explicit `null` are distinct.
Attribute containers must be objects; nullable values inside them are passed
through. Null does not mean deleting a custom-attribute key; the separate
Chatwoot key-deletion endpoint is outside these tools.

Chatwoot replaces `additional_attributes` and shallow-merges `custom_attributes`.
To preserve omitted keys, `update_company` first reads the company **only when
an attribute object is supplied**, then recursively merges the supplied objects
and sends the resulting attributes. Explicit nulls and arrays replace the
corresponding values. An empty attribute object preserves existing keys. Scalar
updates require only PATCH. A failed preliminary read aborts the update.
This read/merge/write is not atomic: simultaneous external attribute updates can
race with it. There is no concurrency control in the verified API contract.

## Contact association and unavailable features

`set_contact_company` sends only `{ "company_id": 123 }` or
`{ "company_id": null }` to the contact PATCH endpoint. Omitting `company_id`
is an error; it never implicitly unlinks. Chatwoot resolves the company inside
the selected account. It preserves the contact's other fields.

`additional_attributes.company_name` is legacy display data, **not** the company
relationship. These tools never use it to assign, find or unlink companies;
server callbacks may maintain that display data.

The verified Contacts controller silently ignores `company_id` when companies
is disabled. Before assignment **or unlinking**, the client therefore performs
GET `/companies?page=1&sort=name` on the same account. A disabled feature (403),
missing route (404), or other failed check aborts the PATCH. This adds one read
per association change and requires access to company listing. It does not
prove compatibility with arbitrary older/custom contact controllers; use the
verified version's contract.

Errors retain the project format: `isError: true` and
`Chatwoot API Error (<status>): <message>`. This includes 403 for disabled
companies/insufficient permissions, 404 for unavailable routes or missing or
inaccessible records, and API validation errors. The client does not reinterpret
all 404s as a disabled feature or report an unsuccessful write as completed.

## Safe mode and operational migration

`MCP_SAFE_MODE=true` blocks **only `delete_company` among the eight new tools**.
Reads, creation, updates, assignment and unlinking remain allowed. With
`MCP_SAFE_MODE=false` (or unset), all eight operations are permitted, subject to
Chatwoot authorization. Rules for all existing tools are unchanged.
Core now has 89 tools (15 blocked); all buckets together have 141 tools.

`MCP_READ_ONLY` is **no longer supported**. Remove it from any operational
Compose environment or referenced env file; it provides no protection. Use the
existing `MCP_SAFE_MODE` semantics above. This change does not edit or apply
production configuration.

After reviewing the operational Compose configuration, rebuild and recreate
its **`mcp`** service with the following commands (not run as part of this change):

```sh
docker compose build mcp
docker compose up -d --no-deps --force-recreate mcp
```

Run from the operational Compose directory, or add `-f /path/to/compose.yml`
before `build`/`up`. The example Compose in this repository calls its service
`chatwoot-mcp`, so substitute that name when using the example file.

Clients discover the eight additions through MCP `tools/list`. Refresh or
reconnect the ChatGPT plugin after updating the service. If its manifest,
allowed-tools list or instructions enumerate tools explicitly, add all eight
names there too; no plugin or production configuration is modified here.
