import { SseDecoder } from './sse.js';
import { ResponseAssembler } from './responsesProtocol.js';
import {
  TRANSPORT_ERROR,
  TransportError,
  classifyStreamFailure
} from './errors.js';

/** Consume and validate one Responses SSE body without owning retry policy. */
async function consumeResponseStream({ response, budget, requestId, capture, errorFactory, log }) {
  const decoder = new SseDecoder();
  const assembler = new ResponseAssembler();

  try {
    try {
      for await (const chunk of response.body) {
        if (capture) {
          capture.receivedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
        }
        for (const event of decoder.push(chunk)) {
          if (capture) capture.events.push(event);
          assembler.apply(event);
        }
        if (budget.expired) {
          throw errorFactory(TRANSPORT_ERROR.TIMEOUT, 'Turn budget expired while reading the model stream.', {
            partial: assembler.sawMeaningfulEvent,
            requestId
          });
        }
      }
      for (const event of decoder.end()) {
        if (capture) capture.events.push(event);
        assembler.apply(event);
      }
    } catch (err) {
      if (err instanceof TransportError) throw err;
      if (budget.signal.aborted || err?.name === 'AbortError') {
        throw errorFactory(
          TRANSPORT_ERROR.TIMEOUT,
          'Turn budget expired while reading the model stream.',
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
