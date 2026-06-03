const { responsesToAssistantMessage, chatMessagesToResponsesInput } = require('../src/ai/responsesAdapter');

const data = {
  output: [
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
if (!msg._responsesOutputSequence || msg._responsesOutputSequence.length !== 2) {
  console.error('FAIL: expected 2 replay items', msg._responsesOutputSequence);
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
if (!hasCi || !hasFc || !hasOut) {
  console.error('FAIL input', types);
  process.exit(1);
}
console.log('OK', types);