/** Strongly typed JSON value hierarchy (no any/unknown). */
export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject { [k: string]: JsonValue }
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** MCP content parts constrained to JSON/text. */
export interface JsonContentPart { type: 'json'; data: JsonValue | null }
export interface TextContentPart { type: 'text'; text: string }
export type ContentPart = JsonContentPart | TextContentPart | { type?: string };

export interface ToolResponse { content?: ContentPart[] }
export interface ToolArguments { [k: string]: JsonValue }
export interface ListToolsResult { tools: { name: string; description?: string }[] }