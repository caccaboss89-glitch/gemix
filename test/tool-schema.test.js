import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_GENERATE_VIDEO } from '../src/ai/tools/mediaCatalog.js';
import { buildEmailTool, buildWhatsAppTool } from '../src/ai/tools/deliveryCatalog.js';
import { buildManagePreferencesTool } from '../src/ai/tools/preferenceCatalog.js';
import {
  makeTool,
  normalizeOptionalNullArgs,
  projectStrictToolParameters,
  validateToolArgs
} from '../src/ai/tools/schema.js';
import { buildRemoveMyTasksTool, buildScheduleTasksTool } from '../src/ai/tools/taskCatalog.js';
import { TOOL_SEARCH_IMAGE, TOOL_SEARCH_WEB } from '../src/ai/tools/webCatalog.js';
import { workspaceTools } from '../src/ai/tools/workspaceCatalog.js';
import constants from '../src/config/constants.js';
import envConfig from '../src/config/env.js';
import { getToolsForUser } from '../src/ai/tools.js';
import { _resetActiveProfileForTests } from '../src/ai/providers/providerProfile.js';

function parametersOf(tool) {
  return tool.function.parameters;
}

function workspaceTool(name) {
  return workspaceTools().find(tool => tool.function.name === name);
}

test('runtime tool validation enforces declared array cardinality', () => {
  const tool = makeTool({
    name: 'bounded',
    properties: {
      items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 }
    },
    required: ['items']
  });
  assert.equal(validateToolArgs({ items: ['a'] }, tool), null);
  assert.match(validateToolArgs({ items: [] }, tool), /non-empty|at least/);
  assert.match(validateToolArgs({ items: ['a', 'b', 'c'] }, tool), /at most 2/);
});

test('function schemas close every declared object recursively', () => {
  const tool = makeTool({
    name: 'closed',
    properties: {
      options: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } }
      },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            metadata: {
              type: 'object',
              properties: { label: { type: 'string' } }
            }
          }
        }
      }
    }
  });
  const params = parametersOf(tool);
  assert.equal(params.additionalProperties, false);
  assert.equal(params.properties.options.additionalProperties, false);
  assert.equal(params.properties.rows.items.additionalProperties, false);
  assert.equal(params.properties.rows.items.properties.metadata.additionalProperties, false);

  assert.match(validateToolArgs({ stray: true }, tool), /Unknown argument "stray"/);
  assert.match(validateToolArgs({ options: { stray: true } }, tool), /Unknown argument "options.stray"/);
  assert.match(
    validateToolArgs({ rows: [{ metadata: { stray: true } }] }, tool),
    /Unknown argument "rows\[0\]\.metadata\.stray"/
  );
});

test('strict wire projection preserves canonical optional arguments through null normalization', () => {
  const tool = makeTool({
    name: 'strict_projection',
    properties: {
      query: { type: 'string' },
      count: { type: 'integer' },
      options: {
        type: 'object',
        properties: {
          locale: { type: 'string' },
          safe: { type: 'boolean' }
        },
        required: ['locale']
      }
    },
    required: ['query']
  });
  const canonical = tool.function.parameters;
  const projected = projectStrictToolParameters(canonical);

  assert.deepEqual(projected.required, ['query', 'count', 'options']);
  assert.deepEqual(projected.properties.count.type, ['integer', 'null']);
  assert.deepEqual(projected.properties.options.type, ['object', 'null']);
  assert.deepEqual(projected.properties.options.required, ['locale', 'safe']);
  assert.deepEqual(projected.properties.options.properties.safe.type, ['boolean', 'null']);

  const normalized = normalizeOptionalNullArgs({
    query: 'x',
    count: null,
    options: { locale: 'it', safe: null }
  }, canonical);
  assert.deepEqual(normalized, { query: 'x', options: { locale: 'it' } });
  assert.equal(validateToolArgs(normalized, tool), null);
});

test('runtime validation applies scalar and collection constraints at every depth', () => {
  const tool = makeTool({
    name: 'constraints',
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 2 },
      code: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[A-Z]+$' },
      level: { type: 'integer', enum: [1, 2] },
      rows: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: {
          type: 'object',
          properties: {
            score: { type: 'number', minimum: 0, maximum: 1 },
            tags: { type: 'array', items: { type: 'string', maxLength: 3 } }
          },
          required: ['score']
        }
      }
    },
    required: ['count', 'code', 'level', 'rows']
  });
  const valid = { count: 1, code: 'OK', level: 2, rows: [{ score: 0.5, tags: ['yes'] }] };
  assert.equal(validateToolArgs(valid, tool), null);
  assert.match(validateToolArgs({ ...valid, count: 0 }, tool), /at least 1/);
  assert.match(validateToolArgs({ ...valid, count: 3 }, tool), /at most 2/);
  assert.match(validateToolArgs({ ...valid, code: 'A' }, tool), /at least 2 character/);
  assert.match(validateToolArgs({ ...valid, code: 'ABCDE' }, tool), /at most 4 character/);
  assert.match(validateToolArgs({ ...valid, code: 'ok' }, tool), /required format/);
  assert.match(validateToolArgs({ ...valid, level: 3 }, tool), /must be one of: 1, 2/);
  assert.match(validateToolArgs({ ...valid, rows: [] }, tool), /at least 1 item/);
  assert.match(validateToolArgs({ ...valid, rows: [{ score: 2 }] }, tool), /rows\[0\]\.score.*at most 1/);
  assert.match(validateToolArgs({ ...valid, rows: [{ score: 1, tags: ['long'] }] }, tool), /rows\[0\]\.tags\[0\].*at most 3/);
});

