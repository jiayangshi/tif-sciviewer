# Publishing

Three things must be filled in first — search the repo for `CHANGE-ME`:

| Where | What |
|-------|------|
| `package.json` → `publisher` | your Marketplace publisher ID |
| `package.json` → `repository`, `bugs`, `homepage` | your repo URL |
| `LICENSE` | the copyright holder |

```bash
grep -rn "CHANGE-ME" package.json
```

The extension's unique identity is `publisher.name`, so it becomes
`your-publisher.tif-sciviewer`. Only the publisher ID has to be globally unique;
the `tif-sciviewer` half only has to be unique within your own publisher.

## Visual Studio Marketplace

**1. Create a publisher.** Sign in at
<https://marketplace.visualstudio.com/manage> with a Microsoft account and
create one. The ID you choose there is what goes in `package.json`.

**2. Create a Personal Access Token.** At <https://dev.azure.com>, under
*User settings → Personal access tokens → New Token*:

- **Organization: `All accessible organizations`** — a token scoped to a single
  organisation fails with a confusing 401.
- **Scopes:** *Custom defined* → *Marketplace* → **Manage**.
- Copy the token; it is shown once.

**3. Publish.**

```bash
npx @vscode/vsce login <your-publisher-id>   # paste the PAT, stored in the keychain
npm run publish:vsce
```

Or without storing it:

```bash
VSCE_PAT=<token> npx @vscode/vsce publish --no-dependencies
```

It appears in search within a few minutes, though the first publish can take
longer while it is scanned.

## Open VSX

Worth doing as well: it is what VSCodium, Cursor, Gitpod, Eclipse Theia and
OSS builds of code-server install from. Some managed remote environments cannot
reach the Microsoft marketplace at all.

**1.** Sign in at <https://open-vsx.org> with GitHub, agree to the publisher
agreement, and create an access token under *Settings → Access Tokens*.

**2.** Claim the namespace matching your publisher ID:

```bash
npx ovsx create-namespace <your-publisher-id> -p <token>
```

**3.** Publish the same `.vsix`:

```bash
npx ovsx publish tif-sciviewer.vsix -p <token>
```

## Releasing a new version

```bash
npm run verify                       # typecheck, build, 203 tests
npx @vscode/vsce publish patch       # bumps package.json, tags, publishes
```

`minor` and `major` work the same way. `vsce publish` runs
`vscode:prepublish` (the esbuild bundle) for you, but it does **not** run the
tests — hence `npm run verify` first.

Update `CHANGELOG.md` before each release; VS Code shows it on the extension's
page.

## Automated releases

`.github/workflows/release.yml` publishes on a version tag:

```bash
git tag v0.1.1 && git push --tags
```

It installs `tifffile`, regenerates the fixtures, runs the full suite, packages,
publishes to whichever registries have a token configured, and attaches the
`.vsix` to a GitHub release. Add the tokens as repository secrets named
`VSCE_PAT` and `OVSX_PAT`; each publish step is skipped if its secret is absent.

## Before the first publish

- [ ] `CHANGE-ME` gone from `package.json` and `LICENSE`.
- [ ] The repo is actually pushed — the README's relative links and image are
      rewritten to point at it, and they 404 otherwise.
- [ ] `npm run verify` passes.
- [ ] `npx @vscode/vsce package` reports no warnings.
- [ ] The built `.vsix` installs and opens a TIFF (see `MANUAL_TEST.md`).
- [ ] `README.md` reads as the marketplace landing page, because that is what
      it becomes.
- [ ] `CHANGELOG.md` describes this version.
- [ ] You are content for the code to be public. Marketplace listings can be
      unpublished, but the `.vsix` may already have been downloaded and mirrored.

## Not publishing publicly

If this only needs to reach your own machines, skip all of the above and share
the `.vsix`:

```bash
code --install-extension tif-sciviewer.vsix
```

It works identically, including over Remote-SSH — install it into the remote
host from the Extensions view. Private distribution is the norm for
lab-internal tooling, and avoids committing to supporting strangers' TIFFs.
