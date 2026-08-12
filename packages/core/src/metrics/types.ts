export type InjectMode = 'on' | 'off';

export type MetricEvent =
  | {
      type: 'inject';
      at: string;
      session?: string;
      agent?: string;
      mode?: InjectMode;
      /** Workspace path this inject was for — used to scope per-project hit rate. */
      workspace?: string;
      dirty: number;
      deltaMs: number;
      retrieveMs: number;
      hits: number;
      /**
       * When true this was a non-prompt housekeeping fire (no user query).
       * Exclude from hit rate denominator — it was never a retrieval attempt.
       */
      noPrompt?: boolean;
      /** Tokens actually written into agent context by this inject. */
      injectedTokens?: number;
      /** Estimated window-vs-file savings after path claims. */
      windowVsFileTokens?: number;
      /** Estimated discovery walk credit (0 or once per session). */
      discoveryTokens?: number;
      timedOutDelta: boolean;
      timedOutRetrieve: boolean;
    }
  | {
      type: 'guardrail';
      at: string;
      session?: string;
      tool: string;
      blocked: boolean;
      /** Tokens the block plausibly avoided (0 when not blocked). */
      tokensAvoided: number;
    }
  | {
      type: 'mcp';
      at: string;
      tool: string;
      ok: boolean;
      hits: number;
      /** Measured tokens in the tool response text. */
      responseTokens: number;
      /** Estimated window-vs-file savings after path claims. */
      windowVsFileTokens: number;
      /** Estimated discovery walk credit (0 or once per session). */
      discoveryTokens: number;
      paths: string[];
    }
  | {
      type: 'index';
      at: string;
      mode: 'full' | 'git' | 'paths';
      filesIndexed: number;
      ms: number;
    }
  | {
      type: 'doctor';
      at: string;
      ready: boolean;
      issueCount: number;
    }
  | {
      type: 'file-event';
      at: string;
      action: 'index' | 'delete';
      files: number;
      ms: number;
    }
  | {
      type: 'session-start';
      at: string;
      gitDelta: number;
      ms: number;
    }
  | {
      type: 'stop';
      at: string;
      session?: string;
      edited: boolean;
      paths: number;
    }
  | {
      type: 'routing';
      at: string;
      session?: string;
      agent: string;
      confidence: 'high' | 'medium' | 'low';
      reason: string;
    };
