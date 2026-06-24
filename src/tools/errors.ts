/** Map any thrown value into a structured AdoError for the MCP boundary. */
import { AdoError, rehydrateSentinel } from "../errors.js";

export function toAdoError(e: unknown): AdoError {
  if (e instanceof AdoError) return e;
  return rehydrateSentinel(e);
}
