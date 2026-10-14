import { Notice, Plugin, TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import { ChoiceModal, FolderModal } from "./modals";
import {
	editFrontmatterTags,
	FolderRule,
	isInScope,
	isPolicy,
	isRule,
	Policy,
	readFrontmatterTags,
	removeRulesUnder,
	renameRuleFolders,
	tagDifference,
	tagKey,
	tagsForPath,
} from "./rules";
import { TaggingFolderSettingTab } from "./settings";

export interface TaggingFolderSettings {
	rules: FolderRule[];
	/** What to do with existing tags when a folder's auto-tagging is disabled. */
	onDisable: Policy;
	/** What to do when a note leaves an auto-tag folder's scope. */
	onLeave: Policy;
}

const DEFAULT_SETTINGS: TaggingFolderSettings = {
	rules: [],
	onDisable: "ask",
	onLeave: "ask",
};

/** Delay before tagging a new note, so template plugins can write their frontmatter first. */
const CREATE_DELAY_MS = 300;
/** How long after creation we keep re-asserting tags if something (e.g. a template) overwrites them. */
const CREATE_GUARD_MS = 10_000;
/** Rename events are batched so a folder move produces one prompt, not one per note. */
const RENAME_BATCH_MS = 500;

interface TagChange {
	file: TFile;
	add: string[];
	remove: string[];
}

export default class TaggingFolderPlugin extends Plugin {
	settings: TaggingFolderSettings;
	private settingTab: TaggingFolderSettingTab;
	private pendingRenames: { file: TAbstractFile; oldPath: string }[] = [];
	private renameTimer: number | null = null;
	private recentlyCreated = new Map<TFile, number>();

	async onload() {
		await this.loadSettings();
		this.settingTab = new TaggingFolderSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFolder) || file.isRoot()) return;
				menu.addItem((item) =>
					item
						.setTitle("Auto-tag…")
						.setIcon("tags")
						.onClick(() => new FolderModal(this.app, this, file).open()),
				);
			}),
		);

		// Registered after layout is ready so the startup indexing burst of
		// "create" events doesn't tag the whole vault.
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on("create", (file) => this.onCreate(file)));
			this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
			this.registerEvent(this.app.vault.on("delete", (file) => this.onDelete(file)));
			this.registerEvent(
				this.app.metadataCache.on("changed", (file) => this.onMetadataChanged(file)),
			);
		});
	}

	onunload() {
		if (this.renameTimer !== null) window.clearTimeout(this.renameTimer);
	}

	async loadSettings() {
		const data = ((await this.loadData()) ?? {}) as Partial<Record<keyof TaggingFolderSettings, unknown>>;
		this.settings = {
			rules: Array.isArray(data.rules) ? data.rules.filter(isRule).map((r) => ({ ...r })) : [],
			onDisable: isPolicy(data.onDisable) ? data.onDisable : DEFAULT_SETTINGS.onDisable,
			onLeave: isPolicy(data.onLeave) ? data.onLeave : DEFAULT_SETTINGS.onLeave,
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.settingTab.refresh();
	}

	getRule(folderPath: string): FolderRule | undefined {
		return this.settings.rules.find((r) => r.folderPath === folderPath);
	}

	// ---------------------------------------------------------------- rule actions

	async enableRule(draft: FolderRule, tagExisting: boolean): Promise<void> {
		if (this.getRule(draft.folderPath)) return;
		const rule = { ...draft };
		this.settings.rules.push(rule);
		await this.saveSettings();

		let count = 0;
		if (tagExisting) count = await this.applyChanges(this.filesInScope(rule).map((file) => ({ file, add: [rule.tag], remove: [] })));
		new Notice(
			tagExisting
				? `Auto-tagging enabled. Tagged ${count} ${plural(count, "note")} with #${rule.tag}.`
				: `Auto-tagging enabled for ${rule.folderPath} (#${rule.tag}).`,
		);
	}

	/** Returns false if the user cancelled. */
	async disableRule(rule: FolderRule): Promise<boolean> {
		const newRules = this.settings.rules.filter((r) => r !== rule);
		const lost = this.diff(this.settings.rules, newRules, rule.folderPath).filter((c) => c.remove.length);

		let removeTags = false;
		if (lost.length) {
			const decision = await this.resolvePolicy("onDisable", {
				title: "Disable auto-tagging",
				message: `Remove #${rule.tag} from ${lost.length} existing ${plural(lost.length, "note")}?`,
				removeLabel: "Remove tags",
				keepLabel: "Keep tags",
			});
			if (decision === null) return false;
			removeTags = decision === "remove";
		}

		this.settings.rules = newRules;
		await this.saveSettings();
		const count = removeTags ? await this.applyChanges(lost.map((c) => ({ ...c, add: [] }))) : 0;
		new Notice(
			removeTags
				? `Auto-tagging disabled. Removed #${rule.tag} from ${count} ${plural(count, "note")}.`
				: `Auto-tagging disabled for ${rule.folderPath}.`,
		);
		return true;
	}

	/** Apply edits from the folder modal. Returns false if the user cancelled. */
	async updateRule(rule: FolderRule, draft: FolderRule): Promise<boolean> {
		if (draft.tag === rule.tag && draft.includeSubfolders === rule.includeSubfolders) return true;

		const updated = { ...draft, folderPath: rule.folderPath };
		const newRules = this.settings.rules.map((r) => (r === rule ? updated : r));
		const changes = this.diff(this.settings.rules, newRules, rule.folderPath);

		// Notes that keep this folder in scope but lose the old tag are losing it because of the rename.
		const renamed = changes.filter((c) => c.remove.length && isInScope(c.file.path, updated));
		const left = changes.filter((c) => c.remove.length && !isInScope(c.file.path, updated));

		let replaceOld = true;
		if (renamed.length) {
			const result = await ChoiceModal.ask(this.app, {
				title: "Tag name changed",
				message: `${renamed.length} ${plural(renamed.length, "note")} already ${renamed.length === 1 ? "has" : "have"} #${rule.tag}. Replace it with #${updated.tag}, or keep #${rule.tag} and add #${updated.tag}?`,
				choices: [
					{ label: "Replace", value: "replace", cta: true },
					{ label: "Add", value: "add" },
					{ label: "Cancel", value: "cancel" },
				],
			});
			if (!result || result.value === "cancel") return false;
			replaceOld = result.value === "replace";
		}

		let removeLeft = false;
		if (left.length) {
			removeLeft = (await this.resolveLeave(left)) === "remove";
		}

		Object.assign(rule, updated);
		await this.saveSettings();

		const toApply: TagChange[] = changes.map((c) => {
			const removing = (renamed.includes(c) && replaceOld) || (left.includes(c) && removeLeft);
			return { file: c.file, add: c.add, remove: removing ? c.remove : [] };
		});
		await this.applyChanges(toApply);
		new Notice(`Auto-tag settings saved for ${rule.folderPath}.`);
		return true;
	}

	async reapplyRule(rule: FolderRule): Promise<void> {
		const count = await this.applyChanges(this.filesInScope(rule).map((file) => ({ file, add: [rule.tag], remove: [] })));
		new Notice(`Tagged ${count} ${plural(count, "note")} with #${rule.tag}.`);
	}

	// ---------------------------------------------------------------- vault events

	private onCreate(file: TAbstractFile) {
		if (!isMarkdown(file)) return;
		if (!tagsForPath(file.path, this.settings.rules).length) return;
		this.recentlyCreated.set(file, Date.now());
		window.setTimeout(() => void this.ensureTags(file), CREATE_DELAY_MS);
	}

	/** Re-add tags if something (typically a template) overwrote a freshly created note. */
	private onMetadataChanged(file: TFile) {
		const created = this.recentlyCreated.get(file);
		if (created === undefined) return;
		if (Date.now() - created > CREATE_GUARD_MS) {
			this.recentlyCreated.delete(file);
			return;
		}
		void this.ensureTags(file);
	}

	private async ensureTags(file: TFile) {
		if (!this.app.vault.getAbstractFileByPath(file.path)) return;
		const tags = tagsForPath(file.path, this.settings.rules);
		if (tags.length) await this.applyChanges([{ file, add: tags, remove: [] }]);
	}

	private onRename(file: TAbstractFile, oldPath: string) {
		this.pendingRenames.push({ file, oldPath });
		if (this.renameTimer !== null) window.clearTimeout(this.renameTimer);
		this.renameTimer = window.setTimeout(() => {
			this.renameTimer = null;
			void this.flushRenames();
		}, RENAME_BATCH_MS);
	}

	private async flushRenames() {
		const events = this.pendingRenames;
		this.pendingRenames = [];

		// Scope before the move is judged against the rules as they were before any folder renames in this batch.
		const before = this.settings.rules.map((r) => ({ ...r }));
		let rulesChanged = false;
		for (const { file, oldPath } of events) {
			if (file instanceof TFolder) {
				rulesChanged = renameRuleFolders(this.settings.rules, oldPath, file.path) || rulesChanged;
			}
		}
		if (rulesChanged) await this.saveSettings();

		// A note renamed several times in one batch: compare its first old path to where it ended up.
		const firstOldPath = new Map<TFile, string>();
		for (const { file, oldPath } of events) {
			if (isMarkdown(file) && !firstOldPath.has(file)) firstOldPath.set(file, oldPath);
		}

		const changes: TagChange[] = [];
		for (const [file, oldPath] of firstOldPath) {
			if (!this.app.vault.getAbstractFileByPath(file.path)) continue;
			const oldTags = tagsForPath(oldPath, before);
			const newTags = tagsForPath(file.path, this.settings.rules);
			const add = tagDifference(newTags, oldTags);
			const remove = this.presentTags(file, tagDifference(oldTags, newTags));
			if (add.length || remove.length) changes.push({ file, add, remove });
		}
		if (!changes.length) return;

		const left = changes.filter((c) => c.remove.length);
		const removeLeft = left.length ? (await this.resolveLeave(left)) === "remove" : false;
		await this.applyChanges(changes.map((c) => ({ ...c, remove: removeLeft ? c.remove : [] })));
	}

	private async onDelete(file: TAbstractFile) {
		if (!(file instanceof TFolder)) return;
		const remaining = removeRulesUnder(this.settings.rules, file.path);
		if (remaining.length === this.settings.rules.length) return;
		this.settings.rules = remaining;
		await this.saveSettings();
	}

	// ---------------------------------------------------------------- helpers

	/**
	 * The subset of `tags` the note actually carries. Removal is only offered for tags that are
	 * present, so prompts never count notes that wouldn't change (e.g. a folder enabled without
	 * tagging existing notes, or a tag the user already removed by hand).
	 */
	private presentTags(file: TFile, tags: string[]): string[] {
		if (!tags.length) return tags;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const have = new Set(readFrontmatterTags(fm ? { ...(fm as Record<string, unknown>) } : {}).map(tagKey));
		return tags.filter((t) => have.has(tagKey(t)));
	}

	/** Markdown notes inside a folder, at any depth. */
	private notesUnder(folderPath: string): TFile[] {
		const folder = this.app.vault.getFolderByPath(folderPath);
		const out: TFile[] = [];
		if (folder) Vault.recurseChildren(folder, (f) => isMarkdown(f) && out.push(f));
		return out;
	}

	private filesInScope(rule: FolderRule): TFile[] {
		return this.notesUnder(rule.folderPath).filter((f) => isInScope(f.path, rule));
	}

	/**
	 * Per-note tag changes implied by switching from one rule set to another.
	 * Only the rule for `folderPath` may differ between the two sets, so only notes under it can change.
	 */
	private diff(oldRules: FolderRule[], newRules: FolderRule[], folderPath: string): TagChange[] {
		const out: TagChange[] = [];
		for (const file of this.notesUnder(folderPath)) {
			const oldTags = tagsForPath(file.path, oldRules);
			const newTags = tagsForPath(file.path, newRules);
			const add = tagDifference(newTags, oldTags);
			const remove = this.presentTags(file, tagDifference(oldTags, newTags));
			if (add.length || remove.length) out.push({ file, add, remove });
		}
		return out;
	}

	private async resolveLeave(left: TagChange[]): Promise<"remove" | "keep"> {
		const counts = new Map<string, { tag: string; n: number }>();
		for (const c of left) {
			for (const tag of c.remove) {
				const entry = counts.get(tagKey(tag)) ?? { tag, n: 0 };
				entry.n++;
				counts.set(tagKey(tag), entry);
			}
		}
		const summary = [...counts.values()].map((e) => (left.length > 1 ? `#${e.tag} (${e.n})` : `#${e.tag}`)).join(", ");
		const decision = await this.resolvePolicy("onLeave", {
			title: "Note moved out of auto-tag folder",
			message:
				left.length === 1
					? `"${left[0].file.basename}" left an auto-tag folder. Remove ${summary} from it?`
					: `${left.length} notes left auto-tag folders: ${summary}. Remove these tags from them?`,
			removeLabel: "Remove tag",
			keepLabel: "Keep tag",
		});
		// Dismissing the prompt is the non-destructive choice.
		return decision ?? "keep";
	}

	/** Resolve a policy setting, prompting if it's "ask". Returns null if the prompt was dismissed. */
	private async resolvePolicy(
		key: "onDisable" | "onLeave",
		opts: { title: string; message: string; removeLabel: string; keepLabel: string },
	): Promise<"remove" | "keep" | null> {
		const policy = this.settings[key];
		if (policy !== "ask") return policy;
		const result = await ChoiceModal.ask(this.app, {
			title: opts.title,
			message: opts.message,
			allowRemember: true,
			choices: [
				{ label: opts.removeLabel, value: "remove", cta: true },
				{ label: opts.keepLabel, value: "keep" },
			],
		});
		if (!result) return null;
		if (result.remember) {
			this.settings[key] = result.value;
			await this.saveSettings();
		}
		return result.value;
	}

	/** Writes tag changes to frontmatter. Returns the number of notes actually modified. */
	private async applyChanges(changes: TagChange[]): Promise<number> {
		let modified = 0;
		for (const { file, add, remove } of changes) {
			if (!add.length && !remove.length) continue;
			// Skip the write entirely when the cached frontmatter shows nothing would change.
			const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (cached && !editFrontmatterTags({ ...(cached as Record<string, unknown>) }, add, remove)) continue;
			if (!cached && !add.length) continue;

			let changed = false;
			try {
				await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
					changed = editFrontmatterTags(fm, add, remove);
				});
			} catch (e) {
				console.error(`Tagging Folder: failed to update ${file.path}`, e);
				new Notice(`Tagging Folder: couldn't update "${file.path}" (invalid frontmatter?)`);
				continue;
			}
			if (changed) modified++;
		}
		return modified;
	}
}

function isMarkdown(file: TAbstractFile): file is TFile {
	return file instanceof TFile && file.extension === "md";
}

function plural(n: number, word: string): string {
	return n === 1 ? word : word + "s";
}
