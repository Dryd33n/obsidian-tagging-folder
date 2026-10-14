import { test } from "node:test";
import assert from "node:assert/strict";
import {
	editFrontmatterTags,
	normalizeTag,
	readFrontmatterTags,
	removeRulesUnder,
	renameRuleFolders,
	tagDifference,
	tagsForPath,
	validateTag,
	type FolderRule,
} from "../src/rules.ts";

const rule = (folderPath: string, tag: string, includeSubfolders = true): FolderRule => ({
	folderPath,
	tag,
	includeSubfolders,
});

test("normalizeTag strips # and whitespace", () => {
	assert.equal(normalizeTag("  #project "), "project");
	assert.equal(normalizeTag("##a/b"), "a/b");
});

test("validateTag", () => {
	assert.equal(validateTag("project"), null);
	assert.equal(validateTag("area/work-2"), null);
	assert.equal(validateTag("über_tag"), null);
	assert.notEqual(validateTag(""), null);
	assert.notEqual(validateTag("two words"), null);
	assert.notEqual(validateTag("1234"), null);
	assert.notEqual(validateTag("bad!"), null);
	assert.notEqual(validateTag("/lead"), null);
	assert.notEqual(validateTag("a//b"), null);
});

test("scope: direct children only when subfolders off", () => {
	const rules = [rule("Projects", "project", false)];
	assert.deepEqual(tagsForPath("Projects/a.md", rules), ["project"]);
	assert.deepEqual(tagsForPath("Projects/Sub/a.md", rules), []);
	assert.deepEqual(tagsForPath("ProjectsOther/a.md", rules), []);
	assert.deepEqual(tagsForPath("a.md", rules), []);
});

test("scope: nested rules give every matching tag", () => {
	const rules = [rule("Projects", "project"), rule("Projects/Work", "work")];
	assert.deepEqual(tagsForPath("Projects/Work/a.md", rules), ["project", "work"]);
	assert.deepEqual(tagsForPath("Projects/Work/Deep/a.md", rules), ["project", "work"]);
	assert.deepEqual(tagsForPath("Projects/a.md", rules), ["project"]);
});

test("scope: shared tags dedupe case-insensitively", () => {
	const rules = [rule("A", "Shared"), rule("A/B", "shared")];
	assert.deepEqual(tagsForPath("A/B/x.md", rules), ["Shared"]);
});

test("tagDifference is case-insensitive", () => {
	assert.deepEqual(tagDifference(["a", "B", "c"], ["b"]), ["a", "c"]);
});

test("renameRuleFolders rewrites folder and descendants only", () => {
	const rules = [rule("Projects", "p"), rule("Projects/Work", "w"), rule("ProjectsX", "x")];
	assert.equal(renameRuleFolders(rules, "Projects", "Archive/Proj"), true);
	assert.deepEqual(
		rules.map((r) => r.folderPath),
		["Archive/Proj", "Archive/Proj/Work", "ProjectsX"],
	);
	assert.equal(renameRuleFolders(rules, "Nope", "Other"), false);
});

test("removeRulesUnder", () => {
	const rules = [rule("A", "a"), rule("A/B", "b"), rule("AB", "c")];
	assert.deepEqual(removeRulesUnder(rules, "A").map((r) => r.tag), ["c"]);
});

test("readFrontmatterTags handles string, list and legacy key", () => {
	assert.deepEqual(readFrontmatterTags({ tags: "a, b #c" }), ["a", "b", "c"]);
	assert.deepEqual(readFrontmatterTags({ tags: ["x", "#y"], tag: "z" }), ["x", "y", "z"]);
	assert.deepEqual(readFrontmatterTags({ tags: null }), []);
});

test("editFrontmatterTags adds without duplicating and preserves other keys", () => {
	const fm: Record<string, unknown> = { title: "Hi", tags: ["Project"] };
	assert.equal(editFrontmatterTags(fm, ["project", "work"], []), true);
	assert.deepEqual(fm, { title: "Hi", tags: ["Project", "work"] });
});

test("editFrontmatterTags is a no-op when nothing changes", () => {
	const fm: Record<string, unknown> = { tags: "a b" };
	assert.equal(editFrontmatterTags(fm, ["A"], ["zzz"]), false);
	assert.deepEqual(fm, { tags: "a b" });
});

test("editFrontmatterTags removes and drops empty tags key", () => {
	const fm: Record<string, unknown> = { tags: ["project"], other: 1 };
	assert.equal(editFrontmatterTags(fm, [], ["Project"]), true);
	assert.deepEqual(fm, { other: 1 });
});

test("editFrontmatterTags merges legacy tag key when writing", () => {
	const fm: Record<string, unknown> = { tag: "old" };
	assert.equal(editFrontmatterTags(fm, ["new"], []), true);
	assert.deepEqual(fm, { tags: ["old", "new"] });
});
