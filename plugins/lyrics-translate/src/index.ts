import { reduxStore, Tracer, type LunaUnload } from "@luna/core";
import { observe } from "@luna/lib";

import { domShowsLine, initOverlay, normalizeLine, setOverlay } from "./domOverlay";
import { isRightToLeft, sameLanguage } from "./languages";
import { collectSourceLines, renderLyrics, renderParts, type LyricsText } from "./lyrics";
import { partsFor, type LinePart } from "./modes";
import { settings, Settings } from "./Settings";
import { findAnyLyrics, patchLyrics, playingTrackId, type LyricsSnapshot } from "./tidalLyrics";
import { romanizeLines, translateLines } from "./translator";

export const { trace, errSignal } = Tracer("[LyricsTranslate]");
export const unloads = new Set<LunaUnload>();
export { Settings };

const RTL = "RIGHT_TO_LEFT";
const LTR = "LEFT_TO_RIGHT";

// Lyrics as they arrived from TIDAL, before anything was written back.
const originals = new Map<string, LyricsSnapshot>();
interface Render {
	/** Whole-document form, for rewriting TIDAL's own cache. */
	lyrics: LyricsText;
	/** Per-line form, for the display overlay: normalized source line -> its parts. */
	lines: Map<string, string[]>;
}

// Rendered results, keyed by lyrics source + the settings that shaped them.
const CACHE_LIMIT = 50;
const renders = new Map<string, Render>();

const settingsKey = () =>
	[settings.targetLanguage, settings.displayMode, settings.layout, settings.inlineSeparator, settings.skipSameLanguage].join("|");
const renderKey = (cacheKey: string) => `${cacheKey}|${settingsKey()}`;

let current: LyricsSnapshot | null = null;
let showing: "original" | "translated" = "original";
let busy = false;

/** Called by the settings page: earlier renders no longer match the new settings. */
export const clearCache = () => {
	renders.clear();
	if (showing === "translated") showOriginal();
	updateButtons();
};

const buildTranslation = async (source: LyricsSnapshot): Promise<Render | null> => {
	const sources = collectSourceLines(source);
	if (sources.length === 0) return null;

	const parts = partsFor(settings.displayMode);
	const targetLang = settings.targetLanguage;

	const romanization = new Map<string, string>();
	const translation = new Map<string, string>();
	let detected: string | undefined;

	if (parts.includes("romanization")) {
		const result = await romanizeLines(sources, { targetLang });
		detected ??= result.src;
		sources.forEach((line, i) => romanization.set(line, result.lines[i]));
	}

	if (parts.includes("translation")) {
		const result = await translateLines(sources, {
			targetLang,
			abortOnSource: (src) => settings.skipSameLanguage && sameLanguage(src, targetLang),
		});
		detected ??= result.src;
		if (result.aborted) {
			trace.log(`Left alone, lyrics are already in ${targetLang}`);
			return null;
		}
		sources.forEach((line, i) => translation.set(line, result.lines[i]));
	}

	trace.log(`Rendered ${sources.length} lines as ${settings.displayMode} (detected source: ${detected ?? "unknown"})`);

	const resolve = (part: LinePart, line: string) => {
		if (part === "romanization") return romanization.get(line) ?? line;
		if (part === "translation") return translation.get(line) ?? line;
		return line;
	};

	const opts = { parts, layout: settings.layout, separator: settings.inlineSeparator, resolve };
	const lines = new Map<string, string[]>();
	for (const line of sources) lines.set(normalizeLine(line), renderParts(line, opts));

	return { lyrics: renderLyrics(source, opts), lines };
};

/** Direction only flips when a line is purely target-language text. */
const directionFor = (source: LyricsSnapshot) => {
	const parts = partsFor(settings.displayMode);
	if (parts.length !== 1 || parts[0] !== "translation") return source.direction;
	return isRightToLeft(settings.targetLanguage) ? RTL : LTR;
};

/** A translated line that isn't just its own source, to probe what the view is showing. */
const sampleTranslated = ({ lines }: Render): string | null => {
	for (const [source, parts] of lines) {
		const last = parts[parts.length - 1];
		if (last !== undefined && normalizeLine(last) !== source) return last;
	}
	return null;
};

/**
 * Puts a render on screen. TIDAL's own cache is rewritten when the lyrics came from it,
 * and the display overlay takes over whenever that doesn't reach the view — which is the
 * case whenever another plugin is supplying the lyrics.
 */
const display = async (source: LyricsSnapshot, render: Render) => {
	setOverlay(null);
	const patched = patchLyrics(source, { ...render.lyrics, direction: directionFor(source) });

	if (patched) {
		// Give the view a moment to redraw from the patched data before deciding.
		await new Promise((resolve) => setTimeout(resolve, 600));
		const sample = sampleTranslated(render);
		if (sample === null || domShowsLine(sample)) return true;
		trace.log("Data patch did not reach the view; using the display overlay instead");
	}

	setOverlay({
		lines: render.lines,
		layout: settings.layout,
		separator: settings.inlineSeparator,
		replaceSource: !partsFor(settings.displayMode).includes("original"),
		key: renderKey(source.cacheKey),
	});
	return true;
};

