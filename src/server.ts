import "dotenv/config";

import { app } from "./app";
import { env } from "./config/env";
import { startBellsScheduler } from "./modules/bells/bell.scheduler";
import { startRadioScheduler } from "./modules/radio/radio.scheduler";
import usersAdminRoutes from "./modules/users/users.admin.routes";

startBellsScheduler();
startRadioScheduler();

app.use("/admin/users", usersAdminRoutes);
app.listen(env.PORT, () => {
  console.log(`API listening on port ${env.PORT}`);
});