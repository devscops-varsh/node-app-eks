# DevOps Infrastructure Challenge — Runbook & Video Script

Stack: Node.js/Express backend + Redis, deployed to a local **kind** cluster,
built/deployed by **GitHub Actions**, reliability feature = **readiness/liveness
probes**
 0. Prerequisites (5 min)

```bash


---

## 1. Build & load the image locally


```bash
cd node-app
docker build -t node-app-backend:latest .
eval $(minikube docker-env) # so local docker image can used by deployment yml

```

## 2. Deploy the working stack

```bash
kubectl apply -f service-file/namespace.yaml
kubectl apply -f service-file/app-configmap.yaml
kubectl apply -f service-file/app-secret.yaml
kubectl apply -f service-file/redis-deployment.yaml
kubectl apply -f service-file/redis-service.yaml
kubectl apply -f service-file/app-deployment.yaml
kubectl apply -f service-file/app-service.yaml

kubectl get pods -n node-app -w
```

Verify end-to-end:

```bash
kubectl -n node-app port-forward svc/backend 8080:80 &
curl localhost:8080/
curl localhost:8080/health
curl localhost:8080/ready
curl localhost:8080/count  
```
## 3. CI/CD pipeline

`.github/workflows/minikube.yml`:
1. Builds the Docker image on every push to `main`.
2. Pushes it to GHCR (`ghcr.io/<repo>/node-app-backend`).
3. Applies manifests and does `kubectl set image` + `kubectl rollout status`
   against a real cluster (kubeconfig supplied via the `KUBE_CONFIG_DATA`
   repo secret — base64 of your kubeconfig).
4. Rolls back automatically (`kubectl rollout undo`) if the rollout fails.

GitHub-hosted runners can't reach your local minikube API server (it's on
your machine, not the internet). The clean fix is a **self-hosted runner**
on the same machine as minikube — it already has network access to the
cluster, so no tunneling or extra infra needed. Say this out loud on
camera; it's a legitimate, common setup, not a thing to hide.

```bash
git add -A
git commit -m "deploy: backend v1"
git push origin main
```

Show the Actions tab: build step, push step, `rollout status` succeeding.

---

## 4. Reliability improvement: readiness & liveness probes

**Why this one:** with a 90-minute budget, probes give the highest
reliability-per-minute-of-setup. They directly prevent the two most common
outages — routing traffic to a pod that isn't ready, and never restarting a
pod that's wedged — without needing extra infrastructure (unlike
autoscaling, an ingress controller, or a service mesh for circuit
breaking).

**Problem it solves:**
- **Readiness** (`GET /ready`, checks Redis connectivity) keeps a pod out
  of the Service's endpoint list until it can actually serve requests — so
  a slow-starting or dependency-degraded pod never receives traffic and
  returns errors to users.
- **Liveness** (`GET /health`, process-only check) restarts a pod that's
  alive-but-stuck (event loop wedged, deadlock) even if it never crashes on
  its own.

**Tradeoff:** two extra HTTP round trips per pod per probe interval (minor
resource cost), and a wrongly-tuned liveness probe can *cause* outages by
restart-looping a pod that's just slow (e.g. under load) rather than dead —
which is exactly why liveness here checks the process only, not the DB
dependency, so a Redis blip can't cascade into a full pod restart storm.


**# 1. Symptom: what state are we in?
kubectl get pods -n node-app
#   -> STATUS: Running, but READY: 0/1, RESTARTS: 0
#      zero restarts is the key signal — this immediately rules out
#      a crashing container. Something else is keeping it out of rotation.

# 2. First hypothesis check: is this a real crash or a probe/config issue?
kubectl describe pod <pod> -n node-app
#   -> look in Events for:
#      "Readiness probe failed: HTTP probe failed with statuscode: 404"
#      a 404 (not 503) tells me the path itself doesn't exist on the
#      server — this is different from a 503, which would mean the app
#      is reachable but reporting itself unhealthy (e.g. Redis down)

# 3. Confirm the app itself is actually fine
kubectl logs <pod> -n node-app
#   -> app logs show it started normally and is listening on port 3000,
#      no errors, no crash — confirms this isn't an application bug,
#      it's specifically about how Kubernetes is checking the app

# 4. Compare the probe path in the manifest against the actual route in code
grep -A3 readinessProbe service-file/app-deployment.yaml
grep "app.get" server.js
#   -> manifest points readinessProbe at the wrong path (e.g. "/readyz"),
#      but the app only exposes "/ready" — root cause: a one-character
#      mismatch between the deployment manifest and the actual route**

# 5. Fix: correct the path and reapply
kubectl apply -f service-file/app-deployment.yaml
kubectl -n node-app rollout status deployment/backend-app
kubectl get pods -n node-app
#   -> READY: 1/1, confirms the fix worked

# 6. Verify recovery
curl <minikube-service-url>/ready
#   -> {"status":"ready"}

---

## 6. Tradeoff discussion talking points (for the video)

What was intentionally simplified:
- Redis instead of a "real" HA database — no persistence, no replication,
  single point of failure. Fine for a demo, not production.
- No Ingress/TLS — accessed via `port-forward` for simplicity. Production
  would need an ingress controller + cert-manager.
- No Horizontal Pod Autoscaler — fixed `replicas: 2`. At scale you'd add
  HPA on CPU/custom metrics.
- Secrets are demoed via a plain `Secret` manifest with `stringData`, which
  is base64-not-encryption. Production should use sealed-secrets, External
  Secrets Operator, or a cloud KMS-backed secret store.
- CI/CD deploys via `kubectl set image` directly, no GitOps
  (Argo CD/Flux) reconciliation loop, and no automated rollback based on
  metrics — only on rollout timeout.
- Single environment (no staging/prod separation, no canary).

What would break first at real scale:
- Redis as a single pod — any node failure loses the counter and drops all
  connections; no read replicas means all reads/writes bottleneck on one
  instance.
- No autoscaling means a traffic spike either OOMs pods (limits are tiny —
  128Mi) or queues up requests with no elasticity.
- `kubectl set image` from CI is push-based and imperative — configuration
  drift between what's in Git and what's actually running becomes invisible
  over time; nobody would notice a manual `kubectl edit` in prod.

What I'd improve first in real production:
- Move to GitOps (Argo CD) so cluster state is always reconciled from Git,
  not from a CI job's one-time `kubectl apply`.
- Add HPA + proper resource requests/limits based on load testing, not
  guesses.
- Managed/HA datastore (e.g. managed Postgres or Redis with replicas) with
  PersistentVolumeClaims and backup policy.
- Ingress + TLS + WAF/rate limiting at the edge.
- Centralized logging/metrics (Prometheus + Grafana, or a hosted
  equivalent) instead of `kubectl logs` as the only observability tool.

Challenge Summary:
This implementation demonstrates:

Docker image creation
Kubernetes application deployment
Redis integration
Kubernetes Services
ConfigMaps
Readiness probes
Liveness probes
Kubernetes troubleshooting
GitHub Actions CI/CD
GHCR image publishing
Self-hosted GitHub Actions runner
Kubernetes rolling deployments
Reliability tradeoff analysis
Production architecture considerations
