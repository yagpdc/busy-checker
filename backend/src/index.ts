import cors from "cors";
import express from "express";
import { config } from "./config.js";
import authRouter from "./routes/auth.js";
import heartbeatRouter from "./routes/heartbeat.js";
import queryRouter from "./routes/query.js";
import scheduleRouter from "./routes/schedule.js";

const app = express();

app.use(express.json({ limit: "32kb" }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (config.corsOrigins.length === 0) return cb(null, true);
      cb(null, config.corsOrigins.includes(origin));
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/auth", authRouter);
app.use("/heartbeat", heartbeatRouter);
app.use("/query", queryRouter);
app.use("/schedule", scheduleRouter);

app.listen(config.port, () => {
  console.log(`busy-checker backend listening on :${config.port}`);
});
