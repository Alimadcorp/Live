const fs = require("fs")
fs.writeFileSync("./lib/page.js", `const page = \`${btoa(fs.readFileSync("./b.html", "utf-8"))}\`; \nmodule.exports = { page }; `, "utf-8");