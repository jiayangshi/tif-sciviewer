# Installing on remote servers

This extension declares `extensionKind: ["workspace"]`. That is deliberate: it
means VS Code installs it **on the remote host**, not on your laptop, so the
TIFF is decoded next to the file and only one rendered slice crosses the SSH
link. The consequence is that installing it locally does nothing for remote
files — it has to be installed once per server.

## Which approach

| Situation | Use |
|-----------|-----|
| One or two servers, occasional | The GUI, below |
| Many servers, private extension | `tools/install-remote.sh` |
| Many servers, published extension | `remote.SSH.defaultExtensions` |
| Air-gapped host, no server yet | Manual unpack, below |

## The GUI (one server)

Connect to the host with Remote-SSH, then in the Extensions view use the `…`
menu → **Install from VSIX…** and pick `tif-sciviewer.vsix` from your laptop.
Because the window is a remote window, it installs on the remote side. The
Extensions view will list it under **SSH: hostname**, not **Local** — that is
how you confirm it landed in the right place.

## Scripted (many servers)

```bash
npm run package
./tools/install-remote.sh gpu01 gpu02 cluster-login
```

Host names are anything `ssh` accepts, including `Host` aliases from
`~/.ssh/config` — the same ones Remote-SSH uses. The script copies the `.vsix`
and `tools/vscode-server-install.sh` to each host, runs the install, cleans up
after itself, and reports a summary. One failing host does not stop the rest;
the exit code is non-zero if any failed.

Under the hood it finds that host's VS Code Server CLI and runs
`code-server --install-extension <vsix> --force`. It handles both layouts —
`~/.vscode-server/bin/<commit>/` from Remote-SSH and
`~/.vscode-server/cli/servers/<quality>-<commit>/` from the tunnel CLI — and
picks the most recent when both exist.

To run it on a host you are already logged into:

```bash
scp tif-sciviewer.vsix tools/vscode-server-install.sh gpu01:/tmp/
ssh gpu01 'bash /tmp/vscode-server-install.sh /tmp/tif-sciviewer.vsix'
```

If the server lives somewhere unusual because you set
`remote.SSH.serverInstallPath`, pass it through:

```bash
ssh gpu01 'VSCODE_SERVER_DIR=/scratch/me/.vscode-server bash /tmp/vscode-server-install.sh /tmp/tif-sciviewer.vsix'
```

**The server has to exist first.** There is no way to install an extension into
a VS Code Server that has never run. Connect to each host once with Remote-SSH
to provision it; after that the script works. The script says so rather than
failing obscurely.

## Published extension, many servers

Once it is on the Marketplace or Open VSX this gets much easier — put this in
your **local** `settings.json`:

```json
{
  "remote.SSH.defaultExtensions": [
    "your-publisher.tif-sciviewer"
  ]
}
```

Every host you connect to from then on installs it automatically. This is the
right answer if you regularly work on new machines, and on its own is a decent
reason to publish even if the audience is only you.

## Air-gapped or broken server install

```bash
ssh host 'ALLOW_MANUAL=1 bash /tmp/vscode-server-install.sh /tmp/tif-sciviewer.vsix'
```

This unzips into `~/.vscode-server/extensions/<publisher>.<name>-<version>/`
directly. It works, with two caveats: VS Code does not record where the
extension came from, and a server update may drop it. If it does not appear
after a window reload, delete `~/.vscode-server/extensions/extensions.json` and
reload again — that file is a cache the server rebuilds.

## Set a real publisher first

The extension's identity is `publisher.name`, and it currently reads
`CHANGE-ME-your-publisher-id.tif-sciviewer`. For private installs the publisher
does not have to be registered anywhere, but it does have to be **stable**:
changing it later makes VS Code treat the result as a different extension, so
every server ends up with both installed. Set it to something you will keep —
your GitHub handle is a reasonable choice — before deploying widely.

## Other remote flavours

- **`code tunnel` / vscode.dev** — same `~/.vscode-server` layout; the script's
  second search path covers it.
- **GitHub Codespaces / devcontainers** — add it to `devcontainer.json` under
  `customizations.vscode.extensions` (published), or commit the `.vsix` and
  install it from a `postCreateCommand`.
- **coder/code-server (the third-party browser one)** — a different product with
  its own `~/.local/share/code-server/extensions`. Use its own CLI:
  `code-server --install-extension tif-sciviewer.vsix`. It installs from Open
  VSX rather than the Microsoft marketplace, which is the other reason to
  publish there.

## Verifying

```bash
ssh gpu01 'ls -d ~/.vscode-server/extensions/*tif-sciviewer*'
```

Then reload the remote window and open a `.tif`. In the Extensions view it must
appear under **SSH: hostname**. If it shows only under **Local**, it was
installed on the wrong side and remote files will still open as binary.
