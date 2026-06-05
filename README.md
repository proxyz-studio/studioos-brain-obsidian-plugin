# StudioOS Brain — Obsidian plugin

Syncs your [MY 2nd BRAIN](https://studioos.proxyz.studio) items between StudioOS and your local Obsidian vault.

## Status

**Pre-release.** PR-4a (this scaffold) ships the plugin skeleton + Settings tab placeholder. The sync engine arrives in PR-4b.

## Install (BRAT — beta)

1. Open Obsidian → Settings → Community plugins → enable
2. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
3. BRAT → Add Beta plugin → paste:

```
https://github.com/proxyz-studio/studioos-brain-obsidian-plugin
```

4. Enable **StudioOS Brain** in Community plugins
5. Open Settings → StudioOS Brain → Connect with code

## Connect flow

1. Sign in to https://studioos.proxyz.studio in any browser
2. Land on `/dashboard/brain` → the wizard shows an 8-digit pairing code
3. Paste the code into the plugin's "Connect with code" dialog
4. Done — your brain syncs into `05-BRAIN/` in this vault

## Building from source

```bash
npm install
npm run build  # produces main.js + manifest.json
```

The build artifacts (`main.js`) are attached to GitHub Releases for BRAT to pick up.

## License

MIT (PROXYZ Studio)
