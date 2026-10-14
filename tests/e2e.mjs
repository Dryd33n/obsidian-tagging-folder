// End-to-end test: builds a fresh test vault, launches an isolated Obsidian instance
// (separate user-data dir, so your normal Obsidian and vaults are untouched), drives it
// over the Chrome DevTools Protocol, and checks note frontmatter after each flow.
//
//   npm run test:e2e            (set OBSIDIAN_PATH if Obsidian isn't in the default location)
//   KEEP_OPEN=1 npm run test:e2e   leave Obsidian running afterwards to poke around
//   E2E_DEBUG=1 npm run test:e2e   log the active window per test and dump open modals on failure
//
// Runs the newest Obsidian app version your install has downloaded (see latestAsar); override with OBSIDIAN_ASAR.

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vault = path.join(root, "test-vault");
const userData = path.join(os.tmpdir(), "folder-auto-tag-e2e-userdata");
const port = 9333;
const obsidianExe =
	process.env.OBSIDIAN_PATH ?? path.join(process.env.LOCALAPPDATA ?? "", "Obsidian", "Obsidian.exe");
const PLUGIN_ID = "folder-auto-tag";

// ------------------------------------------------------------------ vault setup

function write(rel, content) {
	const p = path.join(vault, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
}

function latestAsar(dir) {
	if (!fs.existsSync(dir)) return null;
	const versions = fs
		.readdirSync(dir)
		.map((f) => f.match(/^obsidian-(\d+)\.(\d+)\.(\d+)\.asar$/))
		.filter(Boolean)
		.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
	return versions.length ? path.join(dir, versions.at(-1)[0]) : null;
}

function buildVault() {
	fs.rmSync(vault, { recursive: true, force: true });
	write("Projects/alpha.md", "# Alpha\n");
	write("Projects/beta.md", "---\ntitle: Beta\ntags:\n  - existing\n---\nBody stays.\n");
	write("Projects/Work/standup.md", "Standup notes\n");
	write("Projects/Sub/s1.md", "s1\n");
	write("Projects/Sub/s2.md", "s2\n");
	write("Projects/Sub/s3.md", "s3\n");
	write("Projects/board.canvas", '{"nodes":[],"edges":[]}');
	write("Inbox/loose.md", "loose\n");
	write("Inbox/loose2.md", "loose2\n");
	write("Areas/health.md", "health\n");
	write("Temp/t.md", "t\n");
	write("root-note.md", "root\n");

	const pluginDir = path.join(vault, ".obsidian", "plugins", PLUGIN_ID);
	fs.mkdirSync(pluginDir, { recursive: true });
	for (const f of ["main.js", "manifest.json", "styles.css"]) {
		fs.copyFileSync(path.join(root, f), path.join(pluginDir, f));
	}
	fs.writeFileSync(path.join(vault, ".obsidian", "community-plugins.json"), JSON.stringify([PLUGIN_ID]));

	fs.rmSync(userData, { recursive: true, force: true });
	fs.mkdirSync(userData, { recursive: true });

	// The Obsidian launcher runs the newest obsidian-*.asar in its user-data dir, falling back to
	// the (older) version bundled with the installer. Copy the app package your normal install has
	// auto-updated to, so the isolated instance runs the same version. OBSIDIAN_ASAR overrides it.
	const asar = process.env.OBSIDIAN_ASAR ?? latestAsar(path.join(process.env.APPDATA ?? "", "obsidian"));
	if (asar) fs.copyFileSync(asar, path.join(userData, path.basename(asar)));

	fs.writeFileSync(
		path.join(userData, "obsidian.json"),
		JSON.stringify({ vaults: { e2etestvault0001: { path: vault, ts: Date.now(), open: true } } }),
	);
}

// ------------------------------------------------------------------ CDP client

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findVaultTarget() {
	for (let i = 0; i < 60; i++) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
			const page = targets.find((t) => t.type === "page" && t.url.startsWith("app://"));
			if (page) return page;
		} catch {}
		await sleep(500);
	}
	throw new Error("Obsidian window never appeared on the debugging port");
}

