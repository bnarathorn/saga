import { z } from 'zod';

/**
 * Minimal Zod → JSON Schema conversion for MCP tool declarations.
 *
 * MCP hosts need `type`, `properties`, `required` and descriptions; a full converter would
 * add a dependency for shapes Saga's tool inputs never use.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const converted = convert(schema);
  return converted.type === 'object'
    ? converted
    : { type: 'object', properties: {}, additionalProperties: false };
}

function convert(schema: z.ZodTypeAny): Record<string, unknown> {
  const description = schema.description;
  const withDescription = (value: Record<string, unknown>): Record<string, unknown> =>
    description === undefined ? value : { ...value, description };

  // `.optional().describe(…)` hangs the description on the wrapper, so unwrapping without
  // re-applying it drops the one sentence the field was written for. Five tool arguments were
  // silently arriving at the model bare — `agent`, `requested_quest_id`, `scope`, `summary`
  // and `quest_status`. The wrapper's description wins when both carry one.
  if (schema instanceof z.ZodOptional) return withDescription(convert(schema.unwrap()));
  if (schema instanceof z.ZodNullable) return withDescription(convert(schema.unwrap()));
  if (schema instanceof z.ZodDefault) {
    return withDescription({
      ...convert(schema.removeDefault()),
      default: schema._def.defaultValue(),
    });
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value);
      if (!value.isOptional()) required.push(key);
    }
    return withDescription({
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    });
  }

  if (schema instanceof z.ZodArray) {
    return withDescription({ type: 'array', items: convert(schema.element) });
  }
  if (schema instanceof z.ZodEnum) {
    return withDescription({ type: 'string', enum: [...(schema.options as string[])] });
  }
  if (schema instanceof z.ZodString) return withDescription({ type: 'string' });
  if (schema instanceof z.ZodNumber) {
    // Bounds are carried, not dropped. A bare `{"type":"integer"}` tells the model nothing
    // about the scale it is answering on, and `importance` is scored 0-100: every agent that
    // met it bare guessed 1-5, which is inside the range and so passes validation while filing
    // the entry below everything already recorded. Nine entries in this project's own Lore
    // arrived that way, across several sessions, and one was evicted from Core Context by it.
    // `confidence` is 0-1 and fails loudly instead, which is why nobody noticed the converter.
    return withDescription({
      type: schema.isInt ? 'integer' : 'number',
      ...(schema.minValue === null ? {} : { minimum: schema.minValue }),
      ...(schema.maxValue === null ? {} : { maximum: schema.maxValue }),
    });
  }
  if (schema instanceof z.ZodBoolean) return withDescription({ type: 'boolean' });
  if (schema instanceof z.ZodRecord) {
    return withDescription({ type: 'object', additionalProperties: true });
  }
  if (schema instanceof z.ZodUnion) {
    return withDescription({
      anyOf: (schema.options as z.ZodTypeAny[]).map((option) => convert(option)),
    });
  }
  // Anything else is accepted as-is rather than rejected: an over-strict schema would block
  // a legitimate call.
  return withDescription({});
}
