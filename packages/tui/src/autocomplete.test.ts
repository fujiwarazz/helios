import { describe, expect, it } from "vitest";
import { CombinedAutocompleteProvider, type SlashCommand } from "./autocomplete";

const COMMANDS: SlashCommand[] = [
	{ name: "help", description: "列出所有本地命令" },
	{ name: "clear", description: "清空本地 transcript" },
	{ name: "resume", description: "切换到另一个持久化会话", argumentHint: "<session-id>" },
];

function provider(): CombinedAutocompleteProvider {
	return new CombinedAutocompleteProvider(COMMANDS, process.cwd());
}

async function suggest(text: string) {
	return provider().getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
}

describe("CombinedAutocompleteProvider slash commands", () => {
	it("accepting a suggestion yields exactly one leading slash", async () => {
		// Regression: commands registered as "/help" plus applyCompletion's own "/" produced "//help",
		// which then failed to dispatch ("未知命令 //help"). This whole round trip had no coverage.
		const suggestions = await suggest("/he");
		expect(suggestions).not.toBeNull();
		const item = suggestions!.items[0]!;
		expect(item.value).toBe("help");

		const applied = provider().applyCompletion(["/he"], 0, 3, item, suggestions!.prefix);
		expect(applied.lines[0]).toBe("/help ");
		expect(applied.cursorCol).toBe("/help ".length);
	});

	it("shows the slash in the list label so it matches what gets inserted", async () => {
		const suggestions = await suggest("/he");
		expect(suggestions!.items[0]!.label).toBe("/help");
	});

	it("matches against the bare name, and surfaces the argument hint", async () => {
		const suggestions = await suggest("/res");
		expect(suggestions!.items.map((i) => i.value)).toEqual(["resume"]);
		expect(suggestions!.items[0]!.description).toContain("<session-id>");
	});

	it("returns null when nothing matches, so the editor keeps the raw text", async () => {
		expect(await suggest("/zzz")).toBeNull();
	});

	it("stops offering command names once an argument is being typed", async () => {
		// "/resume " has a space: this is the argument-completion branch, and `resume` declares no
		// getArgumentCompletions, so there is nothing to offer.
		expect(await suggest("/resume ")).toBeNull();
	});
});
