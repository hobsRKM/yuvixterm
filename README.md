<div align="center">

![YuviXterm](website/assets/og.png)

# YuviXterm

**A modern, native SSH client for macOS — a free [MobaXterm](https://mobaxterm.mobatek.net/) alternative.**

Saved-host sidebar · tabbed terminals · a live server resource monitor.

![macOS 11+](https://img.shields.io/badge/macOS-11%2B-000?logo=apple&logoColor=white)
![Universal](https://img.shields.io/badge/Universal-Apple%20Silicon%20%2B%20Intel-58a6ff)
![Price](https://img.shields.io/badge/price-free-3fb950)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

### [⬇ Download for macOS](https://github.com/OWNER/REPO/releases/latest)

![YuviXterm screenshot](docs/screenshot.png)

</div>

---

## What is YuviXterm?

MobaXterm never came to the Mac. **YuviXterm** brings the parts Mac users miss most — a saved-host sidebar, tabbed SSH terminals, and a **live resource monitor** of every server you connect to — into one clean, native app. No SFTP tax, no account, no subscription.

## Features

- **Saved-host sidebar** — group and search across all your servers; one click to connect.
- **Tabbed terminals** — real [xterm.js](https://xtermjs.org) terminals with full color & resize; many live sessions at once.
- **Live resource monitor** — a MobaXterm-style bottom bar graphs the *remote* box's CPU, RAM, network (Mb/s), disk, load & uptime — live, over the same connection.
- **Encrypted credentials** — logins sealed in the macOS Keychain (never plaintext); SSH keys, key passphrases & `ssh-agent` all supported.
- **Per-host advanced options** — custom key-exchange order, keepalive interval, pinned host-key fingerprints.
- **Trust-on-first-use host keys** — clear prompts for new hosts, and an explicit re-trust prompt if a key ever changes.

## Download

Grab the latest **universal** `.dmg` (Apple Silicon + Intel) from the **[Releases](https://github.com/OWNER/REPO/releases/latest)** page. Requires macOS 11 Big Sur or later.

> **First launch:** the build is independently distributed (unsigned), so right-click the app in Finder -> **Open** -> **Open**. macOS remembers it afterward.

## Build from source

```bash
git clone https://github.com/OWNER/REPO.git
cd REPO
npm install
npm start        # run in dev
npm test         # unit tests (node --test)
npm run dist     # build dist/YuviXterm-<version>-universal.dmg
```

## How it works

| Layer | Tech |
|---|---|
| App shell | **Electron** — contextIsolation on, nodeIntegration off, sandboxed renderer |
| SSH transport | [**ssh2**](https://github.com/mscdex/ssh2) — auth, the shell channel, and the /proc monitor feed |
| Terminal | [**xterm.js**](https://xtermjs.org) |

The renderer talks to the main process only through a typed `window.api` bridge. Logins are encrypted with Electron `safeStorage` (macOS Keychain) and stored `0600`; a Content-Security-Policy blocks all remote content, so your hosts and secrets never leave your Mac.

The bug-prone pure logic — the /proc stats parser, the encrypted session store, the connect-config builder, and the host-key verifier — is unit-tested (`npm test`).

## Roadmap

Not in the first release: SFTP file transfer, port forwarding, X11, split panes.

## License

[MIT](LICENSE) (c) 2026 Yuvaraj Mudaliar
