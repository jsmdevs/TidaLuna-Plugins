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

export interface LyricsSnapshot {
	cacheKey: string;
	/** Index of the lyrics resource inside `data.included`. */
	index: number;
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
		cacheKey,
		index,
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
 * Cached lyrics for the given track. Falls back to the most recently fulfilled lyrics
 * when that track has none of its own — the lyrics view can trail the player.
 */
export const findLyrics = (trackId?: string): LyricsSnapshot | null => {
	let newest: { snap: LyricsSnapshot; at: number } | null = null;
	for (const [cacheKey, entry] of Object.entries(queries())) {
		if (entry?.status !== "fulfilled") continue;
		const snap = snapshot(cacheKey, entry);
		if (snap === null) continue;
		if (trackId !== undefined && snap.trackId === trackId) return snap;
		const at = entry.fulfilledTimeStamp ?? 0;
		if (newest === null || at > newest.at) newest = { snap, at };
	}
	return newest?.snap ?? null;
};

/**
 * Rewrites a cached lyrics resource in place. Uses RTK Query's own patch action, so
 * every subscriber re-renders — including other plugins that draw the lyrics view.
 *
 * The index is resolved here rather than taken from the snapshot: `included` is rebuilt
 * on every refetch and the lyrics resource does not keep a fixed position in it.
 */
export const patchLyrics = (target: LyricsSnapshot, values: { text?: string; lrcText?: string; direction?: string }): boolean => {
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
