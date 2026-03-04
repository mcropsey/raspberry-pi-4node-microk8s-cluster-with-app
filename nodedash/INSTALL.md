# NodeDash — Install Guide
## Node-Aware Dashboard for cropseyit.com MicroK8s Cluster

> Deploys a themed system dashboard + REST API to `k8s.cropseyit.com`, with one pod running on each of rk1–rk4.

---

## What Gets Deployed

| Component | Detail |
|-----------|--------|
| **DaemonSet** | One pod per node — guaranteed coverage of rk1, rk2, rk3, rk4 |
| **Service** | ClusterIP, load-balances across all 4 pods |
| **Ingress** | Routes `k8s.cropseyit.com` → Service via nginx |
| **Namespace** | `nodedash` |

**Node color theming:**

| Node | Color |
|------|-------|
| rk1  | 🔴 Red |
| rk2  | 🔵 Blue |
| rk3  | 🟢 Green |
| rk4  | 🟠 Orange |

---

## Files in This Package
```
nodedash/
├── app/
│   ├── server.js          # Express app — APIs + stat collection
│   ├── package.json
│   ├── Dockerfile
│   └── public/
│       └── index.html     # btop-style dashboard UI
├── k8s/
│   ├── 00-namespace.yaml
│   ├── 01-daemonset.yaml
│   ├── 02-service.yaml
│   └── 03-ingress.yaml
└── traffic_gen.py         # External traffic generator (Python 3, no deps)
```

> ⚠️ **After cloning or extracting the package, your working directory is `~/nodedash`.** All `cd` commands below are relative to that directory.

---

## Part 1 — Build and Push the Container Image

> ⚠️ **MicroK8s uses `containerd` directly — not Docker.** Docker is not installed on the Pi nodes and is not required. All build and push options below use tools that work with containerd.

You have three options depending on your setup:

| Option | Best for |
|--------|----------|
| **A — MicroK8s built-in registry** | Cleanest local lab approach — one build, all nodes pull from it |
| **B — containerd import on each node** | No registry needed, build once on any machine with Docker/buildah |
| **C — buildah on rk1 directly** | Build natively on the Pi without Docker at all |

---

### Option A — MicroK8s Built-in Registry (Recommended)

MicroK8s ships a container registry addon that listens on port `32000`. All cluster nodes can pull from it over the LAN automatically — no Docker daemon config needed.

**Step 1 — Enable the registry on rk1:**
```bash
sudo microk8s enable registry

# Verify it's running
sudo microk8s kubectl get pods -n container-registry
```

**Step 2 — Build and push from a machine that has Docker** (your laptop, a separate Linux box, or rk1 if you install Docker there temporarily for the build):

> The MicroK8s registry runs plain HTTP (no TLS). Docker on your **build machine** needs to be told to allow pushing to this insecure endpoint. This is a one-time config on your **build machine only** — the Pi nodes do **not** need this change because MicroK8s pre-configures containerd on every node to trust `localhost:32000` automatically.
```bash
# On your BUILD MACHINE only — NOT on rk1/rk2/rk3/rk4:
sudo nano /etc/docker/daemon.json
```

Add or merge:
```json
{
  "insecure-registries": ["192.168.1.75:32000"]
}
```
```bash
# Restart Docker on your BUILD MACHINE only:
sudo systemctl restart docker
```

**Step 3 — Navigate to the app directory and build:**
```bash
# From ~/nodedash:
cd app
docker build -t 192.168.1.75:32000/nodedash:latest .
docker push 192.168.1.75:32000/nodedash:latest
```

**Step 4 — Update the DaemonSet image reference:**
```yaml
image: 192.168.1.75:32000/nodedash:latest
imagePullPolicy: Always
```

> The Pi nodes pull directly from `192.168.1.75:32000` via containerd — no Docker config needed on the nodes. MicroK8s pre-configures containerd to trust the built-in registry automatically.

---

### Option B — containerd import (No Registry Required)

Build the image once on any machine with Docker (or `buildah` if you prefer Docker-free), export it as a tar, and import it directly into containerd on each node via `microk8s ctr`. No registry, no daemon config on the nodes.

**Step 1 — (buildah only) Install `passt` for rootless networking:**

> buildah requires the `pasta` binary (from the `passt` package) for rootless network namespaces. Skip this if you're using Docker.
```bash
sudo apt update && sudo apt install -y passt

# Verify:
which pasta
```

