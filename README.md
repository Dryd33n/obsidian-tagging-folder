<div align="center">

# 🏷️ Folder Auto-Tag

**Tag notes automatically based on the folder they live in.**

[![Obsidian](https://img.shields.io/badge/Obsidian-1.4.4%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md)
[![Latest release](https://img.shields.io/github/v/release/Dryd33n/obsidian-tagging-folder?color=7C3AED&label=release)](https://github.com/Dryd33n/obsidian-tagging-folder/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Features](#-features) · [Install](#-installation) · [Usage](#-usage) · [Settings](#%EF%B8%8F-settings) · [Limitations](#%EF%B8%8F-limitations) · [Contributing](#-contributing)

</div>

---

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 🏷️ Hands-off tagging
- Right-click any folder to **give it a tag**
- New notes in the folder are **tagged as they're created**
- Notes **moved in** pick up the tag, notes **moved out** can drop it
- **Tag existing notes** in one click when you set a folder up
- Optionally **includes subfolders**
- Works with templates: tags survive a template rewriting a new note

</td>
<td width="50%" valign="top">

### 🔄 Stays in sync
- **Nested folders stack:** a note in `Projects/Work/` gets `#project` and `#work`
- Rename or move a folder and its **tagging follows it**
- Moving a whole folder asks **once**, not once per note
- Change a tag name and choose to **replace or keep** the old one
- Only touches the `tags` property; the **note body is never edited**

</td>
</tr>
</table>

Whenever tags would be removed, the plugin **asks first**. Tick **Don't ask again** to make your answer the default, and change it any time in settings.

## 📦 Installation

<details open>
<summary><b>Manual install</b></summary>

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Dryd33n/obsidian-tagging-folder/releases/latest), or [build them yourself](#-contributing).
2. Copy them into `<Vault>/.obsidian/plugins/folder-auto-tag/`.
3. Reload Obsidian and enable **Folder Auto-Tag** in **Settings → Community plugins**.

</details>

<details>
<summary><b>Beta builds with BRAT</b></summary>

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Select **Add beta plugin** and enter `Dryd33n/obsidian-tagging-folder`.

</details>

## 🚀 Usage

1. Right-click a folder and select **Auto-tag…**.
2. Enter a **tag name**, such as `project` or `area/work`. A leading `#` is fine.
3. Choose whether to **tag existing notes** and **include subfolders**. Both are on by default.
4. Select **Enable**.

From then on, notes created in or moved into the folder get the tag in their `tags` property.

> [!TIP]
> Right-click the folder again to **edit** its tag, **re-apply** it to every note in the folder, or **disable auto-tagging**.

### 🔀 Moving notes

| You move a note… | What happens |
| :--- | :--- |
| Into an auto-tag folder | The folder's tag is added |
| Between two auto-tag folders | The new folder's tag is added and the old one is removed (or kept, see [Settings](#%EF%B8%8F-settings)) |
| Out to a normal folder | The tag is removed or kept, see [Settings](#%EF%B8%8F-settings) |
| Within the same auto-tag folder | Nothing changes |

Moving a folder of notes gives a **single prompt** for all of them. Closing a prompt without choosing always **keeps** the tags.

## ⚙️ Settings

Under **Settings → Folder Auto-Tag** you'll find every auto-tag folder, each with **⚙ Edit** and **✕ Disable** buttons, and two behaviour settings:

| Setting | Options | Default |
| :--- | :--- | :--- |
| When disabling a folder's auto-tagging | Ask every time · Remove tags · Keep tags | Ask every time |
| When a note leaves an auto-tag folder | Ask every time · Remove tag · Keep tag | Ask every time |

Per folder:

| Option | Default |
| :--- | :--- |
| Tag name | — |
| Include subfolders | ✅ On |
| Tag existing notes (when enabling) | ✅ On |

> [!NOTE]
> Turning **Include subfolders** off counts as the subfolder notes leaving the folder, so it follows the "leaves an auto-tag folder" setting.

## ⚠️ Limitations

- **Tags you added by hand can be removed.** If a note already had `#project` before its folder was auto-tagged, disabling the folder or moving the note out can remove it.
- **Changes made while Obsidian is closed aren't picked up.** If notes are moved by sync or your file manager while Obsidian isn't running, use **Re-apply tag** to catch up.
- Only Markdown notes are tagged. Canvases, PDFs and other files are ignored.
- The vault root can't be auto-tagged.
- Templates that take longer than 10 seconds to fill in a new note (for example, an unanswered Templater prompt) can overwrite the tag.

> [!NOTE]
> **Privacy:** everything runs locally. The plugin only edits the `tags` property of notes in your auto-tag folders.

## 🤝 Contributing

Issues and pull requests are welcome.

- 🐛 **Bugs:** [open an issue](https://github.com/Dryd33n/obsidian-tagging-folder/issues) with your Obsidian version, OS and the steps that reproduce the problem.
- 💡 **Features:** open an issue to discuss before starting large changes.

<details>
<summary><b>Development setup</b></summary>

```bash
git clone https://github.com/Dryd33n/obsidian-tagging-folder.git
cd obsidian-tagging-folder
npm install
npm run dev     # rebuild main.js on change
```

Copy `main.js`, `manifest.json` and `styles.css` into a **test vault** at `.obsidian/plugins/folder-auto-tag/`, then reload Obsidian.

</details>

<details>
<summary><b>Testing</b></summary>

```bash
npm test           # unit tests for the tagging logic
npm run test:e2e   # end-to-end tests in a real Obsidian instance
```

The end-to-end suite builds a fresh `test-vault/`, launches an **isolated** Obsidian instance with its own data folder (your normal Obsidian and vaults are untouched), runs every flow through the real UI and checks the notes on disk. It uses the newest Obsidian version your install has downloaded.

| Variable | Effect |
| :--- | :--- |
| `OBSIDIAN_PATH` | Obsidian executable, if it isn't at `%LOCALAPPDATA%\Obsidian\Obsidian.exe` |
| `OBSIDIAN_ASAR` | Test a specific Obsidian app version (`obsidian-x.y.z.asar`) |
| `KEEP_OPEN=1` | Leave the test instance running afterwards to explore the test vault |
| `E2E_DEBUG=1` | Log the active window before each test and list open modals on failure |

</details>

<details>
<summary><b>Pull request checklist</b></summary>

- [ ] Branch from `master` and keep each PR focused on one change.
- [ ] `npm run build`, `npm test` and `npm run test:e2e` pass.
- [ ] The PR describes what you tested in Obsidian.
- [ ] No `main.js` or other build output committed.
- [ ] Any UI text uses sentence case.

</details>

<details>
<summary><b>Code layout</b></summary>

| Path | Contents |
| :--- | :--- |
| `src/main.ts` | Plugin lifecycle, vault events and rule actions |
| `src/rules.ts` | Folder scope and tag logic (no Obsidian dependency) |
| `src/modals.ts` | Folder modal and confirmation prompts |
| `src/settings.ts` | Settings tab |
| `tests/` | Unit and end-to-end tests |
| `PLAN.md` | Behaviour spec |

</details>

---

<div align="center">
<sub>Made for <a href="https://obsidian.md">Obsidian</a> by <a href="https://github.com/Dryd33n">Dryd33n</a> · <a href="LICENSE">MIT license</a></sub>
</div>
