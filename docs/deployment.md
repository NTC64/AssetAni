# Deployment status after Phase 5

Phase 3 provides local API and worker bundles at `dist/backend/api.cjs` and `dist/backend/worker.cjs`, plus a development-only Compose file for PostgreSQL and Redis.

There is no production deployment configuration. Caddy, production Dockerfiles, GHCR publishing, managed PostgreSQL selection, R2, signed storage URLs and secret provisioning are deferred to Phase 7. The development Compose ports bind only to `127.0.0.1`.

The standalone Phase 4 Cocos extension is built at `dist/ai-sprite-generator`. It defaults to the local API URL, while the field remains editable for development environments.

Phase 5 adds API-key authentication, Redis rate limiting, and PostgreSQL credit enforcement. TLS, secret provisioning, R2 and production container hardening remain Phase 7 work, so this development API should not be exposed publicly.
