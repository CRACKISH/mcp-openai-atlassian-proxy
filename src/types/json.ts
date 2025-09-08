export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type JsonObject = Record<string, JsonValue>;
export interface ToolArguments {
	[k: string]: JsonValue;
}