class Cdp {
	constructor(url) {
		this.id = 0;
		this.pending = new Map();
		this.ws = new WebSocket(url);
		this.ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data);
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
		};
		this.ready = new Promise((r, j) => {
			this.ws.onopen = r;
			this.ws.onerror = j;
		});
	}
	send(method, params = {}) {
		const id = ++this.id;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}
	async eval(body) {
		const r = await this.send("Runtime.evaluate", {
			expression: `(async () => { ${body} })()`,
			awaitPromise: true,
			returnByValue: true,
		});
		if (r.exceptionDetails) {
			throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		}
		return r.result.value;
	}
}

// Helpers installed in the Obsidian window.
const PAGE_HELPERS = `
window.__e2e = {
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	plugin: () => app.plugins.plugins["${PLUGIN_ID}"],
	async waitFor(fn, label, timeout = 5000) {
		const start = Date.now();
		let last;
		while (Date.now() - start < timeout) {
			try { last = await fn(); if (last) return last; } catch (e) { last = e; }
			await __e2e.sleep(50);
		}
		throw new Error("Timed out waiting for: " + label + (last instanceof Error ? " (" + last.message + ")" : ""));
	},
	async tags(p) {
		const f = app.vault.getAbstractFileByPath(p);
		if (!f) return null;
		const text = await app.vault.read(f);
		const m = text.match(/^---\\n([\\s\\S]*?)\\n---/);
		if (!m) return [];
		const lines = m[1].split("\\n");
		const i = lines.findIndex((l) => /^tags:/.test(l));
		if (i === -1) return [];
		const inline = lines[i].replace(/^tags:\\s*/, "");
		if (inline) return inline.replace(/[\\[\\]]/g, "").split(/[,\\s]+/).filter(Boolean).sort();
		const out = [];
		for (let j = i + 1; j < lines.length && /^\\s+-/.test(lines[j]); j++) out.push(lines[j].replace(/^\\s+-\\s*/, ""));
		return out.sort();
	},
	async expectTags(p, expected, timeout = 5000) {
		const want = JSON.stringify([...expected].sort());
		let got;
		try {
			await __e2e.waitFor(async () => (got = JSON.stringify(await __e2e.tags(p))) === want, p, timeout);
		} catch {
			throw new Error(p + ": expected tags " + want + ", got " + got);
		}
	},
	async read(p) { return app.vault.read(app.vault.getAbstractFileByPath(p)); },
	// Settings opens in a popout window on recent Obsidian versions, so search every open document.
	docs() {
		const set = new Set([document, activeDocument]);
		const tab = app.setting?.activeTab?.containerEl;
		if (tab?.isConnected) set.add(tab.ownerDocument);
		app.workspace.iterateAllLeaves?.((l) => set.add(l.view.containerEl.ownerDocument));
		return [...set];
	},
	all(sel) { return __e2e.docs().flatMap((d) => [...d.querySelectorAll(sel)]); },
	modals: () => __e2e.all(".modal.folder-auto-tag-modal"),
	async modal(label = "plugin modal") {
		return __e2e.waitFor(() => __e2e.modals().at(-1), label);
	},
	async choose(value, { remember = false } = {}) {
		const m = await __e2e.modal("choice modal for " + value);
		if (remember) m.querySelector(".checkbox-container").click();
		const btn = m.querySelector('[data-choice="' + value + '"]');
		if (!btn) throw new Error("no button " + value + " in modal: " + m.innerText);
		btn.click();
		await __e2e.waitFor(() => !m.isConnected, "modal to close");
	},
	setInput(el, value) {
		el.value = value;
		el.dispatchEvent(new Event("input", { bubbles: true }));
	},
	button(m, text) {
		const b = [...m.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
		if (!b) throw new Error("no button '" + text + "' in modal: " + m.innerText);
		return b;
	},
	async move(from, to) {
		await app.fileManager.renameFile(app.vault.getAbstractFileByPath(from), to);
	},
	assert(cond, msg) { if (!cond) throw new Error(msg); },
	closeAllModals() { __e2e.all(".modal-container:not(:has(.mod-settings))").forEach((c) => c.querySelector(".modal-close-button, .modal-header-button")?.click()); },
};
`;

// ------------------------------------------------------------------ tests

