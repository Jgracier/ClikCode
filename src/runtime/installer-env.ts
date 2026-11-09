/** The environment a downloaded vendor installer script runs with: what an installer needs to find its tools, write into the home
 * directory and reach the network through a proxy, and nothing else. A third party's script must not receive the API keys, tokens and
 * session values that sit in ClikCode's own environment. `extra` (the step's own settings) is added on top. */
const KEEP = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  // Windows: the profile, system and program locations an installer resolves paths from.
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']);

export function installerEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (KEEP.has(name) || KEEP.has(name.toUpperCase()) || /^LC_/.test(name) || /^XDG_/.test(name)) kept[name] = value;
  }
  return { ...kept, ...extra };
}
