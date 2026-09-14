# Gaius Client v0.1.0 — final `main` rebuild

This clobber refresh replaces the prior `v0.1.0` assets with portable browser clients rebuilt from the final `main` source for Minecraft **1.21.11** and **26.2**. The existing `v0.1.0` Git tag is retained unchanged.

## Included fixes

- Faster single-player resource-pack startup and bounded new-chunk material/render scheduling.
- Bounded vanilla-resource caching and cooperative browser work queues to reduce long main-thread stalls.
- Rebuilt single-player server Worker, Worker bootstrap, WASM hot path, RelayNode registry, and embedded portable assets for both profiles.
- RelayNode target attestation, resource-pack download handling, bounded frame draining, reconnect handling, multi-client isolation, and close-time cleanup.
- Rebuilt Paper server plugin `gaius-server-plugin-0.1.0.jar`.

## Acceptance and provenance

Both compiled `Gaius.html` files passed direct `file://` execution in isolated Chrome driven through CDP. The single-player gates require an active level, ready WASM hot path, working local storage and IndexedDB, no runtime exceptions, no sibling file requests, and evidence hashes tied to the exact uploaded HTML bytes.

The 26.2 multiplayer artifact also passed the strict terrain gate against `t40.sjcmc.cn:14803` through `wss://ellan.site/tunnel`: `ClientLevel`, positive loaded chunks, successful RelayNode target attestation, zero bridge/runtime errors, and a non-blank real terrain screenshot.

`release.manifest.json` records source and artifact identities. `SHA256SUMS` covers the other seven assets. Publication performs a fresh download and verifies the exact eight-asset set before GitHub Pages is dispatched.

## GitHub Pages

- Home: https://typethe0ry.github.io/Gaius/
- Minecraft 1.21.11: https://typethe0ry.github.io/Gaius/1.21.11/
- Minecraft 26.2: https://typethe0ry.github.io/Gaius/26.2/
- Relay registry: https://typethe0ry.github.io/Gaius/relay-nodes.json
