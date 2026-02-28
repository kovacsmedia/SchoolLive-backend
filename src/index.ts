import express from "express";
import cors from "cors";

import authRouter from "./routes/auth";
import devicesRouter from "./routes/devices";
import adminDevicesRouter from "./routes/adminDevices";
import adminCommandsRouter from "./routes/adminCommands";

const app = express();

app.use(express.json());

// CORS - nálad lehet külön middleware; ha már megvan, ezt hagyd úgy ahogy nálad van
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

// Routes
app.use("/auth", authRouter);
app.use("/devices", devicesRouter);

// Admin routes (nálad lehet, hogy már /admin alatt van egy "adminRouter" -
// ebben az esetben ezt a kettőt oda kell beimportálni és adminRouter.use(...) formában betenni)
app.use("/admin", adminDevicesRouter);
app.use("/admin", adminCommandsRouter);

// Healthcheck (ha nálad van ilyen, maradhat)
app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  console.log(`SchoolLive backend listening on :${port}`);
});