const tests = [
	[
		"Flow 1: right-click folder → Auto-tag… → enable with defaults (tags existing notes + subfolders)",
		`
		const el = await __e2e.waitFor(() => document.querySelector('.nav-folder-title[data-path="Projects"]'), "Projects in file explorer");
		const r = el.getBoundingClientRect();
		el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5, button: 2 }));
		const item = await __e2e.waitFor(() => [...document.querySelectorAll(".menu-item")].find((i) => i.textContent.trim() === "Auto-tag…"), "Auto-tag… menu item");
		item.click();
		const m = await __e2e.modal("folder modal");
		__e2e.assert(m.innerText.includes("Auto-tag notes within folder"), "modal title missing");
		__e2e.assert(m.innerText.includes("Auto-tagging not enabled"), "status should say not enabled");
		__e2e.assert(!m.innerText.includes("Disable auto-tagging"), "disable button must not show when not enabled");
		__e2e.setInput(m.querySelector(".folder-auto-tag-input"), "#project");
		__e2e.button(m, "Enable").click();
		await __e2e.waitFor(() => !m.isConnected, "modal to close");
		await __e2e.expectTags("Projects/alpha.md", ["project"]);
		await __e2e.expectTags("Projects/beta.md", ["existing", "project"]);
		await __e2e.expectTags("Projects/Work/standup.md", ["project"]);
		await __e2e.expectTags("Inbox/loose.md", []);
		const beta = await __e2e.read("Projects/beta.md");
		__e2e.assert(beta.includes("title: Beta") && beta.includes("Body stays."), "beta lost content: " + beta);
		const canvas = await __e2e.read("Projects/board.canvas");
		__e2e.assert(canvas === '{"nodes":[],"edges":[]}', "canvas was modified");
		`,
	],
	[
		"Flow 1: invalid tag shows an error and does not enable",
		`
		const el = document.querySelector('.nav-folder-title[data-path="Areas"]');
		el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
		(await __e2e.waitFor(() => [...document.querySelectorAll(".menu-item")].find((i) => i.textContent.trim() === "Auto-tag…"), "menu item")).click();
		const m = await __e2e.modal();
		__e2e.setInput(m.querySelector(".folder-auto-tag-input"), "two words");
		__e2e.button(m, "Enable").click();
		await __e2e.sleep(200);
		__e2e.assert(m.isConnected, "modal should stay open");
		__e2e.assert(m.querySelector(".folder-auto-tag-error").textContent.includes("spaces"), "missing validation error");
		__e2e.assert(!__e2e.plugin().getRule("Areas"), "rule should not be created");
		__e2e.setInput(m.querySelector(".folder-auto-tag-input"), "area");
		__e2e.button(m, "Enable").click();
		await __e2e.waitFor(() => !m.isConnected, "modal to close");
		await __e2e.expectTags("Areas/health.md", ["area"]);
		`,
	],
	[
		"Flow 1: 'tag existing notes' off leaves existing notes alone",
		`
		const p = __e2e.plugin();
		await p.enableRule({ folderPath: "Temp", tag: "temp", includeSubfolders: true }, false);
		await __e2e.sleep(300);
		await __e2e.expectTags("Temp/t.md", []);
		`,
	],
	[
		"Nesting: subfolder rule adds its tag on top of the parent's",
		`
		await __e2e.plugin().enableRule({ folderPath: "Projects/Work", tag: "work", includeSubfolders: true }, true);
		await __e2e.expectTags("Projects/Work/standup.md", ["project", "work"]);
		await __e2e.expectTags("Projects/alpha.md", ["project"]);
		`,
	],
	[
		"Flow 3: new note in an auto-tag folder gets all its tags",
		`
		await app.vault.create("Projects/Work/new.md", "fresh\\n");
		await __e2e.expectTags("Projects/Work/new.md", ["project", "work"]);
		await app.vault.create("Inbox/untagged.md", "x\\n");
		await __e2e.sleep(600);
		await __e2e.expectTags("Inbox/untagged.md", []);
		`,
	],
	[
		"Flow 3: tags survive a template overwriting the new note right after creation",
		`
		const f = await app.vault.create("Projects/templated.md", "");
		await __e2e.sleep(450); // after our 300ms tagging pass
		await app.vault.modify(f, "---\\ntitle: From template\\n---\\nTemplate body\\n");
		await __e2e.expectTags("Projects/templated.md", ["project"]);
		const text = await __e2e.read("Projects/templated.md");
		__e2e.assert(text.includes("title: From template") && text.includes("Template body"), "template content lost: " + text);
		`,
	],
	[
		"Flow 5: note dragged in from a normal folder gets the tag (no prompt)",
		`
		await __e2e.move("Inbox/loose.md", "Projects/loose.md");
		await __e2e.expectTags("Projects/loose.md", ["project"]);
		__e2e.assert(__e2e.modals().length === 0, "should not prompt when only gaining tags");
		`,
	],
	[
		"Leaving a folder (onLeave=ask): prompt, Remove + 'Don't ask again' saves the setting",
		`
		const p = __e2e.plugin();
		__e2e.assert(p.settings.onLeave === "ask", "default onLeave should be ask");
		await __e2e.move("Projects/Work/new.md", "Projects/new.md");
		const m = await __e2e.modal("leave prompt");
		__e2e.assert(m.innerText.includes("#work"), "prompt should name #work: " + m.innerText);
		const note = m.querySelector(".folder-auto-tag-note");
		__e2e.assert(note && note.style.display === "none", "settings note hidden until checkbox ticked");
		m.querySelector(".checkbox-container").click();
		__e2e.assert(note.style.display !== "none", "settings note should show once ticked");
		__e2e.assert(note.textContent.includes("settings"), "note should mention settings");
		await __e2e.choose("remove");
		await __e2e.expectTags("Projects/new.md", ["project"]);
		__e2e.assert(p.settings.onLeave === "remove", "onLeave should now be remove, got " + p.settings.onLeave);
		`,
	],
	[
		"Flow 4: dragged between auto-tag folders swaps the tags (onLeave=remove, no prompt)",
		`
		await __e2e.move("Projects/new.md", "Areas/new.md");
		await __e2e.expectTags("Areas/new.md", ["area"]);
		__e2e.assert(__e2e.modals().length === 0, "no prompt expected when policy is remove");
		`,
	],
	[
		"Leaving with onLeave=keep keeps the tag",
		`
		__e2e.plugin().settings.onLeave = "keep";
		await __e2e.move("Areas/new.md", "Inbox/new.md");
		await __e2e.sleep(800);
		await __e2e.expectTags("Inbox/new.md", ["area"]);
		`,
	],
	[
		"Dismissing the leave prompt (Esc) keeps the tag",
		`
		__e2e.plugin().settings.onLeave = "ask";
		await __e2e.move("Projects/alpha.md", "Inbox/alpha.md");
		const m = await __e2e.modal("leave prompt");
		__e2e.closeAllModals();
		await __e2e.waitFor(() => !m.isConnected, "close");
		await __e2e.sleep(300);
		await __e2e.expectTags("Inbox/alpha.md", ["project"]);
		await __e2e.move("Inbox/alpha.md", "Projects/alpha.md");
		await __e2e.sleep(800);
		`,
	],
	[
		"Bulk move: moving a folder of 3 notes out shows ONE prompt",
		`
		let maxOpen = 0;
		const obs = new MutationObserver(() => (maxOpen = Math.max(maxOpen, __e2e.modals().length)));
		obs.observe(document.body, { childList: true, subtree: true });
		await __e2e.move("Projects/Sub", "Inbox/Sub");
		const m = await __e2e.modal("bulk prompt");
		await __e2e.sleep(700);
		__e2e.assert(__e2e.modals().length === 1, "expected exactly one prompt, found " + __e2e.modals().length);
		__e2e.assert(m.innerText.includes("3 notes"), "prompt should mention 3 notes: " + m.innerText);
		await __e2e.choose("remove");
		obs.disconnect();
		__e2e.assert(maxOpen === 1, "max simultaneous prompts was " + maxOpen);
		for (const n of ["s1", "s2", "s3"]) await __e2e.expectTags("Inbox/Sub/" + n + ".md", []);
		`,
	],
	[
		"Folder rename: rule follows the folder, notes keep tags, no prompt",
		`
		const p = __e2e.plugin();
		await __e2e.move("Projects/Work", "Projects/Jobs");
		await __e2e.waitFor(() => p.getRule("Projects/Jobs"), "rule path updated");
		__e2e.assert(!p.getRule("Projects/Work"), "old rule path should be gone");
		await __e2e.sleep(400);
		__e2e.assert(__e2e.modals().length === 0, "no prompt expected on folder rename");
		await __e2e.expectTags("Projects/Jobs/standup.md", ["project", "work"]);
		const saved = JSON.parse(await app.vault.adapter.read(".obsidian/plugins/${PLUGIN_ID}/data.json"));
		__e2e.assert(saved.rules.some((r) => r.folderPath === "Projects/Jobs"), "rename not persisted");
		`,
	],
	[
		"Flow 6: settings tab lists rules with edit/disable buttons and both policy dropdowns",
		`
		app.setting.open();
		app.setting.openTabById("${PLUGIN_ID}");
		const c = await __e2e.waitFor(() => __e2e.all(".folder-auto-tag-rule")[0]?.closest(".vertical-tab-content"), "settings tab");
		const names = [...c.querySelectorAll(".folder-auto-tag-rule .setting-item-name")].map((e) => e.textContent);
		__e2e.assert(JSON.stringify(names) === JSON.stringify(["Areas", "Projects", "Projects/Jobs", "Temp"]), "rules listed: " + names);
		__e2e.assert(c.querySelectorAll(".folder-auto-tag-rule .clickable-icon").length === 8, "expected gear + X per rule");
		__e2e.assert(c.querySelectorAll("select:not(.is-measuring)").length === 2, "expected two policy dropdowns");
		// Gear opens the edit modal for that folder.
		c.querySelectorAll(".folder-auto-tag-rule")[0].querySelector(".clickable-icon").click();
		const m = await __e2e.modal("edit modal");
		__e2e.assert(m.innerText.includes("Auto-tagging enabled (#area)"), "edit modal status: " + m.innerText);
		__e2e.assert(m.innerText.includes("Disable auto-tagging"), "disable button should show");
		m.querySelector(".modal-close-button, .modal-header-button").click();
		app.setting.close();
		`,
	],
	[
		"Prompts still appear when Obsidian's activeWindow points at a closed popout (1.14)",
		`
		// Reproduce the stale state deterministically (window.open is blocked in Obsidian): point the
		// globals at a closed-window stand-in whose document isn't rendered anywhere.
		window.activeWindow = { closed: true };
		window.activeDocument = document.implementation.createHTMLDocument("closed popout");
		const p = __e2e.plugin();
		p.settings.onLeave = "ask";
		await __e2e.move("Projects/loose.md", "Inbox/loose.md");
		const m = await __e2e.waitFor(() => document.querySelector(".modal.folder-auto-tag-modal"), "prompt in the main window");
		__e2e.assert(activeWindow === window, "activeWindow should be restored to the main window");
		await __e2e.choose("keep");
		await __e2e.expectTags("Inbox/loose.md", ["project"]);
		await __e2e.move("Inbox/loose.md", "Projects/loose.md");
		await __e2e.sleep(800);
		`,
	],
	[
		"Flow 6: renaming a tag asks Replace/Add; Replace swaps it on existing notes",
		`
		const p = __e2e.plugin();
		const pending = p.updateRule(p.getRule("Areas"), { folderPath: "Areas", tag: "zone", includeSubfolders: true });
		const m = await __e2e.modal("rename prompt");
		__e2e.assert(m.innerText.includes("#area") && m.innerText.includes("#zone"), m.innerText);
		await __e2e.choose("replace");
		__e2e.assert(await pending, "update should succeed");
		await __e2e.expectTags("Areas/health.md", ["zone"]);
		`,
	],
	[
		"Flow 6: renaming a tag with Add keeps the old tag",
		`
		const p = __e2e.plugin();
		const pending = p.updateRule(p.getRule("Areas"), { folderPath: "Areas", tag: "region", includeSubfolders: true });
		await __e2e.choose("add");
		await pending;
		await __e2e.expectTags("Areas/health.md", ["region", "zone"]);
		`,
	],
	[
		"Flow 6: turning off 'include subfolders' follows the leave policy",
		`
		const p = __e2e.plugin();
		p.settings.onLeave = "remove";
		await p.updateRule(p.getRule("Projects"), { folderPath: "Projects", tag: "project", includeSubfolders: false });
		await __e2e.expectTags("Projects/Jobs/standup.md", ["work"]);
		await __e2e.expectTags("Projects/alpha.md", ["project"]);
		await p.updateRule(p.getRule("Projects"), { folderPath: "Projects", tag: "project", includeSubfolders: true });
		await __e2e.expectTags("Projects/Jobs/standup.md", ["project", "work"]);
		`,
	],
	[
		"Flow 2: Disable from the folder modal (ask) → Keep leaves tags in place",
		`
		const el = document.querySelector('.nav-folder-title[data-path="Projects/Jobs"]')
			?? (document.querySelector('.nav-folder-title[data-path="Projects"]').click(), await __e2e.waitFor(() => document.querySelector('.nav-folder-title[data-path="Projects/Jobs"]'), "Jobs folder"));
		el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
		(await __e2e.waitFor(() => [...document.querySelectorAll(".menu-item")].find((i) => i.textContent.trim() === "Auto-tag…"), "menu item")).click();
		const m = await __e2e.modal("folder modal");
		__e2e.assert(m.innerText.includes("Auto-tagging enabled (#work)"), m.innerText);
		__e2e.button(m, "Disable auto-tagging").click();
		await __e2e.waitFor(() => __e2e.modals().length === 2, "disable prompt");
		await __e2e.choose("keep");
		await __e2e.waitFor(() => !m.isConnected, "folder modal to close");
		__e2e.assert(!__e2e.plugin().getRule("Projects/Jobs"), "rule should be removed");
		await __e2e.expectTags("Projects/Jobs/standup.md", ["project", "work"]);
		`,
	],
	[
		"Flow 6: X in settings (ask) → Remove strips tags; tags still owed by another rule stay",
		`
		const p = __e2e.plugin();
		await p.enableRule({ folderPath: "Projects/Jobs", tag: "project", includeSubfolders: true }, true); // shares tag with parent
		app.setting.open();
		app.setting.openTabById("${PLUGIN_ID}");
		const rows = await __e2e.waitFor(() => __e2e.all(".folder-auto-tag-rule"), "rule rows");
		const row = rows.find((r) => r.querySelector(".setting-item-name").textContent === "Projects/Jobs");
		row.querySelectorAll(".clickable-icon")[1].click();
		await __e2e.sleep(300);
		__e2e.assert(__e2e.modals().length === 0, "no prompt: Jobs notes still get #project from parent rule");
		__e2e.assert(!p.getRule("Projects/Jobs"), "rule removed");
		const rows2 = await __e2e.waitFor(() => __e2e.all(".folder-auto-tag-rule").length === 3 && __e2e.all(".folder-auto-tag-rule"), "list refreshed");
		rows2.find((r) => r.querySelector(".setting-item-name").textContent === "Projects").querySelectorAll(".clickable-icon")[1].click();
		const m = await __e2e.modal("disable prompt");
		__e2e.assert(m.innerText.includes("Remove #project"), m.innerText);
		await __e2e.choose("remove", { remember: true });
		app.setting.close();
		await __e2e.expectTags("Projects/alpha.md", []);
		await __e2e.expectTags("Projects/beta.md", ["existing"]);
		await __e2e.expectTags("Projects/Jobs/standup.md", ["work"]);
		__e2e.assert(p.settings.onDisable === "remove", "don't-ask-again should save onDisable=remove");
		`,
	],
	[
		"Deleting a folder removes its rule",
		`
		const p = __e2e.plugin();
		await app.vault.delete(app.vault.getAbstractFileByPath("Temp"), true);
		await __e2e.waitFor(() => !p.getRule("Temp"), "Temp rule removed");
		`,
	],
	[
		"Settings persist across a plugin reload",
		`
		await app.plugins.disablePlugin("${PLUGIN_ID}");
		await app.plugins.enablePlugin("${PLUGIN_ID}");
		const p = await __e2e.waitFor(() => __e2e.plugin()?.settings && __e2e.plugin(), "plugin reloaded");
		__e2e.assert(JSON.stringify(p.settings.rules.map((r) => r.folderPath).sort()) === '["Areas"]', JSON.stringify(p.settings.rules));
		__e2e.assert(p.settings.onDisable === "remove" && p.settings.onLeave === "remove", "policies persisted");
		await app.vault.create("Areas/after-reload.md", "x\\n");
		await __e2e.expectTags("Areas/after-reload.md", ["region"]); // #zone was only kept on existing notes
		`,
	],
];

