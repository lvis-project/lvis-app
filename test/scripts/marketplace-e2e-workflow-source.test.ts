import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/marketplace-e2e.yml"),
  "utf8",
).replaceAll("\r\n", "\n");
const hostDockerfile = readFileSync(
  resolve(process.cwd(), ".github/marketplace-e2e/host.Dockerfile"),
  "utf8",
);
const epDockerfile = readFileSync(
  resolve(process.cwd(), ".github/marketplace-e2e/ep.Dockerfile"),
  "utf8",
);
const lifecycleSpec = readFileSync(
  resolve(process.cwd(), "test/e2e/ui/marketplace-live-lifecycle.spec.ts"),
  "utf8",
);
const epAttendanceSpec = readFileSync(
  resolve(process.cwd(), "test/e2e/ui/ep-attendance-live.spec.ts"),
  "utf8",
);

function job(name: string, next?: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = next
    ? workflow.indexOf(`\n  ${next}:\n`, start + 1)
    : workflow.length;
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe("Marketplace E2E hostile-candidate containment", () => {
  it("limits repository secrets to exact, non-recursive input acquisition", () => {
    const staging = job("stage-inputs", "build-marketplace");
    expect(staging).toContain("M4_MARKETPLACE_CHECKOUT_TOKEN");
    expect(staging).toContain("ref: ${{ env.MARKETPLACE_SHA }}");
    expect(staging).toContain("ref: ${{ env.EP_API_SHA }}");
    expect(staging).toContain("submodules: false");
    expect(staging).not.toMatch(
      /bun (install|run)|uv (sync|run)|docker (build|run)/u,
    );
    expect(staging).not.toContain("submodules: recursive");

    const afterStaging = workflow.slice(
      workflow.indexOf("\n  build-marketplace:\n"),
    );
    expect(afterStaging).not.toContain("${{ secrets.");
  });

  it("never transfers EP source to the final runner", () => {
    const finalJob = job("marketplace-e2e");
    expect(finalJob).toContain("name: m4-ep-bundle");
    expect(finalJob).not.toContain("name: m4-ep-source");
    expect(finalJob).not.toContain("ep-source.tar");
    expect(finalJob).toContain("verify-output");
    expect(finalJob).toContain("kind ep-bundle");
  });

  it("runs Marketplace and Host candidates without host mounts or egress", () => {
    const finalJob = job("marketplace-e2e");
    expect(finalJob).toContain("docker network create --internal");
    expect(finalJob).toContain('--network "$NETWORK_NAME"');
    expect(finalJob).toContain('--network "container:$MARKETPLACE_CONTAINER"');
    expect(finalJob).toContain("--user 10001:10001");
    expect(finalJob).toContain("--cap-drop ALL");
    expect(finalJob).toContain("--security-opt no-new-privileges");
    expect(finalJob).toContain("--read-only");
    expect(finalJob).toContain("--tmpfs /tmp:rw,nosuid,nodev,noexec,size=256m");
    expect(finalJob).toContain(
      '--env "LVIS_MARKETPLACE_STORAGE_DIR=/tmp/m4-marketplace-storage"',
    );
    expect(finalJob).not.toMatch(
      /docker (create|run)[\s\S]*?(?:-v |--volume |--mount )/u,
    );
    expect(finalJob).toContain("docker cp");
  });

  it("starts the Marketplace with its image-provided virtualenv PATH", () => {
    const finalJob = job("marketplace-e2e");
    expect(finalJob).toContain(`--entrypoint /bin/sh \\
            "m4-marketplace:$NONCE" \\
            -c '`);
    expect(finalJob).not.toContain(`--entrypoint /bin/sh \\
            "m4-marketplace:$NONCE" \\
            -lc '`);
  });

  it("stamps the transient E2E schema after seeding its API keys", () => {
    const finalJob = job("marketplace-e2e");
    const seed = finalJob.indexOf("python /app/e2e/scripts/seed_e2e_keys.py");
    const stamp = finalJob.indexOf("alembic stamp head");
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(stamp).toBeGreaterThan(seed);
    expect(finalJob).not.toContain("alembic upgrade head");
  });

  it("uses a separate admin reviewer to approve managed plugins", () => {
    const finalJob = job("marketplace-e2e");
    expect(workflow).toContain(
      "REVIEWER_KEY: lvismkt_e2erev_${{ github.run_id }}_${{ github.run_attempt }}",
    );
    expect(finalJob).toContain(
      '--env "REVIEWER_KEY=$REVIEWER_KEY"',
    );
    expect(finalJob).toContain(
      '--env "MARKETPLACE_REVIEWER_KEY=$REVIEWER_KEY"',
    );
    const publisherSeed = finalJob.indexOf('--admin-key "$ADMIN_KEY"');
    const reviewerSeed = finalJob.indexOf('--admin-key "$REVIEWER_KEY"');
    expect(publisherSeed).toBeGreaterThanOrEqual(0);
    expect(reviewerSeed).toBeGreaterThan(publisherSeed);

    for (const spec of [lifecycleSpec, epAttendanceSpec]) {
      expect(spec).toContain(
        'const REVIEWER_KEY = process.env.MARKETPLACE_REVIEWER_KEY ?? "";',
      );
      expect(spec).toMatch(
        /publishPlugin\(BASE_URL,\s*ADMIN_KEY,/u,
      );
      expect(spec).toMatch(
        /approvePendingPlugin\(\s*BASE_URL,\s*REVIEWER_KEY,/u,
      );
    }
  });

  it("installs the EP attendance bundle through the consented Marketplace UI", () => {
    const action = epAttendanceSpec.indexOf(
      'marketplace.getByTestId(`marketplace:action:${EP_PLUGIN_ID}`)',
    );
    const actionClick = epAttendanceSpec.indexOf("await installAction.click()", action);
    const consent = epAttendanceSpec.indexOf(
      'dialog.getByTestId("plugin-install-consent")',
      actionClick,
    );
    const networkDisclosure = epAttendanceSpec.indexOf(
      'dialog.getByTestId("plugin-install-network-access")',
      consent,
    );
    const consentControl = epAttendanceSpec.indexOf(
      'name: "I understand this grants administrator privileges."',
      networkDisclosure,
    );
    const confirmButton = epAttendanceSpec.indexOf(
      'name: "Install with admin access"',
      consentControl,
    );
    const acknowledge = epAttendanceSpec.indexOf("await consent.check()", confirmButton);
    const confirm = epAttendanceSpec.indexOf(
      "await installWithAdminAccess.click()",
      acknowledge,
    );
    const runtimeLoaded = epAttendanceSpec.indexOf("runtimeLoaded: true", confirm);
    const closeSettings = epAttendanceSpec.indexOf(
      "closeSettingsWindow(ctx.app, marketplace)",
      runtimeLoaded,
    );
    const activateWebview = epAttendanceSpec.indexOf("activateEpWebview(ctx)", closeSettings);

    for (const step of [
      action,
      actionClick,
      consent,
      networkDisclosure,
      consentControl,
      confirmButton,
      acknowledge,
      confirm,
      runtimeLoaded,
      closeSettings,
      activateWebview,
    ]) {
      expect(step).toBeGreaterThanOrEqual(0);
    }
    expect(actionClick).toBeGreaterThan(action);
    expect(consent).toBeGreaterThan(actionClick);
    expect(networkDisclosure).toBeGreaterThan(consent);
    expect(consentControl).toBeGreaterThan(networkDisclosure);
    expect(confirmButton).toBeGreaterThan(consentControl);
    expect(acknowledge).toBeGreaterThan(confirmButton);
    expect(confirm).toBeGreaterThan(acknowledge);
    expect(runtimeLoaded).toBeGreaterThan(confirm);
    expect(closeSettings).toBeGreaterThan(runtimeLoaded);
    expect(activateWebview).toBeGreaterThan(closeSettings);
    expect(epAttendanceSpec).toContain('installMode: "user-consented-marketplace-install"');
    expect(epAttendanceSpec).not.toContain("host-managed-bootstrap");
  });

  it("keeps trusted control code at workflow_sha and validates after candidate exit", () => {
    for (const name of [
      "stage-inputs",
      "build-marketplace",
      "build-ep",
      "marketplace-e2e",
    ]) {
      const block =
        name === "stage-inputs"
          ? job(name, "build-marketplace")
          : name === "build-marketplace"
            ? job(name, "build-ep")
            : name === "build-ep"
              ? job(name, "marketplace-e2e")
              : job(name);
      expect(block).toContain("ref: ${{ github.workflow_sha }}");
      expect(block).toContain("persist-credentials: false");
    }
    const finalJob = job("marketplace-e2e");
    expect(finalJob.indexOf("docker start --attach")).toBeLessThan(
      finalJob.indexOf("finalize-evidence"),
    );
    expect(finalJob).toContain("candidate-evidence-root");
  });

  it("preserves Host Playwright diagnostics when the candidate fails", () => {
    const finalJob = job("marketplace-e2e");
    const capture = finalJob.indexOf(
      "name: Capture Host candidate diagnostics (failure)",
    );
    const upload = finalJob.indexOf(
      "name: Upload Host candidate diagnostics (failure)",
      capture,
    );
    const uploadEnd = finalJob.indexOf("\n      - name:", upload + 1);
    expect(capture).toBeGreaterThan(finalJob.indexOf("docker start --attach"));
    expect(upload).toBeGreaterThan(capture);
    const captureBlock = finalJob.slice(capture, upload);
    expect(captureBlock).toContain("if: failure()");
    expect(captureBlock).toContain(
      'docker cp "$HOST_CONTAINER:/workspace/lvis-app/test-results" candidate-diagnostics-raw',
    );
    expect(captureBlock).toContain(
      "node control/scripts/sanitize-candidate-diagnostics.mjs",
    );
    expect(captureBlock).toContain('"diagnostics_safe=true" >> "$GITHUB_OUTPUT"');
    expect(captureBlock).not.toContain("candidate-evidence");
    expect(uploadEnd).toBeGreaterThan(upload);
    const uploadBlock = finalJob.slice(upload, uploadEnd);
    expect(uploadBlock).toContain(
      "steps.capture-host-candidate-diagnostics.outputs.diagnostics_safe == 'true'",
    );
    expect(uploadBlock).toContain("actions/upload-artifact@");
    expect(uploadBlock).toContain("path: candidate-diagnostics-safe/");
    expect(uploadBlock).not.toContain("candidate-diagnostics-raw");
  });

  it("executes Host and EP package scripts only after dropping root in build images", () => {
    for (const dockerfile of [hostDockerfile, epDockerfile]) {
      const nonRoot = dockerfile.indexOf("USER 10001:10001");
      expect(nonRoot).toBeGreaterThanOrEqual(0);
      expect(
        dockerfile.indexOf("bun install --frozen-lockfile"),
      ).toBeGreaterThan(nonRoot);
      expect(dockerfile).not.toMatch(
        /(?:SECRET|TOKEN|GITHUB_ENV|GITHUB_OUTPUT)/u,
      );
      expect(dockerfile).not.toMatch(/(?:--mount=|VOLUME\s)/u);
    }
    expect(hostDockerfile).toContain("COPY --chown=10001:10001 lvis-app/");
    expect(epDockerfile).toContain(
      "COPY --chown=10001:10001 lvis-plugin-ep-api/",
    );
  });

  it("installs the Host Electron runtime while the image build has network access", () => {
    const nonRoot = hostDockerfile.indexOf("USER 10001:10001");
    const install = hostDockerfile.indexOf(
      "electron_config_cache=/tmp/electron-cache /usr/local/bin/node node_modules/electron/install.js",
    );
    const cacheCleanup = hostDockerfile.indexOf("rm -rf /tmp/electron-cache");
    const verify = hostDockerfile.indexOf("Electron binary missing");
    expect(install).toBeGreaterThan(nonRoot);
    expect(install).toBeGreaterThan(hostDockerfile.indexOf("bun install --frozen-lockfile"));
    expect(cacheCleanup).toBeGreaterThan(install);
    expect(verify).toBeGreaterThan(cacheCleanup);
  });

  it("installs xauth alongside Xvfb for the Host UI lifecycle", () => {
    expect(hostDockerfile).toMatch(
      /^\s*xauth \\\r?\n\s*xvfb \\/mu,
    );
  });

  it("pins every third-party action to a full commit SHA", () => {
    for (const match of workflow.matchAll(
      /^\s*uses:\s*([^@\s]+)@([^\s#]+)/gmu,
    )) {
      expect(match[2], `${match[1]} is mutable`).toMatch(/^[0-9a-f]{40}$/u);
    }
  });
});
