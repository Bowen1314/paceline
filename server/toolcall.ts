/**
 * Tool-call validation for model output.
 *
 * Nemotron sometimes invents tool arguments that are not in the schema (it has
 * been seen passing `limit` to a tool that has none) and occasionally names a
 * tool that does not exist. Every tool call is therefore validated against its
 * JSON Schema with `additionalProperties: false`, and the exact errors are fed
 * back to the model so it can correct itself.
 */
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: object;
}

export interface ToolCallIn {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export type ToolCallResult<T> = { ok: true; name: string; args: T } | { ok: false; error: string };

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const compiled = new WeakMap<object, ValidateFunction>();

function describe(e: ErrorObject): string {
  const at = e.instancePath || '(root)';
  if (e.keyword === 'additionalProperties') return `${at}: unknown argument "${(e.params as { additionalProperty: string }).additionalProperty}" (it is not in the schema; remove it)`;
  if (e.keyword === 'required') return `${at}: missing required argument "${(e.params as { missingProperty: string }).missingProperty}"`;
  if (e.keyword === 'enum') return `${at}: must be one of ${JSON.stringify((e.params as { allowedValues: unknown[] }).allowedValues)}`;
  return `${at}: ${e.message ?? 'is invalid'}`;
}

export function validateArgs<T>(schema: object, args: unknown): { ok: true; value: T } | { ok: false; errors: string[] } {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  if (validate(args)) return { ok: true, value: args as T };
  return { ok: false, errors: [...new Set((validate.errors ?? []).map(describe))].slice(0, 12) };
}

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

const NULLISH = /^(none|null|nil|undefined|n\/a)?$/i;

/**
 * Seen in real calls: the serving stack renders a JSON `null` argument as the
 * Python-style string "None" (`"startDate": "None"`), and the model cannot fix
 * it when told, because from its side it did send null. So, only where the
 * schema says a field may be null, the strings "None" / "null" / "" are read
 * as null. Schema-directed, so a milestone titled "None" is left alone.
 */
export function normalizeNulls(schema: object, value: unknown): unknown {
  const node = schema as SchemaNode;
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  if (typeof value === 'string') return types.includes('null') && NULLISH.test(value.trim()) ? null : value;
  if (Array.isArray(value)) return node.items ? value.map((v) => normalizeNulls(node.items!, v)) : value;
  if (value && typeof value === 'object' && node.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = node.properties[k] ? normalizeNulls(node.properties[k], v) : v;
    return out;
  }
  return value;
}

export function validateToolCall<T>(call: ToolCallIn | undefined, tools: ToolDef[]): ToolCallResult<T> {
  const name = call?.function?.name;
  const tool = tools.find((t) => t.name === name);
  if (!name || !tool) return { ok: false, error: `Unknown tool "${String(name)}". Available tools: ${tools.map((t) => t.name).join(', ')}.` };
  let args: unknown;
  try {
    args = JSON.parse(call?.function?.arguments || '{}');
  } catch {
    return { ok: false, error: 'The tool arguments were not valid JSON.' };
  }
  args = normalizeNulls(tool.parameters, args);
  const res = validateArgs<T>(tool.parameters, args);
  if (!res.ok) return { ok: false, error: `Invalid arguments for ${name}: ${res.errors.join('; ')}. Call the tool again with corrected arguments.` };
  return { ok: true, name, args: res.value };
}
