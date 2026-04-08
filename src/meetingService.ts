import {
  ElectronMeetingRecorder,
  MeetingPipeline,
  MockSttProvider,
  MockSummaryProvider,
  type FinalSummary,
  type MeetingContext,
  type TranscriptSegment,
} from "@lvis/plugin-meeting";

export interface LvisMeetingServiceOptions {
  intermediateEveryFinalSegments?: number;
}

export interface MeetingAudioChunkPayload {
  pcm16leMono: number[];
  sampleRate: number;
  startSec: number;
  endSec: number;
}

export class LvisMeetingService {
  private readonly pipeline: MeetingPipeline;
  private readonly recorder: ElectronMeetingRecorder;
  private readonly finalSummaries = new Map<string, FinalSummary>();

  constructor(options?: LvisMeetingServiceOptions) {
    this.pipeline = new MeetingPipeline({
      sttProvider: new MockSttProvider(),
      summaryProvider: new MockSummaryProvider(),
      intermediateEveryFinalSegments: options?.intermediateEveryFinalSegments ?? 2,
    });
    this.recorder = new ElectronMeetingRecorder(this.pipeline);
    this.recorder.on("final-summary", ({ sessionId, title, summary }) => {
      this.finalSummaries.set(sessionId, {
        title,
        summary,
        highlights: [],
        actionItems: [],
        createdAt: new Date().toISOString(),
      });
    });
  }

  startSession(sessionId: string, context?: MeetingContext): { sessionId: string; started: true } {
    this.recorder.start(sessionId, context);
    return { sessionId, started: true };
  }

  async pushAudioChunk(sessionId: string, chunk: MeetingAudioChunkPayload): Promise<{ sessionId: string; added: number }> {
    await this.recorder.pushAudioChunk(sessionId, {
      pcm16leMono: Buffer.from(chunk.pcm16leMono),
      sampleRate: chunk.sampleRate,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
    });
    const transcript = this.pipeline.getTranscript(sessionId);
    return {
      sessionId,
      added: transcript.length,
    };
  }

  async stopSession(sessionId: string): Promise<FinalSummary> {
    await this.recorder.stop(sessionId);
    const finalSummary = this.finalSummaries.get(sessionId);
    if (!finalSummary) {
      throw new Error(`final summary not found: ${sessionId}`);
    }
    return finalSummary;
  }

  getTranscript(sessionId: string): TranscriptSegment[] {
    return this.pipeline.getTranscript(sessionId);
  }
}
