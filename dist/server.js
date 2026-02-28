"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config"); // <-- EZ HIÁNYZOTT
const app_1 = require("./app");
const env_1 = require("./config/env");
app_1.app.listen(env_1.env.PORT, () => {
    console.log(`API listening on port ${env_1.env.PORT}`);
});
