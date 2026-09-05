// Dependency-free registry for the ready dedicated WhatsApp client. Keeping
// the mutable reference here lets adapters, tools and mention helpers share it
// without importing one another.

let dedicatedClient = null;

function setReadyDedicatedClient(client) {
  dedicatedClient = client || null;
}

function getReadyDedicatedClient() {
  return dedicatedClient;
}

export { getReadyDedicatedClient, setReadyDedicatedClient };