const showTranslation = async () => {
	if (current === null || busy) return;
	const source = current;

	const cached = renders.get(renderKey(source.cacheKey));
	if (cached !== undefined) {
		await display(source, cached);
		showing = "translated";
		updateButtons();
		return;
	}

	busy = true;
	updateButtons();
	try {
		const result = await buildTranslation(source);
		// The track changed while we were translating — drop the stale result.
		if (current?.cacheKey !== source.cacheKey || result === null) return;

		if (renders.size >= CACHE_LIMIT) renders.delete(renders.keys().next().value!);
		renders.set(renderKey(source.cacheKey), result);
		await display(source, result);
		showing = "translated";
	} catch (err) {
		trace.msg.err.withContext("Failed to translate lyrics")(err);
	} finally {
		busy = false;
		updateButtons();
	}
};

const showOriginal = () => {
	setOverlay(null);
	if (current !== null) patchLyrics(current, { text: current.text, lrcText: current.lrcText, direction: current.direction });
	showing = "original";
	updateButtons();
};

const toggle = () => {
	if (current === null) {
		trace.msg.log("No lyrics loaded — open the lyrics tab for a track that has them");
		return;
	}
	if (showing === "translated") showOriginal();
	else void showTranslation();
};

// --- Watching for lyrics ----------------------------------------------------
//
// Lyrics arrive as part of an RTK Query response rather than a dedicated action, so
// there is nothing to intercept: the store is watched instead, and the first version
// seen for a cache entry is kept as the untouched original.

let currentTrackId: string | undefined;

const adopt = (found: LyricsSnapshot | null) => {
	setOverlay(null);
	current = found;
	showing = "original";
	updateButtons();
	if (found !== null && settings.autoTranslate) void showTranslation();
};

const onStoreChange = () => {
	const trackId = playingTrackId();
	const found = findAnyLyrics(trackId);
	// First sighting of a cache entry is the untouched version — everything later may be ours.
	if (found !== null && !originals.has(found.cacheKey)) originals.set(found.cacheKey, found);

	// A new track resets everything, including a translation left showing for the old one.
	const trackChanged = trackId !== currentTrackId;
	currentTrackId = trackId;

	if (trackChanged) {
		adopt(found === null ? null : originals.get(found.cacheKey)!);
		return;
	}

	// Same track: adopt its lyrics once they arrive (they land a moment after the player
	// switches, so a track change alone usually finds nothing).
	if (found !== null && current?.cacheKey !== found.cacheKey) adopt(originals.get(found.cacheKey)!);
};

let pending: ReturnType<typeof setTimeout> | undefined;
const scheduleScan = () => {
	if (pending !== undefined) return;
	pending = setTimeout(() => {
		pending = undefined;
		try {
			onStoreChange();
		} catch (err) {
			trace.err.withContext("Lyrics scan failed")(err);
		}
	}, 150);
};

initOverlay(unloads);
unloads.add(reduxStore.subscribe(scheduleScan));
unloads.add(() => {
	if (pending !== undefined) clearTimeout(pending);
});
scheduleScan();

// --- Toolbar button ---------------------------------------------------------

const BUTTON_CLASS = "luna-lyrics-translate-button";
const buttons = new Set<HTMLButtonElement>();

// In priority order: the labelled tab bar in the now-playing view, then its icon
// action bar, then the pre-2025 lyrics toolbar for older clients.
const ANCHORS = ['[data-test="toggle-lyrics"]', '[data-test="new-now-playing-expand"]', '[data-test="request-fullscreen"]'];

const buttonLabel = () => (busy ? "Translating…" : showing === "translated" ? "Show original" : "Translate");

const updateButtons = () => {
	const label = buttonLabel();
	for (const button of buttons) {
		const target = button.querySelector("span") ?? button;
		target.textContent = label;
		button.setAttribute("aria-label", label);
		button.title = label;
		button.disabled = busy;
		button.style.display = settings.showButton ? "" : "none";
	}
};

const mountButton = (anchor: HTMLElement) => {
	const parent = anchor.parentElement;
	// One button per client — whichever anchor turns up first wins.
	if (parent === null || document.querySelector(`.${BUTTON_CLASS}`) !== null) return;

	const button = document.createElement("button");
	// Inherit the neighbour's styling, minus any "this tab is active" class.
	button.className = [...anchor.classList].filter((cls) => !/active/i.test(cls)).concat(BUTTON_CLASS).join(" ");

	// TIDAL's buttons keep their text in a span; match that so the label is styled too.
	const anchorLabel = [...anchor.children].find((child) => /label/i.test(child.className));
	if (anchorLabel !== undefined) {
		const label = document.createElement("span");
		label.className = anchorLabel.className;
		button.appendChild(label);
	}

	button.addEventListener("click", () => toggle());
	buttons.add(button);
	parent.insertBefore(button, anchor.nextSibling);
	updateButtons();
};

for (const selector of ANCHORS) {
	// observe() only fires on mutations, so anything already rendered needs its own pass.
	for (const anchor of document.querySelectorAll<HTMLElement>(selector)) mountButton(anchor);
	observe<HTMLElement>(unloads, selector, mountButton);
}

unloads.add(() => {
	for (const button of buttons) button.remove();
	buttons.clear();
});
