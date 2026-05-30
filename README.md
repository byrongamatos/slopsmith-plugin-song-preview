# Song Preview

*A plugin that no-one asked for? Anyway, here's ~~Wonderwall~~ **Song Preview**!*

Hear a preview of songs in your library as you browse them. On desktop, just hover and listen — no buttons, no clicking. On your phone? A single tap does the job.

---

## ✨ New in 2.0

* **Fix Missing Previews** — find every song without a preview and back-fill them in one click.
* **Works on your phone** — tap-to-play buttons on touchscreens.
* **List-view progress** — the progress trace and a "now playing" highlight now work in list view too, not just grid.
* **Its own volume** — previews now have a dedicated volume slider, decoupled from the song mixer.
* **Security fixes** — the preview & back-fill pipeline now guards against maliciously-crafted Sloppaks (path-traversal and oversized-file protection), so a dodgy file can't trick it into reading something it shouldn't.

---

## Features & Formats

* **Audio Previews:** Instantly hear snippets just by hovering over your tracks (or tapping, on a touchscreen).

* **Fix Missing Previews:** Got songs with no preview — older Sloppak conversions, or tracks that never had one? The plugin now finds them all and sorts them out for you. Open **Song Preview** from the Plugins menu (or Settings) to see what's missing, then hit **Fix All** — or fix them one at a time straight from a song's card. Each fix either copies a ready-made clip from a matching `.psarc` (best quality) or generates a fresh ~30-second snippet from the song's own audio, with a progress bar so you can watch it happen.

* **Works on Your Phone:** No hover on a touchscreen, so each song gets a little play button — tap to preview, tap again to stop, or just scroll away and it stops itself. Desktop stays pure hover-to-listen; the buttons only show up on touch devices.

* **Progress Indicator:** A clean accent-coloured trace shows how much of the clip is left at a glance. In grid view it rings the album art; in list view it traces the row itself — and the playing row lights up so you can see exactly which track is sounding. Auto-matches your theme accent (works great with the [Themes plugin](https://github.com/masc0t/slopsmith-plugin-themes)).

* **Keyboard Friendly:** Arrow-key through the library and the focused card previews automatically — same hover-to-listen behaviour, no mouse required.

* **Volume Control:** Are your ears being blown off by the previews? They have their own **Preview Volume** slider now — find it on the plugin screen or in Settings, completely separate from the song mixer. Drag it to your liking. It's loudness only, so it won't fully mute — flip the on/off toggle for that.

* **Supported Formats:** `.psarc` and `.sloppak` files, **as well as** loose song folders.

* **On/Off Toggle:** Find it in Settings, or under the **Plugins** dropdown at the top. Red = off, green = on. Defaults to on, and your choice survives plugin updates.

---

## How to install?

**The easy way:** Song Preview is now in the official plugin list, so you can find and install it straight from the **Update Manager** plugin — no URLs to paste, and you'll get future updates from there too.

**The manual way** — Ez-pz steps with Sin:

```bash
1) cd /path/to/slopsmith/plugins
2) git clone https://github.com/DeathlySin/slopsmith-plugin-song-preview.git song_preview
3) Restart Slopsmith
4) ???
5) Profit
```

(You can also point Update Manager at the repo directly if you prefer: `https://github.com/DeathlySin/slopsmith-plugin-song-preview.git`)

---

## Questions? Bugs?

Open an [issue](https://github.com/DeathlySin/slopsmith-plugin-song-preview/issues), or ping `@deathlysin` in the [Slopsmith Discord](https://discord.gg/TzPVK8fNBm)'s plugins channel.

---

## ☕ Support — completely optional!

First things first: this plugin is **free**, and nothing here is locked behind a payment. You owe me absolutely nothing — please don't feel any pressure whatsoever. 🙂

That said, if you like the plugin, and you *fancy* showing some support, you're very welcome to [**buy me a coffee**](https://buymeacoffee.com/deathlysin). It's genuinely not expected or demanded — just a kind gesture that helps keep the cogs turning in my brain so I can bring more projects like this one to life. Either way, thanks for using it! ❤️

## License

[AGPL-3.0-only](LICENSE.md)
