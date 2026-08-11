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
const LINE = '[data-test="lyrics-line"]';
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

export const normalizeLine = (text: string): string => text.replace(/\s+/g, " ").trim();

let overlay: Overlay | null = null;

const styles = `
.${PART} { display: block; opacity: 0.72; font-size: 0.82em; line-height: 1.3; }
.${PART}[data-inline="true"] { display: inline; font-size: inherit; }
.${HIDDEN_SOURCE} { display: none !important; }
`;

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
	// Already carrying this exact overlay — the mutation was ours.
	if (line.dataset.lunaLt === overlay.key) return;
	if (line.dataset.lunaLt !== undefined) restore(line);

	const parts = overlay.lines.get(normalizeLine(line.textContent ?? ""));
	if (parts === undefined || parts.length === 0) return;

	// Keeping the original nodes intact matters: word-level highlighting lives in them.
	if (overlay.replaceSource) {
		const wrapper = document.createElement("span");
		wrapper.className = HIDDEN_SOURCE;
		while (line.firstChild !== null) wrapper.appendChild(line.firstChild);
		line.appendChild(wrapper);
	}

	for (const text of overlay.replaceSource ? parts : parts.slice(1)) {
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
	});
};
