import "dotenv/config";   // <-- EZ HIÁNYZOTT

import { app } from "./app";
import { env } from "./config/env";
import usersAdminRoutes from "./modules/users/users.admin.routes";
app.use("/admin/users", usersAdminRoutes);
app.listen(env.PORT, () => {
  console.log(`API listening on port ${env.PORT}`);
});