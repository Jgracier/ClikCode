// Prints the catalog fields the rig needs, as JSON: node catalog-dump.cjs <dist/harness-catalog.cjs>
const harnesses = require(require('node:path').resolve(process.argv[2])).AI_LOCAL_HARNESSES;
console.log(JSON.stringify(harnesses.map((h) => ({
  command: h.command, binary: h.binary, acpBinary: h.acp?.binary ?? null, transport: h.transport, parser: h.parser,
  capabilities: h.capabilities ?? null, authEnv: h.authEnv ?? [], authFiles: h.authFiles ?? [], statusArgv: h.statusArgv ?? null,
  signInOptional: Boolean(h.signInOptional), localAuth: h.localAuth ?? [], profileEnv: h.profileEnv ?? null,
  displayName: h.displayName, output: h.turn?.output ?? null,
  providerConfigId: h.acp?.providerConfigId ?? null,
}))));
