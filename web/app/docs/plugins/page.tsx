import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { Badge } from "@/components/ui/badge";

const plugins = [
  { slug: "local-indexer", title: "Local Indexer", id: "local-indexer", ver: "0.4.11", scope: "Local · RAG", desc: "kiwipiepy 한국어 형태소 + pymupdf4llm + FTS5 + LanceDB. chokidar 폴더 감시.", color: "from-teal/10 to-transparent" },
  { slug: "ms-graph", title: "Microsoft 365 (Outlook)", id: "ms-graph", ver: "0.3.28", scope: "Mail · Calendar", desc: "MSAL OAuth + Electron safeStorage 토큰. mail + calendar 31개 도구.", color: "from-accent/60 to-transparent" },
  { slug: "meeting", title: "Meeting", id: "meeting", ver: "0.4.18", scope: "Audio · STT", desc: "OpenAI Whisper API (gpt-4o-transcribe) + PCM16LE 16kHz/3sec 청크.", color: "from-coral/10 to-transparent" },
  { slug: "work-assistant", title: "Work Assistant (업무도우미)", id: "work-assistant", ver: "0.7.0", scope: "Proactive", desc: "10+ detector → triggerConversation + showOverlay. mail/calendar/meeting 신호 통합.", color: "from-citron/30 to-transparent" },
  { slug: "agent-hub", title: "Agent Hub Sidebar", id: "agent-hub", ver: "0.8.1", scope: "Host UI Plugin", desc: "‘업무 보드’ 사이드바 + 43개 도구 + 5분 polling. agent-hub.lvisai.xyz 와 통신.", color: "from-ink/[0.06] to-transparent" },
  { slug: "lge-api", title: "LGE EP (이피)", id: "lge-api", ver: "0.12.9", scope: "사내 포털", desc: "EP/Space/NHRS/LGenie/주차 — 24개 도구. openAuthWindow 세션 + 사내망 DNS 게이트.", color: "from-coral/10 to-transparent" },
];

export const metadata = { title: "플러그인 — 개요" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Plugins"
        title="플러그인 — 호스트가 모르는 기능을 붙이는 단위"
        description="LVIS의 모든 도메인 기능 (메일·캘린더·회의·문서·사내 API)은 플러그인으로 분리됩니다. 호스트 코어는 플러그인 specific 코드를 import하지 않습니다 (SDK type-only + CI 차단)."
        tags={["6 active plugins", "static manifest", "lvis-plugin-sdk"]}
      />

      <Callout tone="info" title="플러그인 등록 모델 — 정적 manifest">
        도구·Skill·이벤트·UI 슬롯은 모두 <code>plugin.json</code> manifest 에 정적 선언합니다.
        런타임 <code>registerTool</code>/<code>registerSkill</code>/<code>registerCommand</code> 같은 API는 SDK 에 존재하지 않습니다.
        유일한 runtime register API는 <code>hostApi.registerKeywords</code> — Skill 트리거 키워드 추가용.
      </Callout>

      <div className="my-8 grid gap-3 sm:grid-cols-2">
        {plugins.map((p) => (
          <Link
            key={p.slug}
            href={`/docs/plugins/${p.slug}`}
            className="group relative overflow-hidden rounded-2xl border border-border bg-white p-5 transition hover:-translate-y-0.5 hover:border-ink/15 hover:shadow-md"
          >
            <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${p.color}`} />
            <div className="relative">
              <div className="mb-1.5 flex items-center justify-between">
                <Badge variant="muted">{p.scope}</Badge>
                <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-ink" />
              </div>
              <p className="text-[16px] font-semibold text-ink">{p.title}</p>
              <p className="mt-0.5 text-[11.5px] font-mono text-muted-foreground">id: {p.id} · v{p.ver}</p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">{p.desc}</p>
            </div>
          </Link>
        ))}
      </div>

      <h2 id="install">설치 흐름</h2>
      <ol>
        <li>Marketplace 카탈로그에서 플러그인 선택 → “설치”.</li>
        <li>웹 페이지가 <code>lvis://install/&lt;slug&gt;</code> deeplink 발사.</li>
        <li>호스트 (<code>src/main/lvis-protocol.ts</code>) 가 URL을 파싱해 manifest 검증 + Ed25519 서명 확인.</li>
        <li>플러그인 권한 다이얼로그 → 사용자 확인 → 자기 namespace <code>{"~/.lvis/plugins/<pluginId>/"}</code> 생성.</li>
        <li>플러그인 <code>start()</code> 호출, <code>hostApi.registerKeywords</code> 가 있다면 등록.</li>
      </ol>

      <Callout tone="info" title="과거 → 현재 통합 이력">
        <ul className="my-1 list-disc pl-5">
          <li><strong>lvis-plugin-email</strong> + <strong>lvis-plugin-calendar</strong> → <strong>ms-graph</strong> 로 통합 (2026-04-28/04-30 archive).</li>
          <li><strong>work-assistant</strong> 가 proactive 업무 제안 기능을 담당합니다.</li>
        </ul>
      </Callout>

      <PageNav />
    </article>
  );
}