// ------------------------------------------------------------------ runner

async function main() {
	if (!fs.existsSync(obsidianExe)) throw new Error(`Obsidian not found at ${obsidianExe}; set OBSIDIAN_PATH`);
	buildVault();
	console.log(`Test vault: ${vault}`);

	// The test window usually sits behind other windows. Chromium throttles timers and animation
	// frames in occluded/background windows, and the tests rely on timing (batching, delays), so
	// keep the test window running at full speed.
	const args = [
		`--user-data-dir=${userData}`,
		`--remote-debugging-port=${port}`,
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--disable-background-timer-throttling",
	];
	const child = spawn(obsidianExe, args, {
		detached: !!process.env.KEEP_OPEN,
		stdio: "ignore",
	});

	let failures = 0;
	try {
		const target = await findVaultTarget();
		const cdp = new Cdp(target.webSocketDebuggerUrl);
		await cdp.ready;

		await cdp.eval(`
			const start = Date.now();
			while (!(window.app && app.workspace && app.workspace.layoutReady)) {
				if (Date.now() - start > 30000) throw new Error("workspace never became ready");
				await new Promise((r) => setTimeout(r, 200));
			}
			document.querySelectorAll(".modal-container").forEach((c) => c.querySelector(".modal-close-button, .modal-header-button")?.click());
			if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
			if (!app.plugins.plugins["${PLUGIN_ID}"]) await app.plugins.enablePluginAndSave("${PLUGIN_ID}");
			const s = Date.now();
			while (!app.plugins.plugins["${PLUGIN_ID}"]?._loaded) {
				if (Date.now() - s > 10000) throw new Error("plugin failed to load");
				await new Promise((r) => setTimeout(r, 100));
			}
		`);
		await cdp.eval(PAGE_HELPERS);
		const visibility = await cdp.eval(`return document.visibilityState`);
		if (visibility !== "visible") throw new Error(`Test window is "${visibility}"; animations and timers would be throttled`);
		const version = await cdp.eval(`return require("electron").ipcRenderer.sendSync("version")`).catch(() => "?");
		console.log(`Obsidian ${version}, plugin loaded.\n`);

		for (const [name, body] of tests) {
			if (process.env.E2E_DEBUG) {
				const where = await cdp.eval(`return activeDocument === document ? "main" : "other: " + activeDocument.title + (activeWindow.closed ? " (closed)" : "")`);
				console.log(`      [activeDocument before test: ${where}]`);
			}
			try {
				await cdp.eval(body);
				console.log(`  ✔ ${name}`);
			} catch (e) {
				failures++;
				console.log(`  ✘ ${name}\n      ${e.message.split("\n")[0]}`);
				if (process.env.E2E_DEBUG) {
					const open = await cdp
						.eval(
							`return __e2e.docs().flatMap((d) => [...d.querySelectorAll(".modal-container")].map((c) =>
								(d === document ? "main" : "popout") + " | " + c.className + " | " +
								c.querySelector(".modal-title")?.textContent + " | " + c.querySelector(".modal-content")?.innerText.slice(0, 80).replace(/\\n/g, " ")))`,
						)
						.catch((err) => [String(err)]);
					for (const line of open) console.log(`      open modal: ${line}`);
				}
				await cdp.eval(`__e2e.closeAllModals(); app.setting?.close();`).catch(() => {});
				await sleep(300);
			}
		}

		const errors = await cdp.eval(`return (window.__e2eErrors ?? []).length`).catch(() => 0);
		if (errors) console.log(`  (${errors} page errors captured)`);
	} finally {
		if (process.env.KEEP_OPEN) {
			console.log("\nKEEP_OPEN set: leaving the test Obsidian instance running.");
		} else {
			try {
				execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
			} catch {}
		}
	}

	console.log(`\n${tests.length - failures}/${tests.length} passed`);
	process.exit(failures ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
