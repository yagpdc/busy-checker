import cors from "cors";
import express from "express";
import path from "node:path";
import { config } from "./config.js";
import authRouter from "./routes/auth.js";
import heartbeatRouter from "./routes/heartbeat.js";
import queryRouter from "./routes/query.js";
import scheduleRouter from "./routes/schedule.js";
import slotsRouter from "./routes/slots.js";
import versionRouter from "./routes/version.js";

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
app.use("/slots", slotsRouter);
app.use("/version", versionRouter);

// Static dir for distributing the built extension .zip. The popup's
// update banner fetches /version → downloadUrl → this path. The dir is
// mounted from the host via docker-compose so we don't have to rebuild
// the image to publish a new zip; just scp the file in.
app.use(
  "/extension",
  express.static(path.resolve(process.cwd(), "public/extension"), {
    fallthrough: true,
    maxAge: "1h",
  }),
);

app.listen(config.port, () => {
  console.log(`busy-checker backend listening on :${config.port}`);
});
