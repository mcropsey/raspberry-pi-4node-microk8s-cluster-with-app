Here's the complete updated INSTALL.md:

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

Set up passwordless SSH from rk1 to all nodes before running any multi-node loop.

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
| **A — MicroK8s built-in registry** | Cleanest local lab approach — one build, all nodes pull from it |
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

> The MicroK8s registry runs plain HTTP. Your build machine's Docker needs to allow pushing to it. This is a one-time change on the build machine only.

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

**Step 4 — Configure containerd on all nodes to allow plain HTTP pulls:**

> Even though MicroK8s pre-configures containerd to trust `localhost:32000`, each node needs an explicit hosts.toml to pull from the registry IP over HTTP. Without this, pods will fail with `ImagePullBackOff`.

```bash
for node in rk1 rk2 rk3 rk4; do
  ssh -t mcropsey@${node} "
    sudo mkdir -p /var/snap/microk8s/current/args/certs.d/192.168.1.75:32000 &&
    sudo tee /var/snap/microk8s/current/args/certs.d/192.168.1.75:32000/hosts.toml >/dev/null <<'EOF'
server = \"http://192.168.1.75:32000\"
[host.\"http://192.168.1.75:32000\"]
  capabilities = [\"pull\", \"resolve\"]
EOF
  "
done
```

**Step 5 — Restart containerd on all nodes to pick up the config:**
```bash
for node in rk1 rk2 rk3 rk4; do
  ssh -t mcropsey@${node} "sudo snap restart microk8s"
done

# Wait for MicroK8s to come back up on all nodes
for node in rk1 rk2 rk3 rk4; do
  ssh mcropsey@${node} "sudo microk8s status --wait-ready"
  echo "${node} ready"
done
```

**Step 6 — Update the DaemonSet image reference:**
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

> ⚠️ buildah's `docker-archive` format produces a **plain tar** — not gzip compressed. Use `.tar` not `.tar.gz`. Also remove any previous archive before pushing — buildah cannot overwrite an existing file.

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

> `ssh -t` is required so that `sudo` has a terminal. Use `cat` not `gunzip -c` — the file is plain tar.

```bash
for node in rk1 rk2 rk3 rk4; do
  scp /tmp/nodedash.tar mcropsey@${node}:~/
  ssh -t mcropsey@${node} "cat ~/nodedash.tar | sudo microk8s ctr images import -"
done
```

**Step 4 — Verify the image is present on all nodes:**
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

**Step 3 — Configure containerd on all nodes (same as Option A Step 4–5):**
```bash
for node in rk1 rk2 rk3 rk4; do
  ssh -t mcropsey@${node} "
    sudo mkdir -p /var/snap/microk8s/current/args/certs.d/192.168.1.75:32000 &&
    sudo tee /var/snap/microk8s/current/args/certs.d/192.168.1.75:32000/hosts.toml >/dev/null <<'EOF'
server = \"http://192.168.1.75:32000\"
[host.\"http://192.168.1.75:32000\"]
  capabilities = [\"pull\", \"resolve\"]
EOF
  "
done

for node in rk1 rk2 rk3 rk4; do
  ssh -t mcropsey@${node} "sudo snap restart microk8s"
done

for node in rk1 rk2 rk3 rk4; do
  ssh mcropsey@${node} "sudo microk8s status --wait-ready"
  echo "${node} ready"
done
```

**Step 4 — Update the DaemonSet image reference:**
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

Find the IP MetalLB assigned to your Ingress:
```bash
sudo microk8s kubectl get ingress -n nodedash
```

Use the value in the `ADDRESS` column. If it shows `<none>`, MetalLB is not configured — see Troubleshooting below.

**macOS / Linux** — `/etc/hosts`:
```
<INGRESS_ADDRESS>  k8s.cropseyit.com
```

**Windows** — `C:\Windows\System32\drivers\etc\hosts`:
```
<INGRESS_ADDRESS>  k8s.cropseyit.com
```

**DNS A record:**
```
k8s.cropseyit.com  →  <INGRESS_ADDRESS>
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
python3 ~/nodedash/traffic_gen.py --host <INGRESS_ADDRESS>
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

### `ImagePullBackOff` — containerd won't pull from insecure registry
Each node needs an explicit `hosts.toml` to allow plain HTTP pulls from the registry. Apply to all nodes and restart:
```bash
for node in rk1 rk2 rk3 rk4; do
  ssh -t mcropsey@${node} "
    sudo mkdir -p /var/snap/microk8s/current/args/certs.d/192.168.1.75:32000 &&
    sudo tee /var/snap/microk8s/current/args/certs.d/192.168.1.75:32000/hosts.toml >/dev/null <<'EOF'
server = \"http://192.168.1.75:32000\"
[host.\"http://192.168.1.75:32000\"]
  capabilities = [\"pull\", \"resolve\"]
EOF
  "
done
for node in rk1 rk2 rk3 rk4; do
  ssh -t mcropsey@${node} "sudo snap restart microk8s"
done
```

### Ingress ADDRESS shows `<none>` — MetalLB not configured
```bash
sudo microk8s enable metallb
# When prompted, enter a free IP range on your LAN, e.g.:
# 192.168.1.100-192.168.1.110
```
Then re-check:
```bash
sudo microk8s kubectl get ingress -n nodedash
```

### `gzip: not in gzip format` during import
The buildah `docker-archive` output is plain tar. Use `cat` not `gunzip -c`:
```bash
cat ~/nodedash.tar | sudo microk8s ctr images import -
```

### `sudo: a terminal is required to read the password`
Add `-t` to your ssh command:
```bash
ssh -t mcropsey@${node} "..."
```
Or configure passwordless sudo for microk8s on each node (`sudo visudo`):
```
mcropsey ALL=(ALL) NOPASSWD: /snap/bin/microk8s
```

### `docker-archive doesn't support modifying existing images`
Remove the previous archive before re-running buildah push:
```bash
rm -f /tmp/nodedash.tar
```

### `could not find pasta` / network namespace error
```bash
sudo apt install -y passt
which pasta   # should return /usr/bin/pasta
```

### `cd app: No such file or directory`
You are already inside `~/nodedash/app`. Confirm with `pwd` and proceed without the `cd`.

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

- **Option A Steps 4–5 (new)** — `hosts.toml` config loop + `snap restart microk8s` + wait-ready check on all nodes
- **Option C Step 3 (new)** — same containerd config applied for the buildah-direct path
- **`<INGRESS_ADDRESS>` placeholder** replaces the hardcoded `192.168.1.90` everywhere — makes clear it comes from `kubectl get ingress`
- **Two new Troubleshooting entries** — insecure registry `ImagePullBackOff` and MetalLB `ADDRESS <none>`

**** alais microk8s.kubectl to kubectl**



sudo snap alias microk8s.kubectl kubectl

Then refresh the shell command cache:

hash -r

Now you can run:

kubectl get nodes
kubectl get pods -A

and it will automatically run:

microk8s kubectl

Verify it worked

which kubectl

You should see something like:

/snap/bin/kubectl

List snap aliases

snap aliases microk8s

You should see:

kubectl -> microk8s.kubectl

Remove it later (if needed)

sudo snap unalias kubectl


⸻

This method is better than a bash alias because:
	•	✔ works in scripts
	•	✔ works in cron
	•	✔ works for all users
	•	✔ survives shell changes

That’s why your Noname install script needed this — shell aliases don’t apply to scripts.
