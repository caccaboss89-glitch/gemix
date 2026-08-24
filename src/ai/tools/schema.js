// src/ai/tools/schema.js
//
// Function-tool schema construction and the lightweight runtime hallucination
// guard shared by every tool catalog.

function makeTool({ name, description, properties = {}, required = [] }) {
  const tool = {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties }
    }
  };
  if (required.length > 0) tool.function.parameters.required = required;
  return tool;
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

function _validateObjectRequired(value, propSchema, pathPrefix) {
  if (propSchema.type !== 'object' || typeof value !== 'object' || Array.isArray(value)) return null;
  const nestedRequired = Array.isArray(propSchema.required) ? propSchema.required : [];
  const nestedProps = propSchema.properties || {};
  for (const nestedKey of nestedRequired) {
    const nestedSchema = nestedProps[nestedKey];
    const allowEmpty = Boolean(nestedSchema && nestedSchema.allowEmpty);
    const nestedVal = value[nestedKey];
    if (nestedVal === undefined || nestedVal === null || (nestedVal === '' && !allowEmpty)) {
      return `Missing required argument "${pathPrefix}.${nestedKey}".`;
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
  const required = Array.isArray(params.required) ? params.required : [];
  const props = params.properties || {};
  for (const key of required) {
    const propSchema = props[key];
    const allowEmpty = Boolean(propSchema && propSchema.allowEmpty);
    const val = args[key];
    if (val === undefined || val === null || (val === '' && !allowEmpty)) {
      return `Missing required argument "${key}".`;
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const propSchema = props[key];
    if (!propSchema || value === undefined || value === null) continue;
    if (propSchema.type === 'array' && required.includes(key) && Array.isArray(value) && value.length === 0) {
      return `Argument "${key}" must be a non-empty array.`;
    }
    if (!_matchesType(value, propSchema.type)) {
      return `Argument "${key}" has wrong type (expected ${propSchema.type}).`;
    }
    if (propSchema.type === 'object' && typeof value === 'object' && !Array.isArray(value)) {
      const nestedErr = _validateObjectRequired(value, propSchema, key);
      if (nestedErr) return nestedErr;
    }
    if (propSchema.type === 'array' && Array.isArray(value)) {
      if (Number.isInteger(propSchema.minItems) && value.length < propSchema.minItems) {
        return `Argument "${key}" must contain at least ${propSchema.minItems} item(s).`;
      }
      if (Number.isInteger(propSchema.maxItems) && value.length > propSchema.maxItems) {
        return `Argument "${key}" must contain at most ${propSchema.maxItems} item(s).`;
      }
    }
    if (propSchema.type === 'array' && Array.isArray(value) && propSchema.items?.type === 'object') {
      const itemSchema = propSchema.items;
      const itemProps = itemSchema.properties || {};
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          return `Argument "${key}[${i}]" must be an object.`;
        }
        const itemErr = _validateObjectRequired(item, itemSchema, `${key}[${i}]`);
        if (itemErr) return itemErr;
        for (const [itemKey, itemVal] of Object.entries(item)) {
          const fieldSchema = itemProps[itemKey];
          if (!fieldSchema || itemVal === undefined || itemVal === null) continue;
          if (fieldSchema.type === 'object' && typeof itemVal === 'object' && !Array.isArray(itemVal)) {
            const nestedErr = _validateObjectRequired(itemVal, fieldSchema, `${key}[${i}].${itemKey}`);
            if (nestedErr) return nestedErr;
          }
        }
      }
    }
    if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0 && typeof value === 'string') {
      if (!propSchema.enum.includes(value)) {
        return `Argument "${key}" must be one of: ${propSchema.enum.join(', ')}.`;
      }
    }
  }
  return null;
}

export { makeTool, validateToolArgs };
