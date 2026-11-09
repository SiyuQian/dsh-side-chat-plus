# npm releases and native DSH version checks

## Package identity and compatibility

Publish only **`@siyuqian/dsh-side-chat-plus`** to **`https://registry.npmjs.org/`**, with public access. The unscoped npm package `dsh-side-chat-plus` belongs to another publisher; never install or publish that registry name for this repository. The GitHub repository URL is unchanged.

This preparation retains version **0.1.0**; it does not publish or bump it. Check the scoped registry history before a future release and select an unused semver version. Keep the root and root-package versions in `package-lock.json` synchronized with the manifest when bumping. DSH lists only versions newer than the installed version.

Preserve row ID `side-chat-plus`, `/side-chat-plus/rpc`, the native tab identity and `data/side-chat-plus/` storage directory. Renaming the npm package must not rename user state. The description and runtime UI are unchanged; exported English/Chinese inventory metadata and an original MIT-licensed SVG icon describe the same plugin.

Target remains **DSH 0.2.2-rc.1 / Node 24+**. Existing `engines.dsh` and SDK peers are not broadened by this preparation. Never bypass DSH compatibility checks to install or test a release.

## Local preparation

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run check
git diff --check
npm pack --dry-run --json --ignore-scripts
```

The standalone dependency install avoids resolving another Host SDK through peers. It does not relax DSH's runtime admission checks. `check` runs the core, built-browser registration and client tests and builds both halves. The host remains ESM; the browser artifact is a lazy `window.__ModuleLoader__` factory whose ID comes from the scoped manifest name and whose React dependency is resolved from DSH's module table. Build explicitly before the `--ignore-scripts` packing inspection; otherwise a clean checkout lacks `lib/`. Normal `npm pack`/publishing also runs the existing `prepack` build. In a DSH-managed agent environment, use the bundled Node and pnpm paths from `load_workspace_dependencies` for pnpm invocations.

Inspect the exact dry-run file list: `lib/index.js`, `lib/client.js`, their source maps, `package.json`, `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`, `icon.svg`, README, this guide, VERIFICATION.md, LICENSE and THIRD_PARTY_NOTICES. No workspace records, saved discussions, test artifacts, credentials or `node_modules` belong in the tarball. Validate metadata JSON and the SVG, resource exports, scoped name and unchanged row/storage IDs. Test/build success does not prove actual model/file permission enforcement or rendered GUI behavior; retain the post-install checks in VERIFICATION.md.

## Publish later — not during preparation

The handoff reports npm authentication **E401**. Publishing is blocked until the publisher independently restores access and verifies control of `@siyuqian`. Do not put credentials in chat or source files. This preparation does not read credentials, publish, commit, push or modify any profile.

After separate explicit release approval, valid npm access, review and successful checks, the future manual command is:

```sh
npm publish --access public --registry=https://registry.npmjs.org/
```

Inspect the published scoped version before installation. A pack dry-run neither contacts npm for publication nor proves authentication or scope ownership. No GitHub workflow or custom updater is needed.

## One-time migration to a registry installation

After publication, install `@siyuqian/dsh-side-chat-plus@<published-version>` using **Plugins > Add plugin** with the public npm registry, or an authorized native `plugin_manager` installation. Do not run npm/pnpm inside the active profile or edit profile files by hand.

An existing unscoped local/Git installation (for example **0.1.0 disabled**) is a different package identity:

1. Record the exact trusted source/version and disabled/enabled state through DSH. Back up user data separately. Keep `data/side-chat-plus/` and do not rewrite saved discussions.
2. Remove the old bundle through DSH's normal management flow before selecting the scoped bundle. Both declare row `side-chat-plus`; do not activate them together. Follow any stop/restart requirement.
3. Install the scoped npm dependency under its own name. Preserve the prior disabled state: an authorized native install can use `enabled: false`; a disabled plugin must not be activated merely to migrate it. The default installation enables a new bundle, so choose the activation setting deliberately.
4. Verify exactly one row, its scoped source/version and disabled state. When later explicitly enabled, use a non-sensitive workspace for the acceptance checks in VERIFICATION.md and confirm discussion history is retained. Module-name assertions and old overrides may need supported-control migration even though row/storage IDs remain stable.

If migration fails, use the recorded trusted local/Git source for rollback, never the unrelated unscoped npm package. Migration is a separate profile-changing operation and was not executed here.

## DSH native npm checks

DSH owns discovery and updates. The prerequisite is a third-party profile dependency saved as a **registry spec under its own scoped package name**, with a semver version and bundle patch. A Git URL, local directory, tarball or `npm:` alias does not qualify for the native version list.

Use the installed bundle's version/update control on the Plugins page. Its native service contract is `pluginManager.listVersions('@siyuqian/dsh-side-chat-plus', { registry: 'https://registry.npmjs.org/' })`; this is documentation of DSH, not an Inspect method or code to add to the plugin. DSH returns only newer versions, their tags, prerelease/deprecation and DSH compatibility information. A successful empty list means no newer release. A refusal (`not-updatable`, `not-found`, network or authentication error) does not.

A later approved update uses native `updateBundle` with an exact newer version. DSH checks bundle/DSH compatibility, preserves the bundle's enabled selection (including disabled), and reports activation or restart outcomes. Do not grant a compatibility exemption to make a release appear supported. Follow the result and confirm the loaded version after any restart.

Live acceptance requires the initial scoped registry installation and a later newer published version. No npm release, profile migration, rendered icon check or end-to-end native update check was performed during preparation.
