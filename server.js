const express = require("express");
const app = express();

const port = process.env.PORT || 3000;

app.get("/ping", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`SchoolLive backend listening on port ${port}`);
});
