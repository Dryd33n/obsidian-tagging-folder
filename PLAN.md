# Folder Auto-Tag — Obsidian Plugin Spec

Items marked **(default)** were design defaults chosen during planning rather than explicit requirements.

## Core model

- Each auto-tag folder has a **rule**:
  `{ folderPath, tag, includeSubfolders (default true) }`
- One tag per folder **(default)**. Two folders may share the same tag.
- Tags go in the **frontmatter `tags:` property** via `app.fileManager.processFrontMatter`. The note body is never touched.
- Only `.md` files are tagged. Canvas, PDF, images and other files are ignored **(default)**.
- **Scope of a note**: a note is in scope of every rule whose folder is its direct parent, plus every rule on an ancestor folder that has `includeSubfolders` on.
- **Nesting**: a note gets the tags of *every* rule it is in scope of. A note in `Projects/Work/` gets `#project` and `#work`.
- **Tag input**: a leading `#` is stripped and the name is checked against Obsidian tag rules (no spaces, can't be purely numeric, allowed chars `A-Za-z0-9_-/`). Nested tags like `area/work` are allowed.
- "Tag existing items" is an **action run when you save**, not a stored setting **(default)**. It tags every note already in scope at that moment.

## Settings (global)

| Setting | Options | Default |
|---|---|---|
| When disabling a folder's auto-tagging | Ask / Remove tags / Keep tags | Ask |
| When a note leaves an auto-tag folder | Ask / Remove tag / Keep tag | Ask |

- While a setting is on **Ask**, its prompt has a **"Don't ask again"** checkbox. Checking it saves the chosen answer to the setting above and shows the note: *"You can change this later in Folder Auto-Tag settings."*

## Flows

### 1. Enable auto-tagging on a folder
Right-click a folder → **Auto-tag…** → modal titled "Auto-tag notes within folder".
- Status line: "Auto-tagging not enabled"
- Fields: tag name, ☑ tag existing notes, ☑ include subfolders
- **Enable** button → saves the rule. If "tag existing notes" is checked, it also tags every note in scope and shows a Notice such as "Tagged 42 notes with #project".

### 2. Disable from the folder menu
Same menu item and modal. The status line reads "Auto-tagging enabled (#tag)".
- The fields can be edited here too, with the same behaviour as flow 6 **(default)**.
- **Disable auto-tagging** button (shown only when enabled) → follows the *disable* setting:
  - Ask → modal: "Remove #tag from N existing notes?" with [Remove] [Keep] and ☐ Don't ask again
  - Remove / Keep → acts with no prompt

### 3. New note created in an auto-tag folder
The note gets every tag for its scope.
- Listener: `vault.on('create')`, registered inside `onLayoutReady` so the startup indexing burst doesn't tag the whole vault.
- **Risk**: Templater and core Templates may write the frontmatter right after the note is created and overwrite our tag. To handle this, apply the tag after a short delay (~300 ms) and merge with whatever frontmatter exists then, never replacing it **(default)**.

### 4/5. Note moved INTO an auto-tag folder
On `vault.on('rename')` (which covers drag-drop, "Move file to…", path renames and other plugins), compare the old scope with the new scope:
- **Tags gained** (in the new scope, not the old one) → add them.
- **Tags lost** (in the old scope, not the new one) → follow the *leaves folder* setting (Ask / Remove / Keep).
- Tags in both scopes are left alone. So moving `Projects/A` to `Projects/Work/A` only adds `#work`.

This one rule covers flow 4 (between auto-tag folders), flow 5 (from a normal folder), and moving a note out to a normal folder.

**Bulk moves**: moving a folder with 50 notes fires 50 rename events. Batch events over ~500 ms and show **one** prompt per batch, e.g. "12 notes left #project. Remove the tag?" **(default)**.

### 6. Settings tab
- Lists every rule: folder path, `#tag`, ⚙, ✕
- ⚙ opens the same edit modal as flow 2. Fields:
  - **Tag name**. If it changed, ask: "Replace #old with #new on existing notes, or keep #old and add #new?" [Replace] [Add] [Cancel]
  - **Include subfolders**. Turning it **off** counts as subfolder notes leaving scope (follows the *leaves folder* setting). Turning it **on** tags the subfolder notes **(default)**.
  - **Re-apply tag to existing notes** button (replaces the "tag existing items" checkbox, which only makes sense at creation time) **(default)**.
- ✕ runs the same disable logic as flow 2, honouring the *disable* setting.
- Below the list are the two global settings from the table above.

## Folder lifecycle (not in the original plan)
- **Folder renamed or moved**: update `folderPath` for that rule and every rule inside it. Notes keep their tags because the scope hasn't changed.
- **Folder deleted**: delete the rule silently.
- Rules are keyed by path and saved with `saveData()`.

## Known limitations / out of scope for v1
- **Manual tag collision**: if a note already had `#project` before auto-tagging, disabling or moving it out can remove that tag, because we don't track who added it. Accepted for v1 **(default)**. The fix would be recording which notes the plugin tagged.
- **Changes made while the plugin is off** (e.g. files moved by sync or the OS file manager): there is no reconciliation at startup. The "Re-apply" button can fix it by hand.
- **Mobile**: should work since nothing uses desktop-only APIs. Set `isDesktopOnly: false` and test it.

## Tech
- TypeScript, from the official `obsidian-sample-plugin` template, built with esbuild.
- Context menu: `workspace.on('file-menu')`, filtered to `TFolder`.
- Modals: `Modal` subclasses. Settings: `PluginSettingTab`.
