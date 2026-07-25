# Sign-In with Stellar (SIWS / SEP-0010)

> Implements issue **#69 — [Backend/Integration] Implement Web3 authentication via SIWS**

Adds "Sign in with Stellar" as a Web3-native login option alongside
password/email and Google — users authenticate by **signing a challenge with
their wallet** (Freighter) instead of typing a password, and the backend turns
that proof into a normal Supabase session.

---

## 1. Protocol (Task 1: SEP-0010 research → design)

[SEP-0010](https://stellar.org/protocol/sep-10) defines Web Authentication via a
challenge-response transaction — it's the same mechanism the SEP-24 fiat-ramp work
(#21) already uses to auth with an *anchor*. Here TrustLend is both the **server**
issuing the challenge and the **relying party** consuming the proof:

```
Client                          Backend (/api/auth/siws/*)          Supabase
  │  connect wallet (Freighter)         │                               │
  │────────────────────────────────────►│                               │
  │  POST /challenge { address }        │                               │
  │─────────────────────────────────────►  buildChallenge(address)      │
  │                                     │  WebAuth.buildChallengeTx()   │
  │  ◄──────────── { transaction, networkPassphrase }                  │
  │  sign challenge tx (Freighter)       │                               │
  │  POST /verify { address, signedTxXdr}                               │
  │─────────────────────────────────────►  verifyChallenge()            │
  │                                     │  WebAuth.readChallengeTx()    │
  │                                     │  WebAuth.verifyChallengeTxSigners()
  │                                     │  issueSessionForWallet() ────► admin.createUser / signInWithPassword
  │  ◄──────── { access_token, refresh_token, isNewUser } ◄─────────────│
  │  supabase.auth.setSession(...)      │                               │
```

**Why this bridges to Supabase without a custom-JWT signer:** rather than hand-
rolling a Supabase-compatible JWT (which requires the project's JWT signing
secret and is brittle across Supabase versions), the backend uses the
**service-role key** to deterministically provision a Supabase Auth user per
wallet (`<address>@siws.trustlend.app`, HMAC-derived password) and mints a real
session via `signInWithPassword`. The client then adopts it with
`supabase.auth.setSession(...)`. This is a standard, supported pattern for
"custom auth providers" on Supabase and requires no extra Supabase config.

## 2. Backend: challenge endpoint (Task 2)

**`POST /api/auth/siws/challenge`** — [route](app/api/auth/siws/challenge/route.ts)
```jsonc
// request
{ "address": "GABC...WALLET" }
// response 200
{ "transaction": "<base64 XDR>", "networkPassphrase": "Test SDF Network ; September 2015" }
```
Built with `WebAuth.buildChallengeTx` ([lib/auth/siws-server.ts](lib/auth/siws-server.ts)),
signed by a dedicated **SEP-10 server key** (`SIWS_SERVER_SECRET`, distinct from
the platform admin key), valid for 5 minutes, bound to `NEXT_PUBLIC_SIWS_DOMAIN`.
Rate-limited via the existing `enforceRouteRateLimit`.

## 3. Client: sign with Freighter (Task 3)

[lib/auth/siws-client.ts](lib/auth/siws-client.ts) `signInWithStellar()` drives the
whole flow; [components/auth/StellarSignInButton.tsx](components/auth/StellarSignInButton.tsx)
is a "Sign in with Stellar" button next to "Continue with Google" on the auth page
([components/auth/AuthPageClient.tsx](components/auth/AuthPageClient.tsx)). It
reuses the existing multi-wallet signer
([lib/stellar/wallet.ts](lib/stellar/wallet.ts) — Freighter or Albedo) so the
challenge is signed exactly like any other TrustLend wallet transaction.

## 4. Backend: signature validation → session (Task 4)

**`POST /api/auth/siws/verify`** — [route](app/api/auth/siws/verify/route.ts)
```jsonc
// request
{ "address": "GABC...", "signedTxXdr": "<base64 XDR>" }
// response 200
{ "access_token": "...", "refresh_token": "...", "isNewUser": true }
```
`verifyChallenge()` performs three checks via the Stellar SDK's `WebAuth` module:
1. **Structure & expiry** — `WebAuth.readChallengeTx` (throws on a malformed or
   timed-out challenge).
2. **Address match** — the challenge's `clientAccountID` must equal the address
   the client claims to be signing in as.
3. **Signature** — `WebAuth.verifyChallengeTxSigners` confirms the wallet actually
   signed it.

On success, `issueSessionForWallet()` creates (if new) a Supabase user keyed to
the wallet and returns a session; the client adopts it with `setSession`, and
existing role-based routing (`getDashboardPath`) takes over — new SIWS users
default to the `borrower` role like any fresh signup.

## 5. Error states (Task 5)

Every failure is a typed `SiwsError` with a `code` + HTTP status
([lib/auth/siws-server.ts](lib/auth/siws-server.ts)), mapped to a friendly message
client-side (`mapVerifyError` in [lib/auth/siws-client.ts](lib/auth/siws-client.ts)):

| Code | HTTP | User sees |
|---|---|---|
| `invalid_address` | 400 | "That wallet address is not valid." |
| `invalid_challenge` | 400 | "The sign-in challenge was invalid. Please retry." |
| `expired_challenge` | 401 | "Your sign-in request expired. Please try again." |
| `invalid_signature` | 401 | "We couldn't verify your wallet signature. Please try again." |
| `address_mismatch` | 400 | "The signature didn't match the connected wallet. Reconnect and retry." |
| `not_configured` / `session_failed` | 503/500 | "Stellar sign-in is temporarily unavailable. Please try another method." |

The button also surfaces wallet-level errors (Freighter not installed, wrong
network, user rejected) via the existing `signTransactionWithWallet` error paths.

## 6. Configuration

```bash
NEXT_PUBLIC_SIWS_DOMAIN=localhost:3000   # SEP-10 home/web-auth domain (both sides must match)
SIWS_SERVER_SECRET=                       # dedicated SEP-10 signing key (S...)
SIWS_PASSWORD_SECRET=                     # HMAC secret for wallet-user passwords
# reuses: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
#         SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE
```

## 7. Tests

[__tests__/auth/siws.test.ts](__tests__/auth/siws.test.ts) exercises the real
`WebAuth` roundtrip (build → sign → verify) with an in-memory test keypair —
happy path, wrong-signer, address mismatch, expired challenge, and malformed XDR —
without hitting the network or Supabase.

## 8. Notes

- The SEP-10 signing key is intentionally **separate** from the platform admin
  key used elsewhere (oracle, governance, default-management) — compromising one
  cannot forge the other.
- Rotating `SIWS_PASSWORD_SECRET` invalidates existing wallet-derived passwords;
  treat it like rotating a real secret (plan a re-auth, don't do it casually).
- Future: link a SIWS identity to an *existing* password-based account instead of
  always creating a fresh one keyed by address.
