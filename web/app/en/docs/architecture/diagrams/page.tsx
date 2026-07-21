import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { ZoomableFrame } from "@/components/docs/zoomable-frame";
import {
  StackDiagram,
  DataFlowDiagram,
  PermissionTree,
  LifecycleDiagram,
  CapabilityPackDiagram,
  SubAgentSequence,
  FederationSequence,
} from "@/components/docs/diagrams";

export const metadata = { title: "Architecture Diagrams" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Architecture · Diagrams"
        title="Architecture visuals"
        description="This page turns the system's big picture into pictures. Click any card to zoom in for a closer look."
        tags={["click to zoom", "stack · flow · permissions · lifecycle"]}
      />

      <Callout tone="tip" title="Zooming in">
        Clicking a diagram card zooms it into a lightbox that fills nearly the whole screen. The text scales up along with it.
      </Callout>

      <ZoomableFrame
        eyebrow="Diagram 01"
        title="The system at a glance — four layers"
        caption="App · plugins · local storage · server. Calls and storage flow from top to bottom."
      >
        <StackDiagram locale="en" />
      </ZoomableFrame>

      <ZoomableFrame
        eyebrow="Diagram 02"
        title="The flow of a single message"
        caption="Starting from user input through to the result returning to chat. Risky tools go through user confirmation along the way."
      >
        <DataFlowDiagram locale="en" />
      </ZoomableFrame>

      <ZoomableFrame
        eyebrow="Diagram 03"
        title="Permission branching — risk level × tool type"
        caption="Branches into auto-run, a confirmation card, or a dialog depending on the tool's risk level (low/medium/high) and type (read/write/execute/network)."
      >
        <PermissionTree locale="en" />
      </ZoomableFrame>

      <ZoomableFrame
        eyebrow="Diagram 04"
        title="Plugin lifecycle — now and next"
        caption="The top row is the current state, the bottom row is stages to be added later. The dotted line shows where they hook in."
      >
        <LifecycleDiagram locale="en" />
      </ZoomableFrame>

      <h2 id="future">Future vision diagrams</h2>
      <p>
        The three diagrams below translate items from the <a href="/en/docs/roadmap">roadmap</a> into pictures.
        They show <strong>designs yet to be added</strong>, not current behavior.
      </p>

      <ZoomableFrame
        eyebrow="Diagram 05 · vision"
        title="Capability Pack — publish once, install once"
        caption="Bundles plugins · agents · MCP · Skills into a single package for publishing, so users can install everything in one step."
      >
        <CapabilityPackDiagram locale="en" />
      </ZoomableFrame>

      <ZoomableFrame
        eyebrow="Diagram 06 · vision"
        title="Sub-agent delegation — autonomous execution after consent"
        caption="For complex requests, once the user allows delegation, a sub-agent autonomously calls tools. All results are collected back into chat."
      >
        <SubAgentSequence locale="en" />
      </ZoomableFrame>

      <ZoomableFrame
        eyebrow="Diagram 07 · vision"
        title="Federation — delegating work to another user"
        caption="Hands off work to a person on another host and receives the response. Trust is expressed through key exchange."
      >
        <FederationSequence locale="en" />
      </ZoomableFrame>

      <Callout tone="warn" title="Current vs. future distinction">
        Diagrams 01-04 show the current state; Diagrams 05-07 show designs yet to be added.
        Parts yet to be added may include names that don't yet exist in the code, so please don't cite them as fact.
      </Callout>

      <PageNav />
    </article>
  );
}
