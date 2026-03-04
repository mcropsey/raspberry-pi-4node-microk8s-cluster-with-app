# MicroK8s Cluster on Raspberry Pi 5 — Build Guide

> **Purpose:** Step-by-step setup of a 4-node MicroK8s HA cluster on Raspberry Pi 5, including automated cgroup fixes required for Kubernetes on ARM.

---

## Cluster Layout

| Node  | Hostname | IP Address    | Role                    |
|-------|----------|---------------|-------------------------|
| Node1 | rk1      | 192.168.1.75  | Control Plane + Worker  |
| Node2 | rk2      | 192.168.1.76  | Control Plane + Worker  |
| Node3 | rk3      | 192.168.1.77  | Control Plane + Worker  |
| Node4 | rk4      | 192.168.1.78  | Control Plane + Worker  |

> All 4 nodes run as both control plane and worker in a **MicroK8s HA (High Availability)** configuration. `rk1` bootstraps the cluster; rk2–rk4 join with the `--worker` flag omitted so they become full control plane members. A minimum of 3 control plane nodes is required for etcd quorum; this 4-node setup exceeds that requirement.

---

## Step 1 — Configure Hostnames

Run on each respective node:

```bash
# rk1
sudo hostnamectl set-hostname rk1

# rk2
sudo hostnamectl set-hostname rk2

# rk3
sudo hostnamectl set-hostname rk3

# rk4
sudo hostnamectl set-hostname rk4
```

---

## Step 2 — Configure Local Name Resolution

Run on **all nodes**:

```bash
sudo nano /etc/hosts
```

Add the following entries:

```
192.168.1.75 rk1
192.168.1.76 rk2
192.168.1.77 rk3
192.168.1.78 rk4
```

Verify connectivity:

```bash
ping -c2 rk1
ping -c2 rk2
ping -c2 rk3
ping -c2 rk4
```

---

## Step 3 — Update the OS

Run on **all nodes**:

```bash
sudo apt update
sudo apt -y full-upgrade
sudo apt -y install linux-modules-extra-raspi curl
```

---

## Step 3a — Check for sudo-rs Conflict *(Ubuntu 25.10+ only)*

