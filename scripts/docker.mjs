import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";

const applicationDocker = "/Applications/Docker.app/Contents/Resources/bin/docker";
const candidates = [process.env.DOCKER_BIN, "docker", applicationDocker].filter(Boolean);

let selected;
for (const candidate of candidates) {
  if (candidate === "docker") {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) {
      selected = candidate;
      break;
    }
    continue;
  }

  try {
    accessSync(candidate, constants.X_OK);
    selected = candidate;
    break;
  } catch {
    // Try the next supported installation location.
  }
}

if (!selected) {
  console.error(
    "Docker CLI not found. Install Docker Desktop or set DOCKER_BIN to the Docker executable."
  );
  process.exit(127);
}

const result = spawnSync(selected, process.argv.slice(2), {
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
