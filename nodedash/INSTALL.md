Here's the corrected INSTALL.md with all three fixes applied:I don't have a file creation tool available, but I'll render the full corrected INSTALL.md here — you can copy it directly:

---

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
│   ├── server.js
│   ├── package.json
│   ├── Dockerfile
│   └── public/
│       └── index.html
├── k8s/
│   ├── 00-namespace.yaml
│   ├── 01-daemonset.yaml
│   ├── 02-service.yaml
│   └── 03-ingress.yaml
└── traffic_gen.py
```

> ⚠️ **Working directory:** All build commands assume you are inside `~/nodedash/app`. Navigate there once before starting:
> ```bash
> cd ~/nodedash/app
> ```

---

## Prerequisites — SSH Keys

Before running any multi-node loop, set up passwordless SSH from rk1 to all nodes. This is required for the `scp`/`ssh` loops to work non-interactively.

```bash
# Generate a key if you don't have one
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519

# Distribute to all nodes (enter password once per node)
for node in rk1 rk2 rk3 rk4; do
  ssh-copy-id mcropsey@${node}
done

# Verify — none of these should prompt for a password
for node in rk1 rk2 rk3 rk4; do
  ssh mcropsey@${node} "echo OK: ${node}"
done
```

---

## Part 1 — Build and Push the Container Image

> ⚠️ **MicroK8s uses `containerd` directly — not Docker.** Docker is not installed on the Pi nodes and is not required.

| Option | Best for |
|--------|----------|
| **A — MicroK8s built-in registry** | Cleanest local lab approach |
| **B — containerd import on each node** | No registry needed |
| **C — buildah on rk1 directly** | No Docker at all |

---

### Option A — MicroK8s Built-in Registry (Recommended)

**Step 1 — Enable the registry on rk1:**
```bash
sudo microk8s enable registry
sudo microk8s kubectl get pods -n container-registry
```

**Step 2 — Configure insecure registry on your BUILD MACHINE only:**
```bash
sudo nano /etc/docker/daemon.json
```
```json
{
  "insecure-registries": ["192.168.1.75:32000"]
}
```
```bash
sudo systemctl restart docker
```

**Step 3 — Build and push (from `~/nodedash/app`):**
```bash
docker build -t 192.168.1.75:32000/nodedash:latest .
docker push 192.168.1.75:32000/nodedash:latest
```

**Step 4 — Update the DaemonSet image reference:**
```yaml
image: 192.168.1.75:32000/nodedash:latest
imagePullPolicy: Always
```

---

### Option B — containerd import (No Registry Required)

**Step 1 — (buildah only) Install `passt` for rootless networking:**
> Skip if using Docker.
```bash
sudo apt update && sudo apt install -y passt
which pasta   # should return /usr/bin/pasta
```

**Step 2 — Build and export as a plain tar (from `~/nodedash/app`):**

> ⚠️ **Do not use `.tar.gz` / gzip with buildah.** The `docker-archive` format buildah writes is a plain tar — gzip compression is not applied despite the extension. Use `.tar` to avoid confusion. Also remove any previous archive before pushing — buildah cannot overwrite an existing file.

```bash
# Using Docker:
docker build -t nodedash:latest .
docker save nodedash:latest > /tmp/nodedash.tar

# Using buildah (no Docker):
rm -f /tmp/nodedash.tar
buildah bud -t nodedash:latest .
buildah push nodedash:latest docker-archive:/tmp/nodedash.tar
```

**Step 3 — Copy and import into each node's containerd:**

> ⚠️ The `ssh -t` flag is required so that `sudo` has a terminal to read its password. If you completed the SSH key setup in Prerequisites, sudo passwordless config below removes this requirement entirely.

```bash
for node in rk1 rk2 rk3 rk4; do
  scp /tmp/nodedash.tar mcropsey@${node}:~/
  ssh -t mcropsey@${node} "cat ~/nodedash.tar | sudo microk8s ctr images import -"
done
```

> **Tip:** To avoid the sudo password prompt entirely, add the following to `/etc/sudoers` on each node (via `sudo visudo`):
> ```
> mcropsey ALL=(ALL) NOPASSWD: /snap/bin/microk8s
> ```

**Step 4 — Verify on each node:**
```bash
for node in rk1 rk2 rk3 rk4; do
  echo "=== ${node} ==="
  ssh mcropsey@${node} "sudo microk8s ctr images ls | grep nodedash"
done
```

**Step 5 — Update the DaemonSet image reference:**
```yaml
image: docker.io/library/nodedash:latest
imagePullPolicy: Never
```

---

### Option C — Build directly on rk1 with buildah (No Docker at all)

**Step 1 — Install buildah and passt:**
```bash
sudo apt install -y buildah passt
which pasta
```

**Step 2 — Build and push (from `~/nodedash/app`):**
```bash
buildah build -t 192.168.1.75:32000/nodedash:latest .
buildah push --tls-verify=false 192.168.1.75:32000/nodedash:latest
```

**Step 3 — Update the DaemonSet image reference:**
```yaml
image: 192.168.1.75:32000/nodedash:latest
imagePullPolicy: Always
```

---

## Part 2 — Deploy to Kubernetes

```bash
sudo microk8s kubectl apply -f ~/nodedash/k8s/00-namespace.yaml
sudo microk8s kubectl apply -f ~/nodedash/k8s/01-daemonset.yaml
sudo microk8s kubectl apply -f ~/nodedash/k8s/02-service.yaml
sudo microk8s kubectl apply -f ~/nodedash/k8s/03-ingress.yaml
```

### Verify DaemonSet
```bash
sudo microk8s kubectl get pods -n nodedash -o wide
```
Expected — one pod per node, all `Running`:
```
NAME            READY   STATUS    NODE
nodedash-xxxxx  1/1     Running   rk1
nodedash-xxxxx  1/1     Running   rk2
nodedash-xxxxx  1/1     Running   rk3
nodedash-xxxxx  1/1     Running   rk4
```

```bash
sudo microk8s kubectl get svc -n nodedash
sudo microk8s kubectl get ingress -n nodedash
```

---

## Part 3 — Configure DNS / Hosts

Get the MetalLB IP:
```bash
sudo microk8s kubectl get ingress -n nodedash
```

**macOS / Linux** — `/etc/hosts`:
```
192.168.1.90  k8s.cropseyit.com
```

**Windows** — `C:\Windows\System32\drivers\etc\hosts`:
```
192.168.1.90  k8s.cropseyit.com
```

**DNS A record:**
```
k8s.cropseyit.com  →  192.168.1.90
```

---

## Part 4 — Verify It's Working

Open `http://k8s.cropseyit.com` and refresh several times:

