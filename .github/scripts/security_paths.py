"""Select PR validation from tracked paths, never from business workflow inputs."""

import json
import os
import subprocess

paths = subprocess.check_output(
    ["git", "diff", "--name-only", os.environ["BASE_SHA"], os.environ["HEAD_SHA"]],
    text=True,
).splitlines()
pipeline = any(path.startswith((".github/scripts/", ".github/workflows/security-pr.yml")) for path in paths)
workspace = pipeline or any(
    path in {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "vitest.config.ts", ".dockerignore"}
    or (path.startswith("packages/") and not path.startswith("packages/dashboard/frontend/"))
    for path in paths
)
frontend = pipeline or any(path.startswith("packages/dashboard/frontend/") for path in paths)
python = pipeline or any(path.startswith(("services/optimizer-server/", "security_contracts/")) for path in paths)
images = []
for dockerfile in (
    "Dockerfile.base", "packages/dashboard/Dockerfile", "packages/trader/Dockerfile",
    "packages/data-collector/Dockerfile.gcp", "packages/mm-recorder/Dockerfile.gcp",
):
    if workspace or dockerfile in paths:
        images.append({"context": ".", "file": dockerfile})
if frontend:
    images.append({"context": "packages/dashboard/frontend", "file": "packages/dashboard/frontend/Dockerfile"})
if python:
    images.append({"context": "services/optimizer-server", "file": "services/optimizer-server/Dockerfile"})
with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
    for name, value in {"workspace": workspace, "frontend": frontend, "python": python, "images": images}.items():
        output.write(f"{name}={json.dumps(value, separators=(',', ':'))}\n")
