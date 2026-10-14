import { App, PluginSettingTab, SettingDefinitionItem, TFolder } from "obsidian";
import type TaggingFolderPlugin from "./main";
import { FolderModal } from "./modals";
import { isPolicy, Policy } from "./rules";

type PolicyKey = "onDisable" | "onLeave";

export class TaggingFolderSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: TaggingFolderPlugin,
	) {
		super(app, plugin);
	}

	/** Rebuild the definitions after rules change elsewhere (folder modal, renames, deletes). */
	refresh() {
		this.update();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const rules = [...this.plugin.settings.rules].sort((a, b) => a.folderPath.localeCompare(b.folderPath));

		const policyOptions = (removeLabel: string, keepLabel: string): Record<Policy, string> => ({
			ask: "Ask every time",
			remove: removeLabel,
			keep: keepLabel,
		});

		return [
			{
				type: "list",
				heading: "Auto-tag folders",
				cls: "tagging-folder-rules",
				emptyState: "No folders have auto-tagging enabled yet. To set one up, right-click a folder in the file explorer.",
				// The list's delete button disables auto-tagging for that folder.
				onDelete: (index) => {
					const rule = rules[index];
					if (rule) void this.plugin.disableRule(rule);
				},
				items: rules.map((rule) => ({
					name: rule.folderPath,
					desc: `#${rule.tag}${rule.includeSubfolders ? " · includes subfolders" : ""}`,
					aliases: [rule.tag],
					render: (setting) => {
						setting.setClass("tagging-folder-rule");
						setting.addExtraButton((btn) =>
							btn
								.setIcon("settings")
								.setTooltip("Edit")
								.onClick(() => {
									const folder = this.app.vault.getAbstractFileByPath(rule.folderPath);
									if (folder instanceof TFolder) new FolderModal(this.app, this.plugin, folder).open();
								}),
						);
					},
				})),
			},
			{
				type: "group",
				heading: "Behaviour",
				items: [
					{
						name: "When disabling a folder's auto-tagging",
						desc: "What happens to the tag on notes that already have it.",
						control: {
							type: "dropdown",
							key: "onDisable",
							options: policyOptions("Remove tags", "Keep tags"),
							defaultValue: "ask",
						},
					},
					{
						name: "When a note leaves an auto-tag folder",
						desc: "Applies when a note is moved out, or a folder stops including subfolders.",
						control: {
							type: "dropdown",
							key: "onLeave",
							options: policyOptions("Remove tag", "Keep tag"),
							defaultValue: "ask",
						},
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return isPolicyKey(key) ? this.plugin.settings[key] : undefined;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (!isPolicyKey(key) || !isPolicy(value)) return;
		this.plugin.settings[key] = value;
		await this.plugin.saveSettings();
	}
}

function isPolicyKey(key: string): key is PolicyKey {
	return key === "onDisable" || key === "onLeave";
}
