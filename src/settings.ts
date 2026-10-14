import { App, PluginSettingTab, Setting, TFolder } from "obsidian";
import type TaggingFolderPlugin from "./main";
import { FolderModal } from "./modals";
import { Policy } from "./rules";

export class TaggingFolderSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: TaggingFolderPlugin,
	) {
		super(app, plugin);
	}

	/** Re-render if the tab is currently showing (called after settings change elsewhere). */
	refresh() {
		if (this.containerEl.isConnected) this.display();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Auto-tag folders").setHeading();

		const rules = [...this.plugin.settings.rules].sort((a, b) => a.folderPath.localeCompare(b.folderPath));
		if (!rules.length) {
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text: "No folders have auto-tagging enabled. Right-click a folder and choose \"Auto-tag…\" to set one up.",
			});
		}

		for (const rule of rules) {
			new Setting(containerEl)
				.setName(rule.folderPath)
				.setDesc(`#${rule.tag}${rule.includeSubfolders ? " · includes subfolders" : ""}`)
				.setClass("tagging-folder-rule")
				.addExtraButton((btn) =>
					btn
						.setIcon("settings")
						.setTooltip("Edit")
						.onClick(() => {
							const folder = this.app.vault.getAbstractFileByPath(rule.folderPath);
							if (folder instanceof TFolder) new FolderModal(this.app, this.plugin, folder).open();
						}),
				)
				.addExtraButton((btn) =>
					btn
						.setIcon("x")
						.setTooltip("Disable auto-tagging")
						.onClick(() => void this.plugin.disableRule(rule)),
				);
		}

		new Setting(containerEl).setName("Behaviour").setHeading();

		const policyOptions = (removeLabel: string, keepLabel: string): Record<Policy, string> => ({
			ask: "Ask every time",
			remove: removeLabel,
			keep: keepLabel,
		});

		new Setting(containerEl)
			.setName("When disabling a folder's auto-tagging")
			.setDesc("What happens to the tag on notes that already have it.")
			.addDropdown((dd) =>
				dd
					.addOptions(policyOptions("Remove tags", "Keep tags"))
					.setValue(this.plugin.settings.onDisable)
					.onChange(async (v) => {
						this.plugin.settings.onDisable = v as Policy;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("When a note leaves an auto-tag folder")
			.setDesc("Applies when a note is moved out, or a folder stops including subfolders.")
			.addDropdown((dd) =>
				dd
					.addOptions(policyOptions("Remove tag", "Keep tag"))
					.setValue(this.plugin.settings.onLeave)
					.onChange(async (v) => {
						this.plugin.settings.onLeave = v as Policy;
						await this.plugin.saveSettings();
					}),
			);
	}
}
