# Guestbook Monitoring with Pulumi

This project extends the Pulumi Kubernetes Guestbook example with Prometheus
and Grafana. It runs the PHP frontend and Redis leader and replica on Kubernetes,
and provisions a Grafana dashboard for frontend availability, probe duration,
memory usage, and Redis connectivity.

## Deploy

You need Docker, Minikube, kubectl, Node.js with npm, and the Pulumi CLI.
This setup was tested on Apple Silicon. The frontend image is built for Linux ARM64.
The frontend expects the Redis Services to be named `redis-master` and `redis-slave`.

From the repository root:

```bash
minikube start -p 4ir-guestbook --driver=docker --cpus=4 --memory=6144
npm ci
pulumi login --local
pulumi stack init local
pulumi config set kubernetes:context 4ir-guestbook
pulumi config set --secret grafanaAdminPassword
npx tsc --noEmit
pulumi preview
pulumi up
```

Choose a Grafana password when prompted. If you already have a Pulumi backend
and stack for this project, select that stack and run the configuration and
deployment commands there.

## Access Grafana and Guestbook

Grafana is exposed as a Kubernetes `NodePort` Service. On Minikube, run
`minikube -p 4ir-guestbook service -n monitoring monitoring-grafana --url`
to get a browser URL through the Service, or use this local port-forward:

```bash
kubectl --context 4ir-guestbook -n monitoring \
  port-forward svc/monitoring-grafana 3000:80
```

Keep the port-forward running and open <http://localhost:3000>. Sign in as
`admin` with the password you set during deployment. The Pulumi stack provides
the access details:

```bash
pulumi stack output grafanaUrl
pulumi stack output grafanaAdminUser
pulumi stack output grafanaAdminPassword --show-secrets
```

To open Guestbook, run this in a separate terminal and visit
<http://localhost:8080>:

```bash
kubectl --context 4ir-guestbook -n guestbook \
  port-forward svc/frontend 8080:80
```

Submit a message and reload the page to verify the Redis write and read path.

## Verify Prometheus collection

Open **Grafana → Explore**, select **Prometheus**, and run each query:

| Query                                                                            | Expected result                                                |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `up{namespace="guestbook",endpoint="metrics"}`                                   | Two series at `1`. Prometheus can scrape both Redis exporters. |
| `redis_up{namespace="guestbook"}`                                                | Two series at `1`. Each exporter can reach its Redis instance. |
| `probe_success{job="guestbook-frontend"}`                                        | One series at `1`. The frontend HTTP probe succeeds.           |
| `probe_duration_seconds{job="guestbook-frontend"}`                               | Duration of the synthetic frontend HTTP probe, in seconds.     |
| `container_memory_working_set_bytes{namespace="guestbook",container="frontend"}` | Memory usage series for the frontend containers.               |

In **Dashboards → Guestbook Overview**, confirm the four panels show data.
Pulumi puts the exported dashboard JSON in a ConfigMap, and Grafana loads it
automatically. The HTTP probe checks whether the frontend page responds.
The submit-and-reload test verifies that a user can save and retrieve a message.

## Clean up

```bash
pulumi destroy
minikube delete -p 4ir-guestbook
```