test('catalog schemas formalize their documented portable limits', () => {
  const webCount = parametersOf(TOOL_SEARCH_WEB).properties.count;
  assert.equal(webCount.minimum, constants.SEARCH_WEB_MIN_COUNT);
  assert.equal(webCount.maximum, constants.SEARCH_WEB_MAX_COUNT);
  const imageCount = parametersOf(TOOL_SEARCH_IMAGE).properties.count;
  assert.equal(imageCount.minimum, constants.SEARCH_IMAGE_MIN_COUNT);
  assert.equal(imageCount.maximum, constants.SEARCH_IMAGE_MAX_COUNT);

  const readFile = parametersOf(workspaceTool('read_file')).properties;
  assert.equal(readFile.offset.minimum, 1);
  assert.equal(readFile.limit.minimum, 1);
  const shellTimeout = parametersOf(workspaceTool('shell')).properties.timeoutSeconds;
  assert.equal(shellTimeout.minimum, 1);
  assert.equal(shellTimeout.maximum, constants.SHELL_TIMEOUT_MAX_MS / 1000);

  const preferences = parametersOf(buildManagePreferencesTool(false)).properties;
  assert.equal(preferences.memory.maxLength, 1000);
  assert.equal(parametersOf(TOOL_GENERATE_VIDEO).properties.reference_images.maxItems, constants.MAX_REF_IMAGES_FOR_VIDEO);

  const schedule = buildScheduleTasksTool(true, false, false);
  const scheduleParams = parametersOf(schedule);
  assert.equal(scheduleParams.properties.tasks.minItems, 1);
  const scheduledAt = scheduleParams.properties.tasks.items.properties.scheduledAt;
  assert.match('2026-12-01T12:00:00', new RegExp(scheduledAt.pattern));
  assert.doesNotMatch('2026-12-01T12:00:00Z', new RegExp(scheduledAt.pattern));
  assert.doesNotMatch('2026-12-01T12:00:00+01:00', new RegExp(scheduledAt.pattern));
  assert.match(
    validateToolArgs({ tasks: [{ content: 'Test', scheduledAt: '2026-12-01T12:00:00Z' }] }, schedule),
    /required format/
  );

  const remove = buildRemoveMyTasksTool(false);
  assert.equal(parametersOf(remove).properties.taskIds.minItems, 1);
  assert.match(validateToolArgs({ taskIds: [] }, remove), /at least 1 item/);

  const whatsapp = buildWhatsAppTool(true);
  assert.match(
    validateToolArgs({ recipient: { phone: '393123' }, message: 'test' }, whatsapp),
    /required format/
  );
  const email = buildEmailTool(true);
  assert.match(
    validateToolArgs({ recipient: { email: 'not-an-email' }, subject: 's', body: 'b' }, email),
    /required format/
  );
});

const PORTABLE_INPUT_SCHEMA_KEYS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern'
]);

function assertPortableInputSchema(schema, location) {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), `${location} must be an object`);
  for (const keyword of Object.keys(schema)) {
    assert.ok(
      PORTABLE_INPUT_SCHEMA_KEYS.has(keyword),
      `${location} uses unsupported input-schema keyword "${keyword}"`
    );
  }
  for (const [name, child] of Object.entries(schema.properties || {})) {
    assertPortableInputSchema(child, `${location}.properties.${name}`);
  }
  if (schema.items) assertPortableInputSchema(schema.items, `${location}.items`);
}

test('every offered function tool uses only the provider-portable input-schema subset', () => {
  const savedProvider = envConfig.AI_PROVIDER;
  try {
    for (const provider of ['xai', 'chatgpt', 'openrouter', 'custom']) {
      envConfig.AI_PROVIDER = provider;
      _resetActiveProfileForTests();
      for (const platform of [
        constants.PLATFORM_DISCORD,
        constants.PLATFORM_WA_DEDICATED,
        constants.PLATFORM_WA_PERSONAL
      ]) {
        for (const isGroup of [false, true]) {
          for (const isActiveMember of [false, true]) {
            for (const isAdmin of [false, true]) {
              const tools = getToolsForUser({ platform, isGroup, isActiveMember, isAdmin });
              for (const tool of tools.filter(candidate => candidate.type === 'function')) {
                assertPortableInputSchema(
                  tool.function.parameters,
                  `${provider}/${platform}/${tool.function.name}`
                );
              }
            }
          }
        }
      }
    }
  } finally {
    envConfig.AI_PROVIDER = savedProvider;
    _resetActiveProfileForTests();
  }
});
