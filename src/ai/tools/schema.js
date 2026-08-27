// src/ai/tools/schema.js
//
// Function-tool schema construction and the lightweight runtime hallucination
// guard shared by every tool catalog.

function _closeSchemaObjects(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const closed = { ...schema };
  if (schema.type === 'object') {
    closed.properties = Object.fromEntries(
      Object.entries(schema.properties || {}).map(([key, value]) => [key, _closeSchemaObjects(value)])
    );
    closed.additionalProperties = false;
  } else if (schema.type === 'array' && schema.items) {
    closed.items = _closeSchemaObjects(schema.items);
  }
  return closed;
}

function makeTool({ name, description, properties = {}, required = [], outputSchema = null }) {
  const parameters = _closeSchemaObjects({ type: 'object', properties });
  const tool = {
    type: 'function',
    function: {
      name,
      description,
      parameters
    }
  };
  if (required.length > 0) tool.function.parameters.required = required;
  if (outputSchema) tool.function.outputSchema = _closeSchemaObjects(outputSchema);
  return tool;
}

/**
 * Project the canonical optional-argument schema into OpenAI strict form.
 * Every object property becomes required on the wire; originally optional
 * properties accept null, which the dispatcher removes before execution.
 */
function projectStrictToolParameters(schema, optional = false) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const projected = { ...schema };

  if (optional) {
    const types = Array.isArray(projected.type) ? projected.type : [projected.type];
    projected.type = [...new Set(types.filter(Boolean).concat('null'))];
    if (Array.isArray(projected.enum) && !projected.enum.includes(null)) {
      projected.enum = [...projected.enum, null];
    }
  }

  if (schema.type === 'object') {
    const originalRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
    projected.properties = Object.fromEntries(
      Object.entries(schema.properties || {}).map(([key, child]) => [
        key,
        projectStrictToolParameters(child, !originalRequired.has(key))
      ])
    );
    projected.required = Object.keys(schema.properties || {});
    projected.additionalProperties = false;
  } else if (schema.type === 'array' && schema.items) {
    projected.items = projectStrictToolParameters(schema.items, false);
  }
  return projected;
}

/** Remove strict-wire null placeholders only where the canonical field is optional. */
function normalizeOptionalNullArgs(value, schema) {
  if (!schema || value === null || value === undefined) return value;
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    return value.map(item => normalizeOptionalNullArgs(item, schema.items));
  }
  if (schema.type !== 'object' || typeof value !== 'object' || Array.isArray(value)) return value;

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const properties = schema.properties || {};
  const normalized = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (childValue === null && Object.hasOwn(properties, key) && !required.has(key)) continue;
    normalized[key] = Object.hasOwn(properties, key)
      ? normalizeOptionalNullArgs(childValue, properties[key])
      : childValue;
  }
  return normalized;
}

function _matchesType(value, schemaType) {
  if (!schemaType) return true;
  switch (schemaType) {
  case 'string': return typeof value === 'string';
  case 'number': return typeof value === 'number' && Number.isFinite(value);
  case 'integer': return typeof value === 'number' && Number.isInteger(value);
  case 'boolean': return typeof value === 'boolean';
  case 'array': return Array.isArray(value);
  case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
  default: return true;
  }
}

function _argumentLabel(path) {
  return path ? `Argument "${path}"` : 'Tool arguments';
}

function _validateValue(value, schema, path) {
  if (!_matchesType(value, schema.type)) {
    return `${_argumentLabel(path)} has wrong type (expected ${schema.type}).`;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.includes(value)) {
    return `${_argumentLabel(path)} must be one of: ${schema.enum.join(', ')}.`;
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return `${_argumentLabel(path)} must be at least ${schema.minimum}.`;
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return `${_argumentLabel(path)} must be at most ${schema.maximum}.`;
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      return `${_argumentLabel(path)} must contain at least ${schema.minLength} character(s).`;
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      return `${_argumentLabel(path)} must contain at most ${schema.maxLength} character(s).`;
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      return `${_argumentLabel(path)} does not match the required format.`;
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      return `${_argumentLabel(path)} must contain at least ${schema.minItems} item(s).`;
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      return `${_argumentLabel(path)} must contain at most ${schema.maxItems} item(s).`;
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index++) {
        const itemErr = _validateValue(value[index], schema.items, `${path}[${index}]`);
        if (itemErr) return itemErr;
      }
    }
  }

  if (schema.type === 'object') {
    const props = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      const childValue = value[key];
      if (childValue === undefined || childValue === null || childValue === '') {
        const childPath = path ? `${path}.${key}` : key;
        return `Missing required argument "${childPath}".`;
      }
    }
    for (const [key, childValue] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const childSchema = props[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) return `Unknown argument "${childPath}".`;
        continue;
      }
      if (childValue === undefined) continue;
      const childErr = _validateValue(childValue, childSchema, childPath);
      if (childErr) return childErr;
    }
  }
  return null;
}

/**
 * Validate parsed args against the tool's JSON-schema-style parameters.
 * This intentionally covers the shapes GemiX declares rather than trying to
 * become a second general JSON Schema implementation.
 */
function validateToolArgs(args, toolDef) {
  if (!toolDef?.function?.parameters) return null;
  const params = toolDef.function.parameters;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return 'Tool arguments must be a JSON object.';
  }
  return _validateValue(args, params, '');
}

export {
  makeTool,
  normalizeOptionalNullArgs,
  projectStrictToolParameters,
  validateToolArgs
};
