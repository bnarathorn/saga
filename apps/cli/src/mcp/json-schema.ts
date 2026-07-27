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

  if (schema instanceof z.ZodOptional) return convert(schema.unwrap());
  if (schema instanceof z.ZodNullable) return convert(schema.unwrap());
  if (schema instanceof z.ZodDefault) {
    return withDescription({ ...convert(schema.removeDefault()), default: schema._def.defaultValue() });
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
    return withDescription({ type: schema.isInt ? 'integer' : 'number' });
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
