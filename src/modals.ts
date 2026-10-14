import { App, Modal, Setting, TFolder } from "obsidian";
import type TaggingFolderPlugin from "./main";
import { FolderRule, normalizeTag, validateTag } from "./rules";

export interface Choice<T extends string> {
	label: string;
	value: T;
	cta?: boolean;
	destructive?: boolean;
}

export interface ChoiceResult<T extends string> {
	value: T;
	remember: boolean;
}

export interface ChoiceOptions<T extends string> {
	title: string;
	message: string;
	choices: Choice<T>[];
	/** Show a "Don't ask again" checkbox. */
	allowRemember?: boolean;
}

/**
 * Obsidian tracks the focused window in the `activeWindow`/`activeDocument` globals and attaches
 * new modals there. On 1.14, closing a popout (e.g. Settings) without focus returning to the main
 * window can leave them pointing at the closed popout, so a modal would open invisibly and its
 * prompt would never resolve. Point them back at the main window in that case.
 */
function ensureLiveActiveWindow() {
	if (activeWindow.closed) {
		window.activeWindow = window;
		window.activeDocument = document;
	}
}

/** Modal that never opens into a closed window. */
class LiveModal extends Modal {
	constructor(app: App) {
		ensureLiveActiveWindow();
		super(app);
	}

	open() {
		ensureLiveActiveWindow();
		super.open();
	}
}

/** Generic prompt with buttons. Resolves null if dismissed without choosing. */
export class ChoiceModal<T extends string> extends LiveModal {
	private resolved = false;
	private remember = false;

	constructor(
		app: App,
		private opts: ChoiceOptions<T>,
		private resolve: (result: ChoiceResult<T> | null) => void,
	) {
		super(app);
	}

	static ask<T extends string>(app: App, opts: ChoiceOptions<T>): Promise<ChoiceResult<T> | null> {
		return new Promise((resolve) => new ChoiceModal(app, opts, resolve).open());
	}

	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("tagging-folder-modal");
		this.titleEl.setText(this.opts.title);
		contentEl.createEl("p", { text: this.opts.message });

		if (this.opts.allowRemember) {
			let note: HTMLElement;
			new Setting(contentEl).setName("Don't ask again").addToggle((toggle) =>
				toggle.setValue(false).onChange((value) => {
					this.remember = value;
					note.toggle(value);
				}),
			);
			note = contentEl.createEl("p", {
				cls: "setting-item-description tagging-folder-note",
				text: "You can change this later in the plugin settings.",
			});
			note.hide();
		}

		const buttons = new Setting(contentEl);
		for (const choice of this.opts.choices) {
			buttons.addButton((btn) => {
				btn.setButtonText(choice.label).onClick(() => this.finish(choice.value));
				if (choice.cta) btn.setCta();
				if (choice.destructive) btn.setDestructive();
				btn.buttonEl.dataset.choice = choice.value;
			});
		}
	}

	private finish(value: T) {
		this.resolved = true;
		this.resolve({ value, remember: this.remember });
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		if (!this.resolved) this.resolve(null);
	}
}

/** "Auto-tag notes within folder" modal: enable, edit, re-apply or disable a folder's rule. */
export class FolderModal extends LiveModal {
	constructor(
		app: App,
		private plugin: TaggingFolderPlugin,
		private folder: TFolder,
	) {
		super(app);
	}

	onOpen() {
		this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("tagging-folder-modal");
		this.titleEl.setText("Auto-tag notes within folder");

		const rule = this.plugin.getRule(this.folder.path);
		contentEl.createEl("p", { cls: "tagging-folder-folder", text: this.folder.path });
		contentEl.createEl("p", {
			cls: "tagging-folder-status " + (rule ? "is-enabled" : "is-disabled"),
			text: rule ? `Auto-tagging enabled (#${rule.tag})` : "Auto-tagging not enabled",
		});

		const draft: FolderRule = {
			folderPath: this.folder.path,
			tag: rule?.tag ?? "",
			includeSubfolders: rule?.includeSubfolders ?? true,
		};
		let tagExisting = true;

		let errorEl: HTMLElement;
		new Setting(contentEl)
			.setName("Tag name")
			.setDesc("Added to the tags property of each note.")
			.addText((text) => {
				text.setPlaceholder("Enter a tag").setValue(draft.tag).onChange((v) => {
					draft.tag = v;
					errorEl.setText("");
				});
				text.inputEl.addClass("tagging-folder-input");
				window.setTimeout(() => text.inputEl.focus(), 0);
			});
		errorEl = contentEl.createEl("p", { cls: "tagging-folder-error mod-warning" });

		if (!rule) {
			new Setting(contentEl)
				.setName("Tag existing notes")
				.setDesc("Tag notes already in this folder.")
				.addToggle((t) => t.setValue(true).onChange((v) => (tagExisting = v)));
		}

		new Setting(contentEl)
			.setName("Include subfolders")
			.addToggle((t) => t.setValue(draft.includeSubfolders).onChange((v) => (draft.includeSubfolders = v)));

		const validate = (): boolean => {
			draft.tag = normalizeTag(draft.tag);
			const error = validateTag(draft.tag);
			errorEl.setText(error ?? "");
			return !error;
		};

		const buttons = new Setting(contentEl);
		if (!rule) {
			buttons.addButton((btn) =>
				btn
					.setButtonText("Enable")
					.setCta()
					.onClick(async () => {
						if (!validate()) return;
						await this.plugin.enableRule(draft, tagExisting);
						this.close();
					}),
			);
			return;
		}

		buttons
			.addButton((btn) =>
				btn
					.setButtonText("Save")
					.setCta()
					.onClick(async () => {
						if (!validate()) return;
						if (await this.plugin.updateRule(rule, draft)) this.close();
					}),
			)
			.addButton((btn) =>
				btn.setButtonText("Re-apply tag").setTooltip("Tag every note currently in scope").onClick(async () => {
					await this.plugin.reapplyRule(rule);
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Disable auto-tagging")
					.setDestructive()
					.onClick(async () => {
						if (await this.plugin.disableRule(rule)) this.close();
					}),
			);
	}
}
