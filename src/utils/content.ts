import { ContentPart, JsonContentPart, TextContentPart, JsonValue } from '../types/json.js';

export function firstJson(content: ContentPart[] | null | undefined): JsonValue | null {
	if (!content) return null;
	for (const c of content) if ((c as JsonContentPart).type === 'json') return (c as JsonContentPart).data ?? null;
	for (const c of content) if ((c as TextContentPart).type === 'text') {
		try { return JSON.parse((c as TextContentPart).text) as JsonValue; } catch { return null; }
	}
	return null;
}

export function extractJiraKeys(content: ContentPart[] | undefined): string[] {
	const keys = new Set<string>();
	if (!content) return [];
	for (const part of content) {
		if ((part as JsonContentPart).type === 'json') collect((part as JsonContentPart).data);
		else if ((part as TextContentPart).type === 'text') addFromString((part as TextContentPart).text);
	}
	return [...keys];

	function addFromString(s: string) {
		const m = s.match(/[A-Z][A-Z0-9_]+-\d+/g);
		if (m) m.forEach(k => keys.add(k));
	}
	function collect(x: JsonValue | null) {
		if (x === null) return;
		if (typeof x === 'string') return addFromString(x);
		if (Array.isArray(x)) return x.forEach(collect);
		for (const v of Object.values(x)) collect(v as JsonValue);
		if (typeof (x as { key?: string }).key === 'string') keys.add((x as { key: string }).key);
	}
}

export function extractConfluenceIds(content: ContentPart[] | undefined): string[] {
	const ids = new Set<string>();
	if (!content) return [];
	for (const part of content) if ((part as JsonContentPart).type === 'json') collect((part as JsonContentPart).data);
	return [...ids];
	function collect(x: JsonValue | null) {
		if (x === null) return;
		if (Array.isArray(x)) return x.forEach(collect);
		if (typeof (x as { id?: string | number }).id !== 'undefined') {
			const idVal = (x as { id?: string | number }).id;
			if (typeof idVal === 'string' || typeof idVal === 'number') ids.add(String(idVal));
		}
		for (const v of Object.values(x)) collect(v as JsonValue);
	}
}
