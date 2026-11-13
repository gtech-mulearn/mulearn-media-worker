// Parses a .env file the same way `wrangler dev` reads it, so `npm run deploy`
// uploads exactly the values that worked locally.
//
// Rules (Wrangler uses dotenv + dotenv-expand):
//   - blank lines and lines starting with # are ignored; an optional "export " is allowed
//   - 'single' and "double" quoted values keep # and spaces; text after the closing quote is ignored
//   - in "double" quotes, \n becomes a newline
//   - unquoted values end at " #" (inline comment) and are trimmed
//   - \$ is a literal $. An unescaped $ is rejected, because Wrangler would expand it
//     as a variable (even inside single quotes) and the uploaded value would differ.

export class EnvFileError extends Error {}

/** @param {string} text @returns {Record<string, string>} */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {};
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) throw new EnvFileError(`line ${i + 1}: expected KEY=value`);
    const [, key, rest] = m;

    let value;
    const q = rest[0];
    if (q === "'" || q === '"') {
      const end = rest.indexOf(q, 1);
      if (end === -1) throw new EnvFileError(`line ${i + 1}: ${key} has no closing ${q}`);
      value = rest.slice(1, end);
      if (q === '"') value = value.replace(/\\n/g, "\n");
    } else {
      const hash = rest.search(/\s#/);
      value = (hash === -1 ? rest : rest.slice(0, hash)).trim();
    }

    if (/(^|[^\\])\$/.test(value)) {
      throw new EnvFileError(`line ${i + 1}: ${key} contains "$"; write it as "\\$"`);
    }
    out[key] = value.replace(/\\\$/g, "$");
  });
  return out;
}
