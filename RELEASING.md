# Releases

Readmeter is self-hosted and licensed under MIT. Stable `vX.Y.Z` tags release:

- `@readmeter/firebase` on npm, including declarations, production and development wasm, and default rules.
- `ghcr.io/eviatarmor/readmeter:X.Y.Z` for Linux amd64 and arm64, with `X.Y` and `latest` tags.
- A GitHub release containing the SDK tarball, production Compose file, environment template, and SHA-256 checksums.

The other npm workspaces are private implementation packages. Rust crates remain unpublished; their code is distributed in the SDK and server image.

## One-time registry setup

Ensure the npm account owns the `@readmeter` scope. Bootstrap the first package publication from a verified local tarball if the package does not exist yet:

```sh
pnpm install --frozen-lockfile
pnpm sdk:build
pnpm --filter @readmeter/firebase test
pnpm --filter @readmeter/firebase test:bundle
mkdir -p artifacts
pnpm --filter @readmeter/firebase pack --pack-destination "$PWD/artifacts"
node scripts/check-sdk-package.mjs artifacts/readmeter-firebase-0.1.0.tgz
npm login
npm publish artifacts/readmeter-firebase-0.1.0.tgz --access public
```

For automated releases, configure an npm trusted publisher on the package with organization/user `eviatarmor`, repository `Readmeter`, workflow `release.yml`, and no environment name. The workflow uses npm 11 and GitHub OIDC with provenance; no npm token is stored. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). After bootstrapping a version, bump the SDK version before tagging the next release; npm versions cannot be overwritten.

Allow GitHub Actions to write packages and repository releases. The image job uses `GITHUB_TOKEN` to publish to GHCR. After the first push, set the GHCR package visibility to **public** so self-hosted installs can pull without signing in. See [GitHub container registry permissions](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Prepare and publish

Update `sdks/js/firebase/package.json` and `SDK_VERSION` in `sdks/js/firebase/src/version.ts` to the new stable version, update any versioned examples in docs, and commit the change. Check the tag matches the package version:

```sh
node scripts/prepare-release.mjs v0.1.0
docker build -t readmeter:test .
bash scripts/smoke-docker.sh
```

Push the release commit and its tag:

```sh
git tag v0.1.0
git push origin HEAD
git push origin v0.1.0
```

`.github/workflows/release.yml` first validates the version and runs the complete CI workflow, including Rust checks, SDK size gate, backend tests with Postgres, docs, emulator/end-to-end checks, and a deployment smoke test. It then builds and verifies the SDK tarball, publishes it to npm, builds and publishes the multi-platform server image, and creates the GitHub release after both registries succeed.

Prerelease tags are rejected. Never move or reuse a published version tag. If publication only partly succeeds, inspect the registry state before retrying: npm versions are immutable. Fix the failure and release a new patch version when necessary.

## Deploy

Use `deploy/compose.yml` and `deploy/.env.example`; see [production deployment](docs/content/docs/self-hosting/production.mdx). Pin the full image version in production and keep Postgres backups and both secrets across upgrades. Image roles run as the unprivileged Node user and HTTP services shut down cleanly on container stop.
