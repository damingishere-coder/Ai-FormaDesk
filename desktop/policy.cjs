const path = require("node:path");
const os = require("node:os");
function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
function safeExternal(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}
function executablePath(env = process.env) {
  return [
    ...new Set(
      [
        path.join(os.homedir(), ".local/bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        ...(env.PATH || "").split(path.delimiter),
      ].filter(Boolean),
    ),
  ].join(path.delimiter);
}
module.exports = { sameOrigin, safeExternal, executablePath };
