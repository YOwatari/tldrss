export type Env = {
  DIGEST_CACHE: KVNamespace;
  AI: Ai;
  /** Workers AI model id; falls back to DEFAULT_AI_MODEL when unset. */
  AI_MODEL?: string;
};
