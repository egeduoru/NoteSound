import { loadConfig, startCatalogServer } from "./index.mjs";

await startCatalogServer(
  loadConfig({ ...process.env, PORT: process.env.DISCOVERY_PORT || "3002" }),
);
