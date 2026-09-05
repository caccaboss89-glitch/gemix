let terminating = false;

function beginTermination() {
  const wasTerminating = terminating;
  terminating = true;
  return !wasTerminating;
}

function isTerminating() {
  return terminating;
}

function _resetTerminationForTests() {
  terminating = false;
}

export { beginTermination, isTerminating, _resetTerminationForTests };
