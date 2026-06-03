const { responsesToAssistantMessage, chatMessagesToResponsesInput } = require('../src/ai/responsesAdapter');

const data = {
  output: [
    {
      type: 'reasoning',
      id: 'rs_test',
      status: 'completed',
      encrypted_content: 'encrypted-blob-test',
    },
    {
      type: 'code_interpreter_call',
      id: 'ci_1',
      status: 'completed',
      code: 'print(2+2)',
      outputs: [{ type: 'logs', logs: '4\n' }],
    },
    { type: 'function_call', call_id: 'call-1', name: 'web_x_search', arguments: '{}' },
  ],
};

const msg = responsesToAssistantMessage(data);
if (!msg._responsesOutput || msg._responsesOutput.length !== 3) {
  console.error('FAIL: expected 3 replay items', msg._responsesOutput);
  process.exit(1);
}
const hasReasoning = msg._responsesOutput.some((i) => i.type === 'reasoning');
if (!hasReasoning) {
  console.error('FAIL: missing reasoning item');
  process.exit(1);
}

const { input } = chatMessagesToResponsesInput([
  { role: 'user', content: 'hi' },
  msg,
  { role: 'tool', tool_call_id: 'call-1', content: '{"success":true}' },
]);

const types = input.map((i) => i.type || `${i.role}`);
const hasCi = input.some((i) => i.type === 'code_interpreter_call');
const hasFc = input.some((i) => i.type === 'function_call');
const hasOut = input.some((i) => i.type === 'function_call_output');
const hasRs = input.some((i) => i.type === 'reasoning');
if (!hasCi || !hasFc || !hasOut || !hasRs) {
  console.error('FAIL input', types);
  process.exit(1);
}
const rsIdx = types.indexOf('reasoning');
const fcIdx = types.indexOf('function_call');
if (rsIdx > fcIdx) {
  console.error('FAIL: reasoning should precede function_call in input order', types);
  process.exit(1);
}
console.log('OK', types);