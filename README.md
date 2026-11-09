# ThwunderList

<img src="icons/thwunderlist.svg" width="64" height="64" alt="ThwunderList icon">

Mail.app-style message cards for Thunderbird 159.0+.

- **Compact Cards View** with prominent senders, subjects, dates and one to four
  lines of body text. Row height follows the preview line count and font size.
- **Contact photos and initials** from local address books, with an option to
  hide avatars.
- **Native mail controls**: threading, sorting, selection, context menus,
  tags and message actions remain available.
- **Light and dark palettes**, rounded selection and inset separators.
- Table View, the folder sidebar, toolbars and message reader are unchanged.

## Message previews

Visible messages first use Thunderbird's cached excerpts. If no excerpt is
available, the add-on reads the MIME message, decodes the body, converts HTML
to plain text and caches the first 500 characters in the folder database.
Long HTML style blocks and encoded bodies are handled by the MIME fallback
rather than the native 2 KB excerpt limit.

**The fallback can download the complete message, including attachments,
from the configured mail server.** MIME requests run one at a time per mail
tab, only for visible rows still missing a preview. In-flight downloads may
finish after scrolling away. Offline mode uses local bodies and cached excerpts.

## Mail safety

Preview loading does not mark messages read, alter message bodies or load
remote images. Attachment contents are not used as preview text. Extracted
text is inserted as text, never rendered as HTML.

Avatars use Thunderbird's address-book lookup, including secondary email
addresses. Only local photo files and embedded images are loaded; remote
photo URLs are ignored. Missing or broken photos fall back to initials.
Sent folders use the first recipient's photo. Address-book entries are never
modified, and contact edits refresh the list through Thunderbird's own updates.

No third-party services, analytics or remote avatar providers are used.

## Install

Download the XPI from [Releases](https://github.com/Narmo/ThwunderList/releases),
or build locally with Node.js 22+, Python 3 and `zip`:

```sh
scripts/build.sh            # -> dist/thwunderlist-<version>.xpi
```

Thunderbird → Add-ons and Themes → Extensions → ⚙ → *Install Add-on From File…*.

Select **Cards View** in the message-list display menu.
**View → Layout → Vertical View** gives the closest Mail.app layout.
Saved view, theme, density and pane-layout preferences are left unchanged.

The add-on uses a privileged WebExtension Experiment to modify Thunderbird's
internal UI. Thunderbird therefore requests full access to the application
and computer. The implementation is in `experiments/mail-list/api.js`.

## Settings

- **Show sender avatars** — **View → Show sender avatars**, directly below
  **Display Attachments Inline**, or **ThwunderList → Preferences/Options**
  in the Add-ons Manager. Enabled by default; both controls stay synchronized.
- **Preview lines** — 1–4, default 2, in the add-on settings. Row height adjusts
  automatically to the line count and font size.

Settings apply immediately to all mail tabs and persist across restarts.

## Screenshots

Thunderbird 159 with synthetic local messages:

| Dark | Light |
| --- | --- |
| ![Dark message list](docs/preview-dark.png) | ![Light message list](docs/preview-light.png) |

## Releases

Branch pushes and pull requests run [CI](.github/workflows/ci.yml): syntax
checks, an XPI build and an uploaded `thwunderlist-xpi` artifact.

Pushing a `v*` tag runs [the release workflow](.github/workflows/release.yml):
it checks the tag matches `manifest.json`, builds the XPI and publishes a
GitHub Release with generated notes. GitHub's built-in token is sufficient;
no extra secrets are needed. Existing releases and their assets are left
unchanged on reruns.

Update `manifest.json` and commit before tagging a new release. For example,
after setting the version to `1.0.1`:

```sh
git tag -a v1.0.1 -m "ThwunderList 1.0.1"
git push origin HEAD v1.0.1
```

The tagged commit must include the workflow and build script. Existing tags
do not trigger releases retroactively. For an existing tag without a release,
use **Actions → Release → Run workflow** on `master` and enter that tag.
The manual run builds the tagged source, not the latest branch.

This does not sign the XPI or publish it to addons.thunderbird.net.

## Tests

The build script checks JavaScript and JSON syntax and packages only runtime
files and license notices. CI runs these checks, not Thunderbird UI tests.

Runtime checks were performed separately in isolated macOS Thunderbird 159
profiles with synthetic local mail and a local IMAP server. Coverage includes
plain-text and HTML previews, encoded bodies, unread flags, address-book
photos, settings, row sizing, scrolling, multiple tabs/windows and cleanup
on disable or uninstall.

## Limits

- The add-on uses Thunderbird 159's internal card API. Later versions are
  allowed by the manifest but may require changes.
- Other platforms, external mail providers and screen-reader output have not
  been tested.
- Empty or encrypted messages may have no preview.
- Other message-list extensions may conflict. Disabling or uninstalling restores
  native cards; cleanup also handles retained row-renderer references.

## License

The code and documentation are public domain under [The Unlicense](LICENSE).
The icon (`icons/thwunderlist.svg`) is dedicated under
[CC0 1.0 Universal](icons/LICENSE).