**Step 2 — Navigate to the app directory and build:**
```bash
# From ~/nodedash:
cd app

# If you have Docker on your build machine:
docker build -t nodedash:latest .
docker save nodedash:latest | gzip > /tmp/nodedash.tar.gz

# If you prefer buildah (no Docker required):
buildah bud -t nodedash:latest .
buildah push nodedash:latest docker-archive:/tmp/nodedash.tar.gz
```

**Step 3 — Copy and import into each node's containerd:**
```bash
for node in rk1 rk2 rk3 rk4; do
  scp /tmp/nodedash.tar.gz mcropsey@${node}:~/ 
  ssh mcropsey@${node} "gunzip -c ~/nodedash.tar.gz | sudo microk8s ctr images import -"
done
```

**Step 4 — Verify the image is present on each node:**
```bash
ssh mcropsey@rk1 "sudo microk8s ctr images ls | grep nodedash"
```

**Step 5 — Update the DaemonSet image reference:**
```yaml
image: docker.io/library/nodedash:latest
imagePullPolicy: Never
```

> `imagePullPolicy: Never` tells Kubernetes not to try pulling from a registry — it uses the locally imported image instead.

---

### Option C — Build directly on rk1 with buildah (No Docker at all)

If you'd rather not use Docker anywhere, `buildah` can build from a Dockerfile natively and push directly to the MicroK8s registry.

**Step 1 — Install buildah and passt (required for rootless networking):**
```bash
sudo apt install -y buildah passt

# Verify pasta is available:
which pasta
```

**Step 2 — Navigate to the app directory and build:**
```bash
# From ~/nodedash:
cd app
buildah build -t 192.168.1.75:32000/nodedash:latest .

# Push (HTTP registry, use --tls-verify=false)
buildah push --tls-verify=false 192.168.1.75:32000/nodedash:latest
```

Update DaemonSet:
```yaml
image: 192.168.1.75:32000/nodedash:latest
imagePullPolicy: Always
```

---

## Part 2 — Deploy to Kubernetes

Run all of these on **rk1** (or any node where you have kubectl access):
```bash
# From ~/nodedash:
sudo microk8s kubectl apply -f k8s/00-namespace.yaml
sudo microk8s kubectl apply -f k8s/01-daemonset.yaml
sudo microk8s kubectl apply -f k8s/02-service.yaml
sudo microk8s kubectl apply -f k8s/03-ingress.yaml
```

### Verify the DaemonSet is running on all 4 nodes
```bash
sudo microk8s kubectl get pods -n nodedash -o wide
```

Expected output — one pod per node, all `Running`:
```
NAME            READY   STATUS    NODE   IP
nodedash-xxxxx  1/1     Running   rk1    10.1.x.x
nodedash-xxxxx  1/1     Running   rk2    10.1.x.x
nodedash-xxxxx  1/1     Running   rk3    10.1.x.x
nodedash-xxxxx  1/1     Running   rk4    10.1.x.x
```

### Verify the Service
```bash
sudo microk8s kubectl get svc -n nodedash
```

### Verify the Ingress
```bash
sudo microk8s kubectl get ingress -n nodedash
```

---

## Part 3 — Configure DNS / Hosts

### Option A — Local hosts file (for testing)

Find the MetalLB IP assigned to the Ingress:
```bash
sudo microk8s kubectl get ingress -n nodedash
```

Note the `ADDRESS` field (e.g. `192.168.1.90`). Add to your local machine's hosts file:

**macOS / Linux:**
```bash
sudo nano /etc/hosts
```
Add:
```
192.168.1.90  k8s.cropseyit.com
```

**Windows:**
```
C:\Windows\System32\drivers\etc\hosts
```
Add:
```
192.168.1.90  k8s.cropseyit.com
```

### Option B — DNS (cropseyit.com domain)

In your DNS provider (or local Pi-hole / Unbound), add an A record:
```
k8s.cropseyit.com  →  192.168.1.90   (your MetalLB IP)
```

---

## Part 4 — Verify It's Working

Open in your browser:
```
http://k8s.cropseyit.com
```

Refresh a few times — you should see the page color change as the Ingress load-balances to different nodes:

- 🔴 Red background = rk1
- 🔵 Blue background = rk2
- 🟢 Green background = rk3
- 🟠 Orange background = rk4

### Quick API test from command line
```bash
# Health check (no auth)
curl http://k8s.cropseyit.com/api/health

# Node info
curl http://k8s.cropseyit.com/api/node

# Stats
curl http://k8s.cropseyit.com/api/stats | python3 -m json.tool

# List users (requires API key)
curl -H "X-Api-Key: mk1-6d696b65314d79" http://k8s.cropseyit.com/api/users

# Post a message
curl -X POST \
  -H "X-Api-Key: mk2-6d696b65324d79" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello from rk cluster!"}' \
  http://k8s.cropseyit.com/api/messages

# Echo (shows which node served the request)
curl -X POST \
  -H "X-Api-Key: mk3-6d696b65334d79" \
  -H "Content-Type: application/json" \
  -d '{"probe":"test","from":"curl"}' \
  http://k8s.cropseyit.com/api/echo
```

