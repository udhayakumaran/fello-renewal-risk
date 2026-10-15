// Scheduled by vercel.json. Runs the nightly pipeline for every org.
// Only callers presenting CRON_SECRET may run it.
import { runNightly } from "../../dist/src/pipeline/nightly.js";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401;
    res.end("unauthorised");
    return;
  }
  const asOf = process.env.AS_OF ?? new Date().toISOString().slice(0, 10);
  const { failures } = await runNightly(asOf);
  res.statusCode = failures > 0 ? 500 : 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ asOf, failures }));
}
