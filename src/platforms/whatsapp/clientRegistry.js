// src/platforms/whatsapp/clientRegistry.js
//
// The live dedicated-account client handle, published here by dedicated.js as
// soon as it is created.
//
// Low-level utilities (mention resolution, group participants) need the client
// but must not import the platform module for it: that edge pulls the whole
// message-handling graph — shared.js, handler.js, the tool registry — into
// utils/, and closes an import cycle whose only symptom is a temporal-dead-zone
// crash that depends on which module happened to be loaded first. This registry
// has no imports of its own, so it can be read from anywhere.

let _client = null;

/**
 * Publish the dedicated client. Called once by dedicated.js at init.
 * @param {object} client - whatsapp-web.js Client instance
 */
function setDedicatedClient(client) {
  _client = client;
}

/**
 * The dedicated client, or null before init.
 * @returns {object|null}
 */
function getDedicatedClient() {
  return _client;
}

/** True once the client has finished authenticating. */
function isDedicatedClientReady() {
  return Boolean(_client?.info?.wid?._serialized);
}

export { setDedicatedClient, getDedicatedClient, isDedicatedClientReady };
