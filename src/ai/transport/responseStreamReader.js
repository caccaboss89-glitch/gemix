import { SseDecoder } from './sse.js';
import { ResponseAssembler } from './responsesProtocol.js';
import constants from '../../config/constants.js';
import {
  TRANSPORT_ERROR,
  TransportError,
  classifyStreamFailure
} from './errors.js';

function _eventKeys(event, item = null) {
  const keys = [];
  if (Number.isInteger(event?.output_index)) keys.push(`idx:${event.output_index}`);
  const itemId = item?.id || event?.item_id;
  if (itemId) keys.push(`id:${itemId}`);
  return keys;
}

/**
 * Bound the production failure where schedule_tasks streams tiny argument
 * fragments without ever completing. An unfinished call has not reached the
 * executor, so crossing this guard is safe to replay.
 */
function _observeScheduleArguments(event, scheduleCallKeys, state, errorFactory, requestId) {
  if (event?.type === 'response.output_item.added'
      && event.item?.type === 'function_call'
      && event.item?.name === 'schedule_tasks') {
    for (const key of _eventKeys(event, event.item)) scheduleCallKeys.add(key);
    return;
  }
  if (event?.type !== 'response.function_call_arguments.delta') return;
  const keys = _eventKeys(event);
  if (!keys.some(key => scheduleCallKeys.has(key))) return;

  state.count += 1;
  if (state.count <= constants.MODEL_STREAM_MAX_SCHEDULE_ARGUMENT_DELTAS) return;
  throw errorFactory(
    TRANSPORT_ERROR.TRANSIENT,
    `schedule_tasks arguments exceeded ${constants.MODEL_STREAM_MAX_SCHEDULE_ARGUMENT_DELTAS} stream fragments without completing.`,
    { partial: false, requestId }
  );
}

/** Consume and validate one Responses SSE body without owning retry policy. */
async function consumeResponseStream({ response, budget, requestId, capture, errorFactory, log }) {
  const decoder = new SseDecoder();
  const assembler = new ResponseAssembler();
  const scheduleCallKeys = new Set();
  const scheduleArgumentState = { count: 0 };

  try {
    try {
      for await (const chunk of response.body) {
        if (capture) {
          capture.receivedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
        }
        for (const event of decoder.push(chunk)) {
          if (capture) capture.events.push(event);
          _observeScheduleArguments(event, scheduleCallKeys, scheduleArgumentState, errorFactory, requestId);
          assembler.apply(event);
        }
        if (budget.expired) {
          throw errorFactory(TRANSPORT_ERROR.TIMEOUT, 'Model-call budget expired while reading the stream.', {
            partial: assembler.sawMeaningfulEvent,
            requestId
          });
        }
      }
      for (const event of decoder.end()) {
        if (capture) capture.events.push(event);
        _observeScheduleArguments(event, scheduleCallKeys, scheduleArgumentState, errorFactory, requestId);
        assembler.apply(event);
      }
    } catch (err) {
      if (err instanceof TransportError) throw err;
      if (budget.signal.aborted || err?.name === 'AbortError') {
        throw errorFactory(
          TRANSPORT_ERROR.TIMEOUT,
          'Model-call budget expired while reading the stream.',
          { partial: assembler.sawMeaningfulEvent, requestId }
        );
      }
      throw errorFactory(
        assembler.sawMeaningfulEvent ? TRANSPORT_ERROR.MALFORMED : TRANSPORT_ERROR.TRANSIENT,
        `Model stream ended early: ${err.message}`,
        { partial: assembler.sawMeaningfulEvent, requestId }
      );
    }

    if (decoder.malformedEvents > 0) {
      throw errorFactory(
        TRANSPORT_ERROR.MALFORMED,
        `Model stream contained ${decoder.malformedEvents} malformed event(s).`,
        { partial: assembler.sawMeaningfulEvent, requestId }
      );
    }
    if (assembler.error) {
      const message = assembler.error.message || JSON.stringify(assembler.error).slice(0, 300);
      throw errorFactory(classifyStreamFailure(assembler.error), `Model reported an error: ${message}`, {
        requestId,
        partial: assembler.sawMeaningfulEvent
      });
    }
    if (assembler.status === 'failed') {
      throw errorFactory(TRANSPORT_ERROR.MALFORMED, 'Model reported a failed response.', { requestId });
    }
    if (assembler.hasIncompleteOutputItems) {
      throw errorFactory(
        TRANSPORT_ERROR.MALFORMED,
        'Model stream closed before finalizing every output item.',
        { partial: true, requestId }
      );
    }
    if (!assembler.status) {
      if (!assembler.sawMeaningfulEvent) {
        throw errorFactory(TRANSPORT_ERROR.TRANSIENT, 'Model stream closed before sending anything.', {
          partial: false,
          requestId
        });
      }
      if (!assembler.hasOutputItems) {
        throw errorFactory(
          TRANSPORT_ERROR.MALFORMED,
          'Model stream closed after deltas but before completing an output item.',
          { partial: true, requestId }
        );
      }
      log.warn('stream closed without a terminal event; using the items already received');
    }

    return {
      response: assembler.toResponse(),
      requestId,
      usage: assembler.usage
    };
  } finally {
    if (capture) capture.assembledResponse = assembler.toResponse();
  }
}

export { consumeResponseStream };
