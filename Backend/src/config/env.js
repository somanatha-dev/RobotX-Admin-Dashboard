const path = require("path");
const dotenv = require("dotenv");

// Load env from Backend/.env (server.js lives in Backend/)
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

// Keep this module side-effect only; other modules can just `require()` it.
module.exports = {};
