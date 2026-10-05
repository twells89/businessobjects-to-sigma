# Vendored Sigma authentication runtime

The browser OAuth runtime in this directory is vendored byte-for-byte from
`sigma-skills/sigma-api` branch `cursor/browser-oauth-provider-3e17`, commit
`e647ae3936bb8aa1ead94ffd255a8d6f66cdac8c`.

Canonical files and SHA-256 digests:

- `get_token.py`: `1967ece24a8eae8489ac2ee922ec9d26e79e9d5e7b9e63445c1a785768d0d658`
- `get-token.sh`: `9d951f86806d4f835cc8ba45766d7f715f5062bf31981816c252b328122bc76b`
- `browser-login.sh`: `64f3d5248e32a59f89765f9e106e238574cd45dbc2460dc6f84a676aab9f8a7e`
- `refresh-token.sh`: `acce747146e6c8eadff609e062811801c0f75eb5211003a6d3ae9f88a353fe46`
- `lib/browser-login-platform.sh`: `dae84d7c1d1af9433f4ae81882952c0e0b8240f467b5620ad9af9115e85303e7`

`sigma-auth.mjs` is the plugin-local Node adapter. It reuses valid environment
or `auth.json` access tokens, refreshes tokens with known age at 50 minutes by
invoking the vendored `get_token.py`, and retries one 401 exactly once.

The credential boundary is intentional: `auth.json` may contain only the
short-lived access token and its metadata. Browser refresh tokens remain in
the native OS keychain (`security` on macOS or `secret-tool`/libsecret on
Linux) and must never be copied into the repository or a work directory.

When updating the provider, copy all five canonical files together, update the
commit and hashes above, and run `npm run test:auth`. That test fails if a
vendored file drifts from the recorded digest.
