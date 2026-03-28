const crypto = require("crypto");

function ipToId(ip) {
  if (!ip) return "unknown";
  if (ip.startsWith("::ffff:")) {
    ip = ip.replace("::ffff:", "");
  }
  ip = ip.replace(/^\[|\]$/g, "");
  return crypto
    .createHash("sha256")
    .update(ip)
    .digest("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 12);
}

module.exports = { ipToId };