---

## Part 5 — API Keys Reference

| User | Email | Role | API Key |
|------|-------|------|---------|
| Mike One   | mike1@my.lab | admin    | `mk1-6d696b65314d79` |
| Mike Two   | mike2@my.lab | operator | `mk2-6d696b65324d79` |
| Mike Three | mike3@my.lab | operator | `mk3-6d696b65334d79` |
| Mike Four  | mike4@my.lab | viewer   | `mk4-6d696b65344d79` |
| Mike Five  | mike5@my.lab | viewer   | `mk5-6d696b65354d79` |

**Role permissions:**
- `admin` — full access including DELETE
- `operator` — read/write, no delete
- `viewer` — read-only (GET endpoints)

---

## Part 6 — Traffic Generator

The traffic generator runs from any machine with network access to `k8s.cropseyit.com`. It requires **Python 3 only** — no pip installs needed.
```bash
# Basic usage — 1 req/sec forever
python3 traffic_gen.py

# Target by IP (if DNS not set up)
python3 traffic_gen.py --host 192.168.1.90

# Higher rate
python3 traffic_gen.py --rps 5

# Run for 5 minutes then print summary
python3 traffic_gen.py --duration 300

# Burst mode — adds occasional traffic spikes
python3 traffic_gen.py --burst --rps 2

# Quiet mode (summary only, no per-request output)
python3 traffic_gen.py --quiet --duration 60

# Combine options
python3 traffic_gen.py --host k8s.cropseyit.com --rps 3 --burst --duration 600
```

The generator:
- Rotates through all 5 users (mike1–mike5)
- Exercises all API endpoints with weighted randomness
- Has admin (mike1) occasionally delete messages it posted
- Prints a summary table showing requests per user and per endpoint
- Shows which nodes served each request (useful for verifying load distribution)

---

## Part 7 — Useful Management Commands
```bash
# Watch pods in real time
sudo microk8s kubectl get pods -n nodedash -w

# View logs from a specific pod
sudo microk8s kubectl logs -n nodedash <pod-name> -f

# View logs from ALL pods at once
sudo microk8s kubectl logs -n nodedash -l app=nodedash --prefix=true

# Restart all pods (rolling)
sudo microk8s kubectl rollout restart daemonset/nodedash -n nodedash

# Check rollout status
sudo microk8s kubectl rollout status daemonset/nodedash -n nodedash

# Scale down (removes all pods)
sudo microk8s kubectl patch daemonset nodedash -n nodedash \
  -p '{"spec":{"template":{"spec":{"nodeSelector":{"non-existing":"true"}}}}}'

# Delete everything
sudo microk8s kubectl delete namespace nodedash

# Re-deploy from scratch
sudo microk8s kubectl apply -f k8s/
```

---

## Troubleshooting

### Pods stuck in `ImagePullBackOff`
```bash
sudo microk8s kubectl describe pod <pod-name> -n nodedash
```
→ Check the image name and registry address in `01-daemonset.yaml`.

### Ingress not routing — address shows `<none>`
```bash
# Verify ingress addon is enabled
sudo microk8s status | grep ingress

# Enable if missing
sudo microk8s enable ingress
```

### Pods only running on some nodes
```bash
# Check node taints — our toleration should cover control-plane nodes
sudo microk8s kubectl describe nodes | grep -A5 Taints
```

### App shows wrong node color / "unknown" theme
The app reads the `HOSTNAME` env variable which is set to `spec.nodeName` in the DaemonSet. Verify:
```bash
sudo microk8s kubectl exec -n nodedash <pod-name> -- printenv HOSTNAME
```
Should return `rk1`, `rk2`, `rk3`, or `rk4`.

### Dashboard shows 0% CPU / no processes
This is normal when running in a container — the app reads `/proc` from the container's view. CPU percentages are based on load average relative to core count and will be accurate.

### buildah fails with "could not find pasta" / network namespace error
buildah requires the `passt` package for rootless networking. Install it before building:
```bash
sudo apt install -y passt
which pasta   # should return /usr/bin/pasta
```

---

*cropseyit.com lab — MicroK8s 1.29/stable — NodeDash v1.0 — March 2026*