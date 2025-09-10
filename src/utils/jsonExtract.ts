import { JsonValue } from '../types/json.js';

export function extractJsonFromContent(res: JsonValue): JsonValue {
	if (res && typeof res === 'object' && !Array.isArray(res)) {
		const obj = res as Record<string, JsonValue>;
		const content = obj.content;
		if (Array.isArray(content)) {
			for (const item of content) {
				if (item && typeof item === 'object' && !Array.isArray(item)) {
					const it = item as Record<string, JsonValue>;
					if (it.type === 'text' && typeof it.text === 'string') {
						try {
							return JSON.parse(String(it.text)) as JsonValue;
						} catch {
							return res;
						}
					}
				}
			}
		}
	}
	return res;
}