- 🔴 Red = rk1 · 🔵 Blue = rk2 · 🟢 Green = rk3 · 🟠 Orange = rk4

```bash
curl http://k8s.cropseyit.com/api/health
curl http://k8s.cropseyit.com/api/node
curl http://k8s.cropseyit.com/api/stats | python3 -m json.tool
curl -H "X-Api-Key: mk1-6d696b65314d79" http://k8s.cropseyit.com/api/users
curl -X POST \
  -H "X-Api-Key: mk2-6d696b65324d79" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello from rk cluster!"}' \
  http://k8s.cropseyit.com/api/messages
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

- `admin` — full access including DELETE
- `operator` — read/write, no delete
- `viewer` — read-only (GET endpoints)

---

## Part 6 — Traffic Generator

```bash
python3 ~/nodedash/traffic_gen.py
python3 ~/nodedash/traffic_gen.py --host 192.168.1.90
python3 ~/nodedash/traffic_gen.py --rps 5
python3 ~/nodedash/traffic_gen.py --duration 300
python3 ~/nodedash/traffic_gen.py --burst --rps 2
python3 ~/nodedash/traffic_gen.py --quiet --duration 60
python3 ~/nodedash/traffic_gen.py --host k8s.cropseyit.com --rps 3 --burst --duration 600
```

---

## Part 7 — Useful Management Commands

```bash
sudo microk8s kubectl get pods -n nodedash -w
sudo microk8s kubectl logs -n nodedash <pod-name> -f
sudo microk8s kubectl logs -n nodedash -l app=nodedash --prefix=true
sudo microk8s kubectl rollout restart daemonset/nodedash -n nodedash
sudo microk8s kubectl rollout status daemonset/nodedash -n nodedash
sudo microk8s kubectl delete namespace nodedash
sudo microk8s kubectl apply -f ~/nodedash/k8s/
```

---

## Troubleshooting

### `gzip: not in gzip format` during import
The `docker-archive` format buildah produces is a **plain tar**, not gzip-compressed. Use `cat` instead of `gunzip -c` when importing:
```bash
cat ~/nodedash.tar | sudo microk8s ctr images import -
```
Also rename your export file to `.tar` (not `.tar.gz`) to avoid future confusion.

### `sudo: a terminal is required to read the password`
The `ssh` command runs non-interactively so sudo can't prompt. Fix with `-t`:
```bash
ssh -t mcropsey@${node} "cat ~/nodedash.tar | sudo microk8s ctr images import -"
```
Or configure passwordless sudo for microk8s on each node (`sudo visudo`):
```
mcropsey ALL=(ALL) NOPASSWD: /snap/bin/microk8s
```

### `cd app: No such file or directory`
You are already inside `~/nodedash/app`. Confirm with `pwd`, then proceed without the `cd`.

### `docker-archive doesn't support modifying existing images`
A previous archive is blocking buildah. Remove it first:
```bash
rm -f /tmp/nodedash.tar
```

### `could not find pasta` / network namespace error
```bash
sudo apt install -y passt
which pasta   # should return /usr/bin/pasta
```

### Pods stuck in `ImagePullBackOff`
```bash
sudo microk8s kubectl describe pod <pod-name> -n nodedash
```
Check image name and registry address in `01-daemonset.yaml`.

### Ingress not routing — address shows `<none>`
```bash
sudo microk8s status | grep ingress
sudo microk8s enable ingress
```

### Pods only running on some nodes
```bash
sudo microk8s kubectl describe nodes | grep -A5 Taints
```

### App shows wrong node color / "unknown" theme
```bash
sudo microk8s kubectl exec -n nodedash <pod-name> -- printenv HOSTNAME
```
Should return `rk1`, `rk2`, `rk3`, or `rk4`.

### Dashboard shows 0% CPU / no processes
Normal in containers — CPU is based on load average relative to core count and will be accurate.

---

*cropseyit.com lab — MicroK8s 1.29/stable — NodeDash v1.0 — March 2026*

---

**Changes from previous version:**

- **Prerequisites section added** — SSH key setup moved to the top, before any multi-node work, with a verification loop
- **`.tar.gz` → `.tar`** throughout Option B — buildah's `docker-archive` output is plain tar; the `.gz` extension was misleading and caused the `gzip: not in gzip format` failure
- **`gunzip -c` → `cat`** in the import loop — since the file is plain tar
- **`ssh -t`** added to the import loop — gives sudo the terminal it needs
- **`rm -f /tmp/nodedash.tar`** before buildah push — prevents the "can't modify existing archive" error
- **Verification loop** added after import (Step 4) to confirm the image landed on every node
- **Four new Troubleshooting entries** covering every error hit so far