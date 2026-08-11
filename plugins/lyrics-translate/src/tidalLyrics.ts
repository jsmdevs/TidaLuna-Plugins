import { reduxStore } from "@luna/core";
import { PlayState } from "@luna/lib";

/**
 * Where lyrics actually live in current TIDAL builds.
 *
 * The legacy `content/LOAD_ITEM_LYRICS_*` actions are gone (no action creators are
 * registered for them, and there is no lyrics slice in `content`). Lyrics now ride
 * along with the RTK Query `getTracksById` request as an included `lyrics` resource,
 * so this plugin reads and writes that query's cache entry.
 */
const API_SLICE = "tidalOpenPlatformApi";

/**
 * `cache` — TIDAL's own RTK Query entry, which we can rewrite.
 * `entity` — the normalized lyrics entity another plugin injected; read-only for us, so
 * lyrics from that origin are translated through the display overlay instead.
 */
export type LyricsOrigin = "cache" | "entity";

export interface LyricsSnapshot {
	origin: LyricsOrigin;
	/** Cache entry key, or `entity:<id>`. Identifies the lyrics for caching renders. */
	cacheKey: string;
	trackId?: string;
	/** Unsynced lyrics. */
	text: string;
	/** Synced lyrics, LRC format. */
	lrcText: string;
	direction?: string;
}

interface CacheEntry {
	status?: string;
	originalArgs?: { id?: string };
	fulfilledTimeStamp?: number;
	data?: { included?: { type?: string; attributes?: Record<string, unknown> }[] };
}

const snapshot = (cacheKey: string, entry: CacheEntry): LyricsSnapshot | null => {
	const included = entry.data?.included ?? [];
	const index = included.findIndex((resource) => resource?.type === "lyrics" && typeof resource.attributes?.text === "string");
	if (index === -1) return null;

	const attributes = included[index].attributes!;
	return {
		origin: "cache",
		cacheKey,
		trackId: entry.originalArgs?.id,
		text: String(attributes.text ?? ""),
		lrcText: String(attributes.lrcText ?? ""),
		direction: typeof attributes.direction === "string" ? attributes.direction : undefined,
	};
};

const queries = (): Record<string, CacheEntry> => (reduxStore.getState() as any)?.[API_SLICE]?.queries ?? {};

export const playingTrackId = (): string | undefined => {
	const id = (PlayState as any)?.playbackContext?.actualProductId;
	return id == null ? undefined : String(id);
};

/**
 * Cached lyrics for the given track, and only for that track.
 *
 * There is deliberately no "most recent lyrics" fallback: a track change fetches the new
 * lyrics a moment after the player switches, and falling back during that gap selects the
 * previous song's cache entry — which then gets translated instead of the one on screen.
 */
export const findLyrics = (trackId?: string): LyricsSnapshot | null => {
	if (trackId === undefined) return null;
	for (const [cacheKey, entry] of Object.entries(queries())) {
		if (entry?.status !== "fulfilled" || String(entry.originalArgs?.id ?? "") !== trackId) continue;
		const snap = snapshot(cacheKey, entry);
		if (snap !== null) return snap;
	}
	return null;
};

/**
 * Lyrics for the given track as held in the normalized entity store.
 *
 * This is what the lyrics view actually renders, and it is where plugins that supply their
 * own lyrics (Radiant Lyrics injects `radiant-lyrics-<trackId>`) put theirs. We can read it
 * but not write it, so these are translated through the display overlay.
 */
export const findEntityLyrics = (trackId?: string): LyricsSnapshot | null => {
	if (trackId === undefined) return null;
	const entities: Record<string, any> = (reduxStore.getState() as any)?.entities?.lyrics?.entities ?? {};
	for (const [id, entity] of Object.entries(entities)) {
		if (!String(id).includes(trackId)) continue;
		const attributes = entity?.attributes;
		if (typeof attributes?.text !== "string" && typeof attributes?.lrcText !== "string") continue;
		return {
			origin: "entity",
			cacheKey: `entity:${id}`,
			trackId,
			text: String(attributes.text ?? ""),
			lrcText: String(attributes.lrcText ?? ""),
			direction: typeof attributes.direction === "string" ? attributes.direction : undefined,
		};
	}
	return null;
};

/** Whatever lyrics are in play for a track: the rendered ones first, TIDAL's own otherwise. */
export const findAnyLyrics = (trackId?: string): LyricsSnapshot | null => findEntityLyrics(trackId) ?? findLyrics(trackId);

/**
 * Rewrites a cached lyrics resource in place. Uses RTK Query's own patch action, so
 * every subscriber re-renders — including other plugins that draw the lyrics view.
 *
 * The index is resolved here rather than taken from the snapshot: `included` is rebuilt
 * on every refetch and the lyrics resource does not keep a fixed position in it.
 */
export const patchLyrics = (target: LyricsSnapshot, values: { text?: string; lrcText?: string; direction?: string }): boolean => {
	if (target.origin !== "cache") return false;
	const included = queries()[target.cacheKey]?.data?.included;
	const index = included?.findIndex((resource) => resource?.type === "lyrics") ?? -1;
	if (index === -1) return false;

	const patches = Object.entries(values)
		.filter(([, value]) => value !== undefined)
		.map(([field, value]) => ({ op: "replace" as const, path: ["included", index, "attributes", field], value }));
	if (patches.length === 0) return false;

	reduxStore.dispatch({
		type: `${API_SLICE}/queries/queryResultPatched`,
		payload: { queryCacheKey: target.cacheKey, patches },
	} as any);
	return true;
};
