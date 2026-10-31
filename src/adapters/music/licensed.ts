import { createRemoteCatalogProvider } from "./hitmoz";
export const createLicensedProvider = (
  options: Parameters<typeof createRemoteCatalogProvider>[1] = {},
) => createRemoteCatalogProvider("licensed", options);
export const licensedAdapter = createLicensedProvider();