> ⚠️ **Ubuntu 25.10 (Questing Quokka) and later ship `sudo-rs`** — a Rust reimplementation of sudo that silently ignores the `-E` / `--preserve-env` flag. MicroK8s snap wrappers depend on this flag to pass `SNAP_DATA` and other environment variables. If `sudo-rs` is active, operations like `microk8s join` will crash with:
> ```
> FileNotFoundError: [Errno 2] No such file or directory: 'None/var/lock/join-in-progress'
> ```
> This is a confirmed issue — see [canonical/microk8s #5266](https://github.com/canonical/microk8s/issues/5266).
>
> **Ubuntu 24.04 LTS uses standard GNU sudo and is NOT affected. Skip this step if you are on 24.04.**

### Check which sudo is active

```bash
sudo --version
```

If the output references `sudo-rs` or a Rust-based implementation, apply the fix below.

### Option A — Interactive selection

```bash
sudo update-alternatives --config sudo
```

You will see output similar to:

```
  Selection    Path                 Priority   Status
------------------------------------------------------------
* 0            /usr/bin/sudo.rs      100        auto mode
  1            /usr/bin/sudo.ws       50        manual mode

Press <enter> to keep current choice, or type selection number:
```

Type `1` and press Enter to select `/usr/bin/sudo.ws` (legacy GNU sudo).

### Option B — Direct set (non-interactive)

```bash
sudo update-alternatives --set sudo /usr/bin/sudo.ws
```

### Verify the change

```bash
sudo --version
```

✅ Output should reference `Sudo version 1.9.x` or similar GNU sudo — **not** `sudo-rs`.

> ✅ This change persists across reboots. MicroK8s `join` and snap operations will work correctly once GNU sudo (`sudo.ws`) is active.

---

## Step 4 — Disable Swap

Verify swap is off:

```bash
free -h
```

Expected output:
```
Swap:          0B        0B        0B
```

If swap is present, disable it:

```bash
sudo swapoff -a
```

Remove from fstab permanently:

```bash
sudo nano /etc/fstab
```

Comment out any lines containing `swap`.

---

## Step 5 — Fix Raspberry Pi cgroups for Kubernetes (Automated)

> ⚠️ **Required on all nodes.** Raspberry Pi OS ships with `cgroup_disable=memory` which breaks Kubernetes. This step removes that flag and adds the correct parameters.

**Remove the incompatible parameter:**

```bash
sudo sed -i 's/cgroup_disable=memory//g' /boot/firmware/cmdline.txt
```

**Add Kubernetes-required cgroup parameters:**

```bash
sudo sed -i '1 s/$/ cgroup_enable=cpuset cgroup_enable=memory cgroup_memory=1/' /boot/firmware/cmdline.txt
```

**Reboot:**

```bash
sudo reboot
```

---

## Step 6 — Verify Kernel Parameters

After reboot, confirm the cgroup settings are active:

```bash
cat /proc/cmdline
```

✅ **Should be present:**
```
cgroup_enable=cpuset  cgroup_enable=memory  cgroup_memory=1
```

❌ **Should NOT be present:**
```
cgroup_disable=memory
```

---

## Step 7 — Install MicroK8s

Run on **all nodes**:

```bash
sudo snap install microk8s --classic --channel=1.29/stable
```

Wait for readiness:

```bash
sudo microk8s status --wait-ready
```

---

## Step 8 — Grant User Access to kubectl

Run on **each node** (substitute your username for `mcropsey` if different):

```bash
sudo usermod -a -G microk8s mcropsey
sudo chown -R mcropsey ~/.kube
newgrp microk8s
```

Test access:

```bash
microk8s kubectl get nodes
```

---

## Step 9 — Initialize the Cluster

Run on **rk1 only**:

```bash
sudo microk8s add-node
```

This outputs a join command similar to:

```
microk8s join 192.168.1.75:25000/xxxxxxxxxxxxxxxxxxxxxxxx
```

> ⚠️ Each `add-node` call generates a **single-use token**. Run `add-node` on rk1 separately for **each** node you want to join — three times total for rk2, rk3, and rk4.

> ✅ **Do NOT append `--worker`** to the join command. Omitting it causes the joining node to become a full control plane member (etcd + scheduler + API server), which is required for HA mode.

---

## Step 10 — Join Remaining Nodes as Control Plane Members

For each node, first run `sudo microk8s add-node` on **rk1** to generate a fresh token, then run the join command on the target node. **Do not add `--worker`.**

**rk2:**
```bash
sudo microk8s join 192.168.1.75:25000/xxxxxxxxxxxxxxxxxxxxxxxx
```

**rk3:**
```bash
sudo microk8s join 192.168.1.75:25000/xxxxxxxxxxxxxxxxxxxxxxxx
```

**rk4:**
```bash
sudo microk8s join 192.168.1.75:25000/xxxxxxxxxxxxxxxxxxxxxxxx
```

> Wait for each join to complete before moving to the next node. You can monitor progress on rk1 with `sudo microk8s kubectl get nodes -w`.

---

## Step 11 — Verify the Cluster

Run on **rk1**:

```bash
sudo microk8s kubectl get nodes -o wide
```

Expected output:

```
NAME   STATUS   ROLES          AGE   INTERNAL-IP
rk1    Ready    control-plane  ...   192.168.1.75
rk2    Ready    control-plane  ...   192.168.1.76
rk3    Ready    control-plane  ...   192.168.1.77
rk4    Ready    control-plane  ...   192.168.1.78
```

> In MicroK8s HA mode, all control plane nodes also schedule workloads by default — no taint is applied, so they function as workers too.

---

## Step 12 — Enable Core Kubernetes Services

Run on **rk1**:

```bash
# DNS
sudo microk8s enable dns

# Persistent storage (HostPath)
sudo microk8s enable hostpath-storage

# Ingress controller
sudo microk8s enable ingress

# Metrics
sudo microk8s enable metrics-server
```

---

## Step 13 — Enable MetalLB (Recommended)

MetalLB provides LoadBalancer IPs for services on a bare-metal cluster. Choose a small unused IP range on your network.

**Example range:** `192.168.1.90–192.168.1.99`

```bash
sudo microk8s enable metallb:192.168.1.90-192.168.1.99
```

> Adjust the range to match your network. Ensure these IPs are outside your DHCP scope.

---

## Step 14 — Test the Cluster

Deploy a test workload:

```bash
sudo microk8s kubectl create deployment nginx --image=nginx
```

Expose it via LoadBalancer:

```bash
sudo microk8s kubectl expose deployment nginx --port 80 --type LoadBalancer
```

Check the assigned IP:

```bash
sudo microk8s kubectl get svc
```

MetalLB should assign an external IP from your configured range.

**Clean up when done:**

```bash
sudo microk8s kubectl delete deployment nginx
sudo microk8s kubectl delete svc nginx
```

---

## Step 15 — Useful Cluster Commands

| Task | Command |
|------|---------|
| Check cluster health | `sudo microk8s status` |
| List nodes | `sudo microk8s kubectl get nodes` |
| List all pods | `sudo microk8s kubectl get pods -A` |
| Inspect cluster | `sudo microk8s inspect` |
| View logs for a pod | `sudo microk8s kubectl logs <pod-name> -n <namespace>` |
| Describe a node | `sudo microk8s kubectl describe node <node-name>` |

---

## Cluster Architecture

```
        MicroK8s HA Cluster — 4 Control Plane Nodes

  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │     rk1      │  │     rk2      │  │     rk3      │  │     rk4      │
  │ Control +    │  │ Control +    │  │ Control +    │  │ Control +    │
  │   Worker     │◄─►   Worker     │◄─►   Worker     │◄─►   Worker     │
  │ 192.168.1.75 │  │ 192.168.1.76 │  │ 192.168.1.77 │  │ 192.168.1.78 │
  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
         │                  │                 │                  │
         └──────────────────┴─────────────────┴──────────────────┘
                              etcd quorum (4 members)
```

---

## What to Deploy Next

This cluster is ready to run:

- **OWASP crAPI** — Vulnerable API app for security demos
- **OWASP Juice Shop** — Web app security training
- **APIClarity** — API traffic visibility
- **Traefik** — Ingress with TLS termination
- **GitOps pipelines** — ArgoCD or Flux
- **Akamai API Security lab workloads** — Discovery, Monitoring, Active Testing

---

*Guide version: March 2026 | MicroK8s channel: 1.29/stable | OS: Raspberry Pi OS (Ubuntu-based)*
