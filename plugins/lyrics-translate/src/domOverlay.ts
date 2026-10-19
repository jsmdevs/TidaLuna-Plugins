import type { LunaUnloads } from "@luna/core";
import { observe, StyleTag } from "@luna/lib";
import type { Layout } from "./modes";

/**
 * Display-layer fallback.
 *
 * Patching the data is the clean way to translate lyrics, but it only works when TIDAL
 * itself renders them. Plugins such as Radiant Lyrics fetch lyrics from their own provider
 * and inject them into the view, so nothing we write to TIDAL's cache is ever read. This
 * overlay rewrites the rendered lines instead, and reapplies itself whenever the view
 * redraws — which is all the time, since the lyrics list re-renders as the song plays.
 */
// TIDAL's own lines, plus the ones Radiant Lyrics draws itself in word/syllable mode (it hides
// TIDAL's lines there, so writing only to those would never be visible).
const LINE = '[data-test="lyrics-line"], .rl-wbw-line:not(.rl-wbw-spacer)';
const PART = "luna-lt-part";
const HIDDEN_SOURCE = "luna-lt-source";

export interface Overlay {
	/** Normalized source line -> the parts it should be rendered as. */
	lines: Map<string, string[]>;
	layout: Layout;
	separator: string;
	/** True when the mode drops the original line (the parts replace it). */
	replaceSource: boolean;
	/** Identifies this overlay, so a re-render can tell it from a stale one. */
	key: string;
}

/**
 * Matching key for a line. Radiant Lyrics rebuilds lines from syllables, so spacing and
 * punctuation (e.g. the parentheses it strips from background vocals) can differ from the
 * source text; comparing letters and digits only keeps both sides lined up.
 */
export const normalizeLine = (text: string): string => {
	const collapsed = text.replace(/\s+/g, " ").trim();
	const compact = collapsed.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
	return compact === "" ? collapsed : compact;
};

let overlay: Overlay | null = null;

const styles = `
.${PART} { display: block; opacity: 0.72; font-size: calc(0.82em * var(--luna-lt-scale, 1)); line-height: 1.3; }
.${PART}[data-inline="true"] { display: inline; font-size: calc(1em * var(--luna-lt-scale, 1)); }
.${HIDDEN_SOURCE} { display: none !important; }
.rl-wbw-line > .${PART} { font-size: calc(0.55em * var(--luna-lt-scale, 1)); font-weight: 600; line-height: 1.3; margin-top: 0.15em; color: rgba(255, 255, 255, 0.55); opacity: 1; }
.rl-wbw-line > .${PART}[data-inline="true"] { display: inline; font-size: calc(1em * var(--luna-lt-scale, 1)); }
.rl-wbw-line-active > .${PART} { color: rgba(255, 255, 255, 0.85); }
`;

let onMissing: ((lines: string[], overlayKey: string) => void) | null = null;
const missing = new Set<string>();
let missingTimer: ReturnType<typeof setTimeout> | undefined;

/** Called with the on-screen lines that have no translation, so they can be translated directly. */
export const setMissingHandler = (handler: typeof onMissing) => {
	onMissing = handler;
};

const reportMissing = (text: string) => {
	if (overlay === null || onMissing === null) return;
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (!/[\p{L}\p{N}]/u.test(collapsed)) return;
	missing.add(collapsed);
	if (missingTimer !== undefined) return;
	// Wait a moment so a view that redraws every line at once is handled as a single batch.
	missingTimer = setTimeout(() => {
		missingTimer = undefined;
		const lines = [...missing];
		missing.clear();
		if (overlay !== null && lines.length > 0) onMissing?.(lines, overlay.key);
	}, 400);
};

const restore = (line: HTMLElement) => {
	for (const part of line.querySelectorAll(`.${PART}`)) part.remove();
	const hidden = line.querySelector<HTMLElement>(`.${HIDDEN_SOURCE}`);
	if (hidden !== null) {
		while (hidden.firstChild !== null) line.insertBefore(hidden.firstChild, hidden);
		hidden.remove();
	}
	delete line.dataset.lunaLt;
};

const apply = (line: HTMLElement) => {
	if (overlay === null) {
		if (line.dataset.lunaLt !== undefined) restore(line);
		return;
	}
	// Already carrying this exact overlay — the mutation was ours. Only trust the marker
	// while our nodes are still inside: another plugin (Radiant Lyrics) may rebuild the
	// line's children and leave the dataset flag behind, which would otherwise make the
	// translation vanish and never be reapplied.
	if (line.dataset.lunaLt === overlay.key && line.querySelector(`.${PART}`) !== null) return;
	if (line.dataset.lunaLt !== undefined) restore(line);

	const text = line.textContent ?? "";
	const parts = overlay.lines.get(normalizeLine(text));
	if (parts === undefined) {
		// The view shows a line the translated lyrics have no entry for (another plugin's
		// lyrics can be worded differently from the source that was translated).
		reportMissing(text);
		return;
	}
	if (parts.length === 0) return;

	const extra = overlay.replaceSource ? parts : parts.slice(1);
	// Nothing to add (translation identical to the source): leave the line alone, otherwise
	// the "our nodes are missing" check above would keep re-applying it.
	if (extra.length === 0) return;

	// Keeping the original nodes intact matters: word-level highlighting lives in them.
	if (overlay.replaceSource) {
		const wrapper = document.createElement("span");
		wrapper.className = HIDDEN_SOURCE;
		while (line.firstChild !== null) wrapper.appendChild(line.firstChild);
		line.appendChild(wrapper);
	}

	for (const text of extra) {
		const span = document.createElement("span");
		span.className = PART;
		if (overlay.layout === "inline") {
			span.dataset.inline = "true";
			span.textContent = overlay.separator + text;
		} else span.textContent = text;
		line.appendChild(span);
	}
	line.dataset.lunaLt = overlay.key;
};

const sweep = () => {
	for (const line of document.querySelectorAll<HTMLElement>(LINE)) apply(line);
};

/** Size of the translated text relative to its default, in percent (100 = default). */
export const setOverlayScale = (percent: number) => {
	const scale = Number.isFinite(percent) && percent > 0 ? percent / 100 : 1;
	document.documentElement.style.setProperty("--luna-lt-scale", String(scale));
};

/** Re-applies the current overlay to every line on screen. */
export const refreshOverlay = () => sweep();

export const setOverlay = (next: Overlay | null) => {
	overlay = next;
	sweep();
};

/** True when a line with this exact text is already on screen. */
export const domShowsLine = (text: string): boolean => {
	const needle = normalizeLine(text);
	for (const line of document.querySelectorAll<HTMLElement>(LINE)) {
		if (normalizeLine(line.textContent ?? "") === needle) return true;
	}
	return false;
};

export const initOverlay = (unloads: LunaUnloads) => {
	new StyleTag("LyricsTranslate", unloads, styles);
	// observe() only fires on mutations, so the initial sweep is done by setOverlay.
	observe<HTMLElement>(unloads, LINE, apply);
	unloads.add(() => {
		overlay = null;
		sweep();
		document.documentElement.style.removeProperty("--luna-lt-scale");
		if (missingTimer !== undefined) clearTimeout(missingTimer);
		missingTimer = undefined;
		missing.clear();
		onMissing = null;
	});
};
