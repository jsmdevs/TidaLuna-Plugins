import type { Layout, LinePart } from "./modes";

// LRC lines look like `[00:12.34]text`, and may carry several timestamps at once.
const TIMESTAMPS = /^((?:\[[^\]]*\]\s*)+)(.*)$/;

export interface SubtitleLine {
	/** The `[mm:ss.xx]` prefix, empty for lines that carry no timestamp. */
	prefix: string;
	text: string;
}

export const parseSubtitleLine = (line: string): SubtitleLine => {
	const match = TIMESTAMPS.exec(line);
	if (match === null) return { prefix: "", text: line };
	return { prefix: match[1], text: match[2] };
};

export interface LyricsText {
	/** Unsynced lyrics. */
	text: string;
	/** Synced lyrics, LRC format. */
	lrcText: string;
}

/**
 * Every distinct line of text across both views. Deduplicated: choruses repeat, and
 * translating the same line five times is five times the requests for one answer.
 */
export const collectSourceLines = ({ text, lrcText }: LyricsText): string[] => {
	const seen = new Set<string>();
	const add = (line: string) => {
		const trimmed = line.trim();
		if (trimmed !== "") seen.add(trimmed);
	};
	for (const line of (text ?? "").split("\n")) add(line);
	for (const line of (lrcText ?? "").split("\n")) add(parseSubtitleLine(line).text);
	return [...seen];
};

export interface RenderOptions {
	parts: LinePart[];
	layout: Layout;
	/** Joins parts when `layout` is `inline`. */
	separator: string;
	/** Resolves one part of one source line. Returning the source line means "unchanged". */
	resolve: (part: LinePart, source: string) => string;
}

/** The parts of a rendered line, with empty and consecutive-duplicate parts dropped. */
const renderParts = (source: string, { parts, resolve }: RenderOptions): string[] => {
	const out: string[] = [];
	for (const part of parts) {
		const text = resolve(part, source).trim();
		if (text === "" || text === out[out.length - 1]) continue;
		out.push(text);
	}
	// Everything collapsed (e.g. translation identical to the original) — keep the line.
	return out.length > 0 ? out : [source];
};

const renderPlain = (text: string, opts: RenderOptions): string =>
	text
		.split("\n")
		.map((line) => {
			const source = line.trim();
			// The unsynced view has room, so parts always get their own line there.
			return source === "" ? line : renderParts(source, opts).join("\n");
		})
		.join("\n");

const renderLrc = (lrcText: string, opts: RenderOptions): string =>
	lrcText
		.split("\n")
		.map((line) => {
			const { prefix, text } = parseSubtitleLine(line);
			const source = text.trim();
			if (source === "") return line;
			const parts = renderParts(source, opts);
			// `inline` keeps one timestamp per line; `newline` repeats the timestamp so the
			// player still highlights both halves of a bilingual line at the same time.
			return opts.layout === "inline" ? prefix + parts.join(opts.separator) : parts.map((part) => prefix + part).join("\n");
		})
		.join("\n");

export const renderLyrics = (lyrics: LyricsText, opts: RenderOptions): LyricsText => ({
	text: renderPlain(lyrics.text ?? "", opts),
	lrcText: renderLrc(lyrics.lrcText ?? "", opts),
});
