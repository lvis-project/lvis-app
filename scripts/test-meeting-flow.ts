import {
  ElectronMeetingRecorder,
  MeetingPipeline,
  MockSttProvider,
  MockSummaryProvider,
} from "@lvis/plugin-meeting";

async function main() {
  const pipeline = new MeetingPipeline({
    sttProvider: new MockSttProvider(),
    summaryProvider: new MockSummaryProvider(),
    intermediateEveryFinalSegments: 1,
  });
  const recorder = new ElectronMeetingRecorder(pipeline);
  const sessionId = `meeting-test-${Date.now()}`;

  let segmentCount = 0;
  let intermediateSummary = "";
  let finalTitle = "";
  let finalSummary = "";

  recorder.on("segment", ({ count }) => {
    segmentCount += count;
  });
  recorder.on("intermediate-summary", ({ summary }) => {
    intermediateSummary = summary;
  });
  recorder.on("final-summary", ({ title, summary }) => {
    finalTitle = title;
    finalSummary = summary;
  });

  recorder.start(sessionId, {
    locale: "ko",
    contextHint: "lvis-app meeting plugin integration test",
  });

  await recorder.pushAudioChunk(sessionId, {
    pcm16leMono: Buffer.from([0x00, 0x01]),
    sampleRate: 16000,
    startSec: 0,
    endSec: 1.2,
  });
  await recorder.stop(sessionId);

  const transcript = pipeline.getTranscript(sessionId);
  if (segmentCount < 1) throw new Error("segment 이벤트가 발생하지 않았습니다.");
  if (!intermediateSummary.includes("중간 요약")) throw new Error("중간 요약 이벤트를 받지 못했습니다.");
  if (finalTitle !== "회의 요약") throw new Error(`최종 요약 제목이 예상과 다릅니다: ${finalTitle}`);
  if (!finalSummary || finalSummary.length === 0) throw new Error("최종 요약 본문이 비어 있습니다.");
  if (transcript.length < 1) throw new Error("전사 세그먼트가 누적되지 않았습니다.");

  console.log(
    JSON.stringify(
      {
        ok: true,
        sessionId,
        segmentCount,
        transcriptCount: transcript.length,
        intermediateSummary,
        finalTitle,
        finalSummary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
