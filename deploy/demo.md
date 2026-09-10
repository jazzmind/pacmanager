# Private Kubernetes / EKS demo

Status: manifests and job adapter implemented; no cluster deployment has been performed here. This deploys the same bounded demo as the local version, not a general untrusted-code platform. Use a dedicated test cluster and synthetic data.

## Prerequisites

- Existing Kubernetes cluster, kubectl access to create the two demo namespaces, a working dynamic PVC storage class, and a network-policy-enforcing CNI. On EKS, provision the appropriate EBS CSI/storage configuration separately.
- Linux nodes able to pull your two private registry images. Build images for the node architecture. No cloud credentials are passed to the application or builder.
- Enforce network policy from pod startup. On EKS, enable the VPC CNI network-policy feature and **strict** enforcement mode; standard mode has an initial default-allow interval. Follow [AWS's configuration instructions](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy-configure.html) and assess cluster-wide implications before changing an existing cluster.
- Identify actual API server destination IPv4 addresses, including your CNI's pre/post-DNAT behavior. Only these destinations on port 443 are opened from the controller. Update addresses when endpoints change; failure is closed. No general DNS/internet exception is installed.

## Build and deploy

Build and push `demo/Dockerfile` from repository root and `demo/Builder.Dockerfile` with context `demo` to your approved registry. Example builds, after setting registry names:

```sh
docker build -f demo/Dockerfile -t "$PAC_PLATFORM_TAG" .
docker build -f demo/Builder.Dockerfile -t "$PAC_BUILDER_TAG" demo
docker push "$PAC_PLATFORM_TAG"
docker push "$PAC_BUILDER_TAG"
```

Set `PAC_PLATFORM_IMAGE` and `PAC_BUILDER_IMAGE` to their registry `name@sha256:...` digests. Set `PAC_API_CIDRS` to a comma-separated list of narrow API destination IPv4 CIDRs. Optionally set `PAC_STORAGE_CLASS` to your installed storage class. Then:

```sh
node deploy/demo-manifest.js > demo-deployment.json
kubectl apply --dry-run=server -f demo-deployment.json
kubectl apply -f demo-deployment.json
kubectl -n pac-demo rollout status deployment/pac-manager
kubectl -n pac-demo port-forward deployment/pac-manager 3000:3000
```

In another terminal, retrieve the owner token for local sign-in:

```sh
kubectl -n pac-demo exec deployment/pac-manager -- cat /data/owner.token
```

Open http://127.0.0.1:3000. Keep the port-forward running; the local stdio MCP bridge can target it. The default origin is exactly that URL. This path deliberately installs no public ingress, LoadBalancer or Service. An internal shared HTTPS endpoint needs separate ingress/auth design, an explicit ingress NetworkPolicy and `PAC_PUBLIC_ORIGIN` matching its URL. Port-forward is a Kubernetes administrator access path, not an artifact capability grant.

The generator emits two namespaces with restricted pod-security admission, default-deny ingress/egress, a single controller deployment with persistent storage, build namespace quotas and scoped job-controller RBAC. The controller has Kubernetes credentials; builder jobs do not. The controller role cannot modify policy. Builds are ephemeral Jobs with resource/deadline limits; optional `PAC_RUNTIME_CLASS` on the controller selects an already-installed sandbox runtime for jobs.

## Verification before showing isolation

1. Confirm default-deny policies exist in both namespaces and the CNI actually enforces them from pod startup.
2. With a temporary test pod using the build pod labels/security context, verify blocked internet, DNS, Kubernetes API, cloud metadata and cross-pod traffic. Check both directions; remove the test pod afterwards.
3. Build an app. Confirm the Job has no service-account token mount, runs non-root, cannot write the root filesystem and is cleaned up. Confirm a missing image or unavailable API fails the build without a process fallback.
4. Exercise the eight demo steps through port-forward and restart the controller; confirm persisted content and release remain.
5. Run `node --test` and rehearse with the actual authoring client and browser profiles.

The repository's adapter tests inspect intended restrictions; they do not prove CNI/kernel enforcement. Kubernetes node and control-plane traffic have exceptions that must be assessed in the cluster threat model. This runtime does not provide microVM tenant boundaries, a shared-service data plane, an L7 capability proxy, backups or production-grade auth. Keep one controller replica: the demo store is a single-writer file.
