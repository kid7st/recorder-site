# recorder-site

Publishes the notes [voicenote](https://github.com/fastagent-sh/voicenote) produces to a
password-protected static site on Tencent Cloud COS.

Plug the recorder in, walk away. voicenote transcribes and summarises; this
republishes the site. Nothing to click.

```
recorder → voicenote (transcribe + summarise) → workspace/ → recorder-site → COS → 浏览器
              scheduled, 60s                   metadata + audio    scheduled, 5min
```

Two ways to install: a development checkout (below), or a packaged Windows
installer for customers, see [docs/deploy-customer.md](docs/deploy-customer.md).

Runs on macOS and Windows. Two schedulers, same code:

| | macOS | Windows |
| --- | --- | --- |
| Install | `./install.sh` | `.\install.ps1` |
| Scheduler | LaunchAgent `sh.fastagent.recorder-site` | Task Scheduler `recorder-site` |
| Config | `~/.config/recorder-site/config.json` | `%APPDATA%\recorder-site\config.json` |
| Manifest + log | `~/.local/state/recorder-site/` | `%LOCALAPPDATA%\recorder-site\` |

Those paths mirror voicenote's own, so `workspace` is inherited from its config
on both platforms. Neither scheduler re-enters a run that is still going, which
matters on the first run when ~1GB of audio is uploading.

## What it publishes

Read from the voicenote workspace, no extra state:

| Source | Becomes |
| --- | --- |
| `_metadata/**/*-metadata.json` (`markdown` field) | note page |
| `_transcripts/**` | collapsible full transcript |
| `_audio/**` | inline player |
| `action_items` across all notes | pending-actions list on the index |

Notes whose summary stage failed are skipped until voicenote retries them.

## Encryption

The whole site is AES-256-GCM encrypted with one password (PBKDF2-SHA256,
250k iterations). The bucket only ever holds ciphertext; decryption happens in
the browser after you type the password, which is then kept in `sessionStorage`
until the tab closes.

Audio files are the exception: they are stored under unguessable hashed names
(`a/<sha256-prefix>.mp3`) rather than encrypted, because an encrypted file
cannot stream and would have to download in full before playing. Anyone holding
a specific audio URL can fetch it; nobody can enumerate or find them without the
password.

Publishing without a password is refused, not defaulted.

The bucket itself is **public-read** — static website hosting serves anonymous
visitors, so a private bucket 403s everyone. That is safe only because nothing
readable is ever uploaded.

## Setup

### 1. Bucket

Create a COS bucket, private read/write, and enable static website hosting with
`index.html` as the index document.

**A custom domain is required.** For buckets created after 2024-01-01 Tencent
Cloud forces `Content-Disposition: attachment` on all its own domains
(`*.cos.*.myqcloud.com`, `*.cos-website.*.myqcloud.com`), so pages download
instead of opening. Bind a domain under 域名与传输管理 → 自定义源站域名, with
源站类型 set to 静态网站.

- Mainland region (`ap-guangzhou`, `ap-shanghai`, …): the domain must have an ICP
  filing. Faster from within China.
- Hong Kong / overseas (`ap-hongkong`, `ap-singapore`): no filing needed.

Give the API key a sub-account限制到该桶, not your root key.

### 2. Config

```bash
git clone <this repo> ~/projects/recorder && cd ~/projects/recorder
bun install
./install.sh          # Windows: .\install.ps1 — writes the config template on first run
```

Fill in the config file printed by the installer:

```json
{
  "password": "你的访问口令",
  "cos": {
    "secretId": "AKID...",
    "secretKey": "...",
    "bucket": "vnsite-1250000000",
    "region": "ap-hongkong"
  },
  "siteUrl": "https://notes.example.com",
  "uploadAudio": true
}
```

`workspace` is optional; it defaults to `VOICENOTE_WORKSPACE` from
`~/.config/voicenote/config.json`. `uploadAudio: false` publishes text only —
useful for the first run, since audio is by far the slowest part.

### 3. Check it locally, then go live

```bash
bun src/publish.ts --out /tmp/preview   # render to disk, no bucket needed
open /tmp/preview/index.html            # type the password, click around
./install.sh                            # install the 5-minute LaunchAgent
```

## Commands

```bash
bun src/publish.ts              # publish changes
bun src/publish.ts --dry-run    # list what would upload
bun src/publish.ts --force      # ignore the manifest, re-upload everything
bun src/publish.ts --out DIR    # render locally instead of uploading
bun test

# macOS
tail -f ~/.local/state/recorder-site/publish.log
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/sh.fastagent.recorder-site.plist

# Windows
Get-Content -Wait $env:LOCALAPPDATA\recorder-site\publish.log
Unregister-ScheduledTask -TaskName recorder-site -Confirm:$false
```

Set `PUBLISH_INTERVAL` (seconds, default 300) before installing to change the
schedule.

### One machine per bucket

Each machine publishes what its own workspace contains, `index.html` included.
Two machines with **different** recordings pointed at one bucket will overwrite
each other's index, and whichever ran last wins (the other's pages stay uploaded,
just unreachable from the list).

So: one bucket per machine. If two machines should share a site, sync the
workspace between them instead (iCloud Drive, Syncthing, 坚果云, …) so both
publish identical content.

## Incremental uploads

`manifest.json` in the state directory maps each object key to a
fingerprint: the SHA-256 of a page's **plaintext**, or `size-mtime` for audio.
Only changed keys upload; keys that disappear from the workspace are deleted
from the bucket.

Fingerprinting plaintext rather than ciphertext is what makes this work at all —
every run re-encrypts with a fresh salt and IV, so ciphertext always differs.
The manifest is written even when a run dies partway, so a dropped connection
during the first ~1GB audio upload does not restart from zero.

A steady-state run with nothing new takes under a second: pages are only
encrypted (~200ms each) after their fingerprint has already changed.
