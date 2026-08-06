export type InjectMode = 'on' | 'off';

export type MetricEvent =
  | {
      type: 'inject';
      at: string;
      session?: string;
      mode?: InjectMode;
      dirty: number;
      deltaMs: number;
      retrieveMs: number;
      hits: number;
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
    };
