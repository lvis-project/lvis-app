export type AiProviderPingResult =
  | {
      configured: true;
      online: true;
      vendor: string;
      model: string;
      latencyMs: number;
    }
  | {
      configured: true;
      online: false;
      vendor: string;
      model: string;
      error: string;
      latencyMs?: number;
    }
  | {
      configured: false;
      online: false;
      vendor: string;
      model?: string;
      error: "not-configured";
    };

export type AiProviderPingIpcResult =
  | AiProviderPingResult
  | { ok: false; error: "unauthorized-frame" };
