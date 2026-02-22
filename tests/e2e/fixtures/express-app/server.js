/* global process, console */
import express from "express";

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);

app.get("/", (_req, res) => {
  res.send("<h1>hello from express</h1>");
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Listening on http://127.0.0.1:${port}`);
});
