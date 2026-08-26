# Security Policy

## Supported Versions

| Version | Supported |
| 0.2.x   | Yes       |
| 0.1.x   | Security fixes only |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email **trefeon@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce (PoC if available)
- Impact assessment if known

You will receive an acknowledgment within 72 hours. We aim to provide a fix
or mitigation plan within 14 days and will coordinate disclosure with you.

## Threat Model

This project is an LLM gateway / relay. The in-scope threat model covers four
areas:

| # | Threat | Mitigation |
|---|--------|------------|
| T1 | **Open proxy abuse** — public relay endpoint used as unauthenticated proxy | `x-relay-auth` shared secret (32-byte random, 64 hex chars via `RELAY_AUTH_SECRET`); requests without a matching header are rejected with `401 Unauthorized` |
| T2 | **SSRF** — relay coerced to fetch private / metadata endpoints | `isPrivateHostname()` blocklist (localhost, `127.0.0.1`, `::1`, `169.254.169.254`, `10.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`, `fc`/`fd` ULA) + `http:`/`https:` protocol allowlist + `new URL()` parsing; rejected with `403 Forbidden` |
| T3 | **API key leak** — keys exposed in logs, git history, or API responses | Keys stored only as `SHA-256` hashes at rest; comparison is constant-time (`timingSafeEqual` over SHA-256 digests, so request timing leaks nothing about token content or length); logs and API responses use masked values; `.env` is gitignored; compromised keys can be hot-revoked without restart |

Out of scope for the core gateway: OAuth2/OIDC/SAML, mTLS, and KMS/Vault
integration. These may be added as opt-in features if multi-tenancy is required.

### `allowPrivate` — opt-in loopback exception (outbound only)

Local providers served on loopback (e.g. **ollama** at `http://localhost:11434`) are registered
with `allowPrivate: true` in `src/config/providers.ts`. This opt-in bypasses **only** the outbound
private-hostname check for that one provider's dispatch. It does not weaken anything else:

- The `http:`/`https:` protocol allowlist still applies to every request.
- Credentials embedded in the target URL (`user:pass@host`) are still rejected.
- Inbound relay target validation (`assertRelayTarget`) stays fully strict — a relayed fetch
  can never be pointed at a private/metadata address, regardless of any provider's `allowPrivate`.
- The flag is code-only (no env var, no request header can set it); enabling it for a new
  provider requires a reviewed change to `providers.ts`.

## Security Best Practices for Operators

- Never commit `.env` or `AUTH_TOKENS` to git.
- Generate `RELAY_AUTH_SECRET` with `randomBytes(32).toString("hex")` and store it in your environment / Vercel env.
- Rotate secrets by deploying the new value alongside the old for a short grace window, then removing the old value.
- Keep Node.js and dependencies up to date (`pnpm audit` / `npm audit`).

## Disclosure Policy

We follow coordinated disclosure. Once a fix is available we will publish a
GitHub Security Advisory and credit the reporter (unless anonymity is requested).
