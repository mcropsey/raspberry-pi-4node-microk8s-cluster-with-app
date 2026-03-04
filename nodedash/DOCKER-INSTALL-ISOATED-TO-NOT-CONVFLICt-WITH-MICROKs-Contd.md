# Installing Docker on rk1 (Alongside MicroK8s)

> **Run on rk1 only.** You are installing Docker as a build tool to build
> and push container images. MicroK8s will continue to use its own
> snap-managed containerd and is not affected.

---

## ⚠️ Key Risk: containerd Conflict

Docker CE requires a package called `containerd.io`. MicroK8s manages its
**own** containerd inside the snap sandbox (`/var/snap/microk8s/`) and does
**not** use the system `containerd.io` package — so they do not share a
runtime and cannot conflict at the container level.

However, the Docker `containerd.io` deb **can conflict with any existing
system `containerd` or `runc` package** installed outside the snap. The
steps below handle this cleanly.

---

## Step 1 — Remove any conflicting packages

```bash
sudo apt remove -y docker.io docker-compose docker-compose-v2 \
  docker-doc podman-docker containerd runc 2>/dev/null || true
```

> This clears unofficial Docker packages that Ubuntu may have installed.
> MicroK8s snap packages are unaffected — they live in `/snap/` not `/usr/`.

---

## Step 2 — Install prerequisites

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release
```

---

## Step 3 — Add Docker's official GPG key

```bash
sudo install -m 0755 -d /etc/apt/keyrings

curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

sudo chmod a+r /etc/apt/keyrings/docker.gpg
```

---

## Step 4 — Add Docker's apt repository

rk1 runs **Ubuntu arm64** on the Raspberry Pi 5. This command detects the
correct architecture and Ubuntu release automatically:

```bash
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

Verify it looks correct:

```bash
cat /etc/apt/sources.list.d/docker.list
```

Expected output:
```
deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable
```

> `noble` = Ubuntu 24.04. If you're on 22.04 it will show `jammy`. Both are fine.

---

## Step 5 — Install Docker Engine

```bash
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

---

## Step 6 — Verify Docker is running

```bash
sudo docker run --rm hello-world
```

Expected output includes:
```
Hello from Docker!
This message shows that your installation appears to be working correctly.
```

The image will show `(arm64v8)` confirming it pulled the correct architecture.

---

## Step 7 — Add your user to the docker group

This lets you run `docker` without `sudo`:

```bash
sudo usermod -aG docker mcropsey
```

Apply the group change without logging out:

```bash
newgrp docker
```

Verify:

```bash
docker run --rm hello-world
```

> If you log out and back in, the group is applied permanently.

---

## Step 8 — Configure Docker to allow the MicroK8s insecure registry

The MicroK8s built-in registry runs on HTTP (no TLS) on port `32000`. Docker
needs to be told to allow pushing to it:

```bash
sudo nano /etc/docker/daemon.json
```

Add:

```json
{
  "insecure-registries": ["192.168.1.75:32000"]
}
```

Restart Docker to apply:

```bash
sudo systemctl restart docker
```

Verify Docker picked up the config:

```bash
docker info | grep -A5 "Insecure Registries"
```

Expected output:
```
 Insecure Registries:
  192.168.1.75:32000
  127.0.0.0/8
```

---

## Step 9 — Verify MicroK8s is still healthy

Docker should have no impact on MicroK8s, but confirm:

```bash
sudo microk8s status
sudo microk8s kubectl get nodes
```

All nodes should still show `Ready`. If anything looks wrong, see the
troubleshooting section below.

---

## Step 10 — Enable the MicroK8s registry (if not already done)

```bash
sudo microk8s enable registry

# Wait for it to start
sudo microk8s kubectl get pods -n container-registry
```

Expected:
```
NAME                                      READY   STATUS    RESTARTS
registry-<hash>                           1/1     Running   0
```

---

## Step 11 — Build and push the NodeDash image

```bash
cd ~/nodedash/app

# Build for arm64 (native on Pi 5 — no cross-compilation needed)
docker build -t 192.168.1.75:32000/nodedash:latest .

# Push to the MicroK8s registry
docker push 192.168.1.75:32000/nodedash:latest
```

Verify the image is in the registry:

```bash
curl http://192.168.1.75:32000/v2/_catalog
```

Expected:
```json
{"repositories":["nodedash"]}
```

---

## Step 12 — Update and deploy the DaemonSet

Edit `k8s/01-daemonset.yaml` and set the image line to:

```yaml
image: 192.168.1.75:32000/nodedash:latest
imagePullPolicy: Always
```

Then deploy:

```bash
sudo microk8s kubectl apply -f k8s/
```

Watch pods come up across all 4 nodes:

```bash
sudo microk8s kubectl get pods -n nodedash -o wide -w
```

---

## Docker Version Check

```bash
docker --version
docker buildx version
```

---

## Troubleshooting

### `permission denied` running docker without sudo
You need to log out and back in after `usermod`, or run `newgrp docker` to
apply the group in the current session.

### `Get "https://192.168.1.75:32000/v2/": http: server gave HTTP response to HTTPS client`
The `insecure-registries` entry in `daemon.json` is missing or Docker wasn't
restarted. Re-check Step 8.

### MicroK8s nodes show `NotReady` after Docker install
Docker's `containerd.io` package installs a system `containerd` service. It
should not affect MicroK8s (which uses snap-isolated containerd), but if you
see issues:

```bash
# Check if system containerd is interfering
sudo systemctl status containerd

# MicroK8s uses its own containerd — confirm it's running
sudo microk8s kubectl get pods -A | head -20
```

If system `containerd` is running and causing conflicts, disable it (Docker
uses its own socket, not this one):

```bash
sudo systemctl stop containerd
sudo systemctl disable containerd
sudo systemctl restart docker
sudo microk8s stop && sudo microk8s start
```

### Pods stuck in `ImagePullBackOff` after pushing
MicroK8s containerd needs to be told to trust the insecure registry.
MicroK8s pre-configures this for `localhost:32000` but **not** for
`192.168.1.75:32000`. Either push using `localhost`:

```bash
# From rk1, push to localhost instead
docker tag 192.168.1.75:32000/nodedash:latest localhost:32000/nodedash:latest
docker push localhost:32000/nodedash:latest
```

And update the DaemonSet image to:
```yaml
image: localhost:32000/nodedash:latest
```

> This is the recommended approach when building and pushing from rk1 itself —
> use `localhost:32000` for both the push and the image reference in the
> DaemonSet. MicroK8s trusts `localhost:32000` out of the box.

---

*cropseyit.com lab — rk1 — Docker CE on Ubuntu arm64 — March 2026*
