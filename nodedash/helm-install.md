Good call. Here's the standalone install procedure for your Pi 5 cluster:

**Install Helm on rk1 (control plane node only — you run helm from here):**
```bash
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

**Point Helm at your MicroK8s cluster permanently:**
```bash
echo "export KUBECONFIG=/var/snap/microk8s/current/credentials/client.config" >> ~/.bashrc
source ~/.bashrc
```

**Verify:**
```bash
helm version
helm list -A   # should return empty list, no errors
```

That's it — one node, no need to install Helm on rk2–rk4 since they're just workers. Helm talks to the Kubernetes API via kubeconfig, not directly to nodes.

One thing to watch on MicroK8s specifically: if you ever see permission errors on the kubeconfig file, fix with:
```bash
sudo microk8s config > ~/.kube/config
chmod 600 ~/.kube/config
export KUBECONFIG=~/.kube/config
```

That writes a standard kubeconfig to `~/.kube/config` which is what Helm expects by default, and avoids needing to reference the snap path directly. Either approach works — just pick one and stay consistent.

Want me to add a Helm section to the INSTALL.md?