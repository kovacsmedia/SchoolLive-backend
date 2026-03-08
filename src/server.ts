import "dotenv/config";
import { app } from "./app";
import { env } from "./config/env";
import usersAdminRoutes from "./modules/users/users.admin.routes";
import radioRoutes from "./modules/radio/radio.routes";
import { startRadioScheduler } from "./modules/radio/radio.scheduler";

app.use("/admin/users", usersAdminRoutes);
app.use("/radio", radioRoutes);

startRadioScheduler();

app.listen(env.PORT, () => {
  console.log(`API listening on port ${env.PORT}`);
});