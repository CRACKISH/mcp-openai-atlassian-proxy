export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export interface ToolArguments { [k: string]: JsonValue }