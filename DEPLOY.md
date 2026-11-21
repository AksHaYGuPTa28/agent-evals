# Deploying the demo

**Status, stated honestly:** the server logic is tested (12 automated tests, run in CI). The container image and the AWS steps below are **not tested yet**. Docker was not running when this was written, and no AWS account was used. Treat this as a checked plan, not a verified recipe.

## What is deployed

One container running `server.mjs` (Node 22, no dependencies). It serves the page and the API. The model API key stays on the server.

## Constraints that shape the deployment

- **One instance only.** Runs waiting for approval are held in memory. With two instances, "Approve" could land on an instance that has never heard of the run. Set the maximum number of instances to 1. (Making it stateless would need a shared store such as DynamoDB. That is a possible next step, not built.)
- **It spends your money.** Every visitor run calls a paid model API. The server has a per-visitor hourly limit (`DEMO_RUNS_PER_HOUR`, default 12), a 500-row cap and a 12-step cap, but there is no login. Before making it public: set a spending cap or quota on the model provider's side, and an AWS Budget alarm.
- **Keys are runtime secrets, never in the image.** `.dockerignore` excludes `.env`. Pass `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` from a secret store.
- **Audit log:** one JSON line per decision, with hashes and counts only (never the data or the task text). In the container it goes to stdout, so the platform's log collection keeps it.

## Build and run locally (needs Docker Desktop running)

```powershell
docker build -t agent-evals-demo .
docker run --rm -p 3000:3000 -e DEMO_SCRIPTED=1 agent-evals-demo
```

Open http://localhost:3000. `DEMO_SCRIPTED=1` adds a rule-based "scripted (no AI)" option, so you can try the page with no key. For a real model add `-e GEMINI_API_KEY=...`.

## AWS App Runner (outline)

1. Create an ECR repository and push the image (`docker tag`, `aws ecr get-login-password | docker login ...`, `docker push`).
2. Store the model key in AWS Secrets Manager.
3. Create an App Runner service from the ECR image: port 3000, health check path `/healthz`, runtime secret mapped to `GEMINI_API_KEY`, environment `DEMO_RUNS_PER_HOUR=8`.
4. Set **maximum instances = 1**.
5. Create an AWS Budget with an alert at a low monthly amount, and set a quota or budget on the model provider.
6. Open the service URL, run the "scripted" or a real sample, and check CloudWatch for the audit lines.

Other hosts (Fly.io, Render, a small VM) work the same way: run the image, keep one instance, inject the key as a secret.

## What I would not do

- Put the demo on the public internet without a spending cap.
- Raise the instance count without moving the pending-approval state out of memory.
- Call this "production". It is a deployable demo with real safeguards, not a service with users, monitoring and on-call.
