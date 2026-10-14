// Pure logic with no Obsidian imports, so it can be unit tested in plain Node.

export interface FolderRule {
	folderPath: string;
	tag: string;
	includeSubfolders: boolean;
}

export type Policy = "ask" | "remove" | "keep";

/** Strip a leading "#" and surrounding whitespace. */
export function normalizeTag(input: string): string {
	return input.trim().replace(/^#+/, "").trim();
}

/** Returns an error message, or null if the tag is valid. Expects a normalized tag. */
export function validateTag(tag: string): string | null {
	if (!tag) return "Tag name is required.";
	if (/\s/.test(tag)) return "Tags can't contain spaces.";
	if (!/^[\p{L}\p{N}_\-/]+$/u.test(tag)) {
		return "Tags may only contain letters, numbers, _, - and /.";
	}
	if (/^\d+$/.test(tag)) return "Tags must contain at least one non-numeric character.";
	if (tag.startsWith("/") || tag.endsWith("/") || tag.includes("//")) {
		return "Nested tags can't start or end with / or contain empty parts.";
	}
	return null;
}

export function tagKey(tag: string): string {
	return tag.toLowerCase();
}

function parentPath(filePath: string): string {
	const i = filePath.lastIndexOf("/");
	return i === -1 ? "" : filePath.slice(0, i);
}

export function isInScope(filePath: string, rule: FolderRule): boolean {
	if (parentPath(filePath) === rule.folderPath) return true;
	return rule.includeSubfolders && filePath.startsWith(rule.folderPath + "/");
}

/** All tags a note at `filePath` should carry, deduped case-insensitively. */
export function tagsForPath(filePath: string, rules: FolderRule[]): string[] {
	const out = new Map<string, string>();
	for (const rule of rules) {
		if (isInScope(filePath, rule) && !out.has(tagKey(rule.tag))) {
			out.set(tagKey(rule.tag), rule.tag);
		}
	}
	return [...out.values()];
}

/** Tags in `a` that are not in `b` (case-insensitive). */
export function tagDifference(a: string[], b: string[]): string[] {
	const keys = new Set(b.map(tagKey));
	return a.filter((t) => !keys.has(tagKey(t)));
}

export function isAtOrBelow(path: string, folder: string): boolean {
	return path === folder || path.startsWith(folder + "/");
}

/** Rewrite rule folder paths after a folder rename/move. Returns true if anything changed. */
export function renameRuleFolders(rules: FolderRule[], oldPath: string, newPath: string): boolean {
	let changed = false;
	for (const rule of rules) {
		if (isAtOrBelow(rule.folderPath, oldPath)) {
			rule.folderPath = newPath + rule.folderPath.slice(oldPath.length);
			changed = true;
		}
	}
	return changed;
}

/** Remove rules for a deleted folder and everything beneath it. */
export function removeRulesUnder(rules: FolderRule[], folder: string): FolderRule[] {
	return rules.filter((r) => !isAtOrBelow(r.folderPath, folder));
}

/** Read the tag list out of a frontmatter object, accepting `tags`/`tag` as string or array. */
export function readFrontmatterTags(fm: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of ["tags", "tag"]) {
		const value = fm[key];
		if (value == null) continue;
		const items = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
		for (const item of items) {
			if (item == null) continue;
			const t = normalizeTag(String(item));
			if (t) out.push(t);
		}
	}
	return out;
}

/**
 * Mutates `fm` in place: adds `add` and removes `remove` from its tags.
 * Tags are written to `tags` as a list; a legacy `tag` key is merged in.
 * Returns true if the frontmatter changed.
 */
export function editFrontmatterTags(
	fm: Record<string, unknown>,
	add: string[],
	remove: string[],
): boolean {
	const before = readFrontmatterTags(fm);
	const removeKeys = new Set(remove.map(tagKey));
	const next: string[] = [];
	const seen = new Set<string>();
	for (const t of [...before, ...add]) {
		const k = tagKey(t);
		if (removeKeys.has(k) || seen.has(k)) continue;
		seen.add(k);
		next.push(t);
	}

	// Leave the note untouched (including its tag formatting) if the tag set didn't change.
	if (next.length === before.length && next.every((t, i) => t === before[i])) return false;

	delete fm.tag;
	if (next.length) fm.tags = next;
	else delete fm.tags;
	return true;
}
