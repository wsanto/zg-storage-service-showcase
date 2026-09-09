# 0G Decentralized Storage Service (showcase excerpt)

A small standalone TypeScript microservice for registering file references on
[0G](https://0g.ai)'s decentralized storage network, using an Ethereum-compatible wallet signer.
Extracted from a much larger platform this service supported.

**Scope note:** this is a deliberately narrow extraction. The source repository this came from
contains real crypto/financial operations (wallet management, payment processing), exported
records referencing real user accounts, and client-specific material — none of that is included or
was ever considered for inclusion. This service is self-contained, was checked file-by-file, reads
its signing key only from an environment variable, and does not touch any of the surrounding
platform's data.

## What's included here

- **`index.ts`** — service entry point: config/env validation, an `ethers.js` wallet signer
  initialized from an environment-provided private key, and the HTTP server.
- **`fileRegistry.ts`** — the file-registry contract interaction layer.

## Stack

TypeScript, ethers.js, a decentralized storage network integration.
