# Publishing

Releases are built by GitHub Actions and uploaded to the Marketplace by hand:

1. Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds, tests
   and packages the extension and attaches `tif-sciviewer-<version>.vsix` to a
   GitHub Release.
2. You download that `.vsix`.
3. You upload it on the Marketplace's publisher management page.

Nothing in CI can publish, so there is no Marketplace token, secret or trust
relationship to configure, rotate or leak. Uploading only needs you to be signed
in to the Marketplace as a member of the publisher.

## One-time setup

**Publisher.** Sign in at <https://marketplace.visualstudio.com/manage> with a
Microsoft account and create a publisher. Its ID has to match `publisher` in
`package.json` — currently `Computational-Imaging` — because the extension's
identity is `publisher.name`: `Computational-Imaging.tif-sciviewer`. Only the
publisher ID has to be globally unique; the `tif-sciviewer` half only has to be
unique within your own publisher.

**First upload.** The extension does not exist on the Marketplace until it has
been uploaded once. On the publisher's page choose **+ New extension** →
**Visual Studio Code**, and give it a `.vsix` from a release (below). Every
later version goes through **Update** instead.

## Releasing a new version

1. Update `CHANGELOG.md` — VS Code shows it on the extension's page — and
   commit.
2. Bump the version and tag it:

   ```bash
   npm version patch          # or minor / major: bumps package.json, commits, tags
   git push --follow-tags
   ```

   `npm version` is what keeps the tag and the manifest in step. The release
   workflow compares them before building anything and stops if they disagree.
3. Wait for the **Release** workflow on the repository's Actions tab to go
   green. Its summary page links to everything below.
4. Download the `.vsix`, from either place — they are the same file:
   - the release, under **Assets**:
     <https://github.com/jiayangshi/tif-sciviewer/releases>
   - the workflow run, under **Artifacts**. An artifact always downloads as a
     `.zip`: unzip it and upload the `.vsix` inside, not the zip. Artifacts
     also expire (90 days by default); the release asset does not.
5. Optionally, install it once to be sure it is the build you expect:

   ```bash
   code --install-extension tif-sciviewer-<version>.vsix
   ```

6. Upload it: <https://marketplace.visualstudio.com/manage> → the
   `tif-sciviewer` row → **...** → **Update** → select the `.vsix`.

The Marketplace reads the version from inside the file and never accepts the
same version twice, so every upload needs a fresh `npm version`. After an
upload the Marketplace verifies the package before the listing changes, which
usually takes a few minutes.

## What the workflows do

- **`.github/workflows/ci.yml`** — every push and pull request. Installs with
  `npm ci`, regenerates the fixtures, runs `npm run verify`, and packages the
  extension so a packaging failure is caught on the branch rather than at
  release time. The `.vsix` is uploaded as a build artifact and kept for 14
  days — handy for trying out a branch, but upload the release's `.vsix` to
  the Marketplace: that one was built from a tag checked against
  `package.json`.
- **`.github/workflows/release.yml`** — a tag matching `v*`. Checks the tag
  against `package.json`, regenerates the fixtures, runs `npm run verify`,
  packages `tif-sciviewer-<version>.vsix`, keeps it as a workflow artifact,
  and creates a GitHub Release with it attached and notes generated from the
  commits since the last tag.

The release job asks for a single permission, `contents: write`, to create the
release. Re-running a tag is harmless: the release step replaces the asset on
the existing release instead of failing.

## Open VSX (optional)

Worth doing as well: it is what VSCodium, Cursor, Gitpod, Eclipse Theia and
OSS builds of code-server install from. Some managed remote environments cannot
reach the Microsoft marketplace at all. It is also done by hand, with the same
downloaded `.vsix`.

**1.** Sign in at <https://open-vsx.org> with GitHub, agree to the publisher
agreement, and create an access token under *Settings → Access Tokens*.

**2.** Once, claim the namespace matching your publisher ID:

```bash
npx ovsx create-namespace Computational-Imaging -p <token>
```

**3.** Publish each release's `.vsix`:

```bash
npx ovsx publish tif-sciviewer-<version>.vsix -p <token>
```

## Before the first publish

- [ ] `publisher` in `package.json` is the publisher you created.
- [ ] The repo is actually pushed — the README's relative links and image are
      rewritten to point at it, and they 404 otherwise.
- [ ] `npm run verify` passes.
- [ ] `npm run package:release` reports no warnings, and `npm run package:ls`
      lists only the files the extension needs at runtime.
- [ ] The built `.vsix` installs and opens a TIFF (see `MANUAL_TEST.md`).
- [ ] `README.md` reads as the marketplace landing page, because that is what
      it becomes.
- [ ] `CHANGELOG.md` describes this version.
- [ ] You are content for the code to be public. Marketplace listings can be
      unpublished, but the `.vsix` may already have been downloaded and mirrored.

## Not publishing publicly

If this only needs to reach your own machines, skip the Marketplace and share
the `.vsix` from a release:

```bash
code --install-extension tif-sciviewer-<version>.vsix
```

It works identically, including over Remote-SSH — install it into the remote
host from the Extensions view. Private distribution is the norm for
lab-internal tooling, and avoids committing to supporting strangers' TIFFs.
