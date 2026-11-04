import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { readFileSync } from "node:fs";

const guestbookNamespace = new k8s.core.v1.Namespace("guestbook", {
	metadata: {
		name: "guestbook",
	},
});

export const namespace = guestbookNamespace.metadata.name;

const ns = guestbookNamespace.metadata.name;
const redisImage = "redis:7.4-alpine";
const requests = { cpu: "100m", memory: "100Mi" };

// Function to deploy a Redis instance with a sidecar exporter
function deployRedis(
	name: string,
	args: k8s.types.input.core.v1.Container["args"] = [],
) {
	const labels = { app: name };

	const deployment = new k8s.apps.v1.Deployment(name, {
		metadata: { name, namespace: ns },
		spec: {
			replicas: 1,
			selector: { matchLabels: labels },
			template: {
				metadata: { labels },
				spec: {
					containers: [
						{
							name: "redis",
							image: redisImage,
							args,
							ports: [{ name: "redis", containerPort: 6379 }],
							resources: { requests },
						},
						{
							name: "redis-exporter",
							image: "oliver006/redis_exporter:v1.67.0",
							env: [{ name: "REDIS_ADDR", value: "redis://127.0.0.1:6379" }],
							ports: [{ name: "metrics", containerPort: 9121 }],
						},
					],
				},
			},
		},
	});

	return new k8s.core.v1.Service(name, {
		metadata: {
			name,
			namespace: ns,
			labels: { ...labels, "guestbook-metrics": "redis" },
		},
		spec: {
			selector: deployment.spec.template.metadata.labels,
			ports: [
				{ name: "redis", port: 6379, targetPort: "redis" },
				{ name: "metrics", port: 9121, targetPort: "metrics" },
			],
		},
	});
}
// Deploy the Redis master and slave instances
const master = deployRedis("redis-master");
const slave = deployRedis("redis-slave", [
	"--replicaof",
	master.metadata.name,
	"6379",
]);

// Deploy the frontend application
const frontendLabels = { app: "frontend" };
new k8s.apps.v1.Deployment(
	"frontend",
	{
		metadata: { name: "frontend", namespace: ns },
		spec: {
			replicas: 3,
			selector: { matchLabels: frontendLabels },
			template: {
				metadata: { labels: frontendLabels },
				spec: {
					containers: [
						{
							name: "frontend",
							image: "gcr.io/google_samples/gb-frontend-arm64:v5",
							env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
							ports: [{ name: "http", containerPort: 80 }],
							resources: { requests },
							readinessProbe: { httpGet: { path: "/", port: "http" } },
						},
					],
				},
			},
		},
	},
	{ dependsOn: [master, slave] },
);

new k8s.core.v1.Service("frontend", {
	metadata: { name: "frontend", namespace: ns, labels: frontendLabels },
	spec: {
		type: "ClusterIP",
		selector: frontendLabels,
		ports: [{ name: "http", port: 80, targetPort: "http" }],
	},
});

// Configure and deploy the monitoring stack
const config = new pulumi.Config();
const grafanaPassword = config.requireSecret("grafanaAdminPassword");

const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
	metadata: {
		name: "monitoring",
	},
});

const monitoringStack = new k8s.helm.v3.Release("monitoring", {
	name: "monitoring",
	namespace: monitoringNamespace.metadata.name,
	chart: "kube-prometheus-stack",
	version: "77.0.0",
	repositoryOpts: {
		repo: "https://prometheus-community.github.io/helm-charts",
	},
	timeout: 600,
	values: {
		alertmanager: {
			enabled: false,
		},
		grafana: {
			adminUser: "admin",
			adminPassword: grafanaPassword,
			service: { type: "NodePort" },
		},
	},
});

// Create a ServiceMonitor for the Redis instances
new k8s.apiextensions.CustomResource(
	"guestbook-redis-monitor",
	{
		apiVersion: "monitoring.coreos.com/v1",
		kind: "ServiceMonitor",
		metadata: {
			name: "guestbook-redis",
			namespace: ns,
			labels: { release: "monitoring" },
		},
		spec: {
			selector: { matchLabels: { "guestbook-metrics": "redis" } },
			endpoints: [{ port: "metrics", path: "/metrics", interval: "15s" }],
		},
	},
	{ dependsOn: [monitoringStack, master, slave] },
);

// Deploy the Blackbox Exporter for probing external endpoints
const blackboxLabels = { app: "blackbox-exporter" };
const blackboxDeployment = new k8s.apps.v1.Deployment(
	"blackbox-exporter",
	{
		metadata: {
			name: "blackbox-exporter",
			namespace: monitoringNamespace.metadata.name,
		},
		spec: {
			replicas: 1,
			selector: { matchLabels: blackboxLabels },
			template: {
				metadata: { labels: blackboxLabels },
				spec: {
					containers: [
						{
							name: "blackbox-exporter",
							image: "quay.io/prometheus/blackbox-exporter:v0.26.0",
							ports: [{ name: "http", containerPort: 9115 }],
						},
					],
				},
			},
		},
	},

	{ dependsOn: [monitoringStack] },
);

// Create a Service for the Blackbox Exporter
const blackboxService = new k8s.core.v1.Service(
	"blackbox-exporter",
	{
		metadata: {
			name: "blackbox-exporter",
			namespace: monitoringNamespace.metadata.name,
		},
		spec: {
			selector: blackboxLabels,
			ports: [{ name: "http", port: 9115, targetPort: "http" }],
		},
	},
	{ dependsOn: [blackboxDeployment] },
);

new k8s.apiextensions.CustomResource(
	"guestbook-frontend-probe",
	{
		apiVersion: "monitoring.coreos.com/v1",
		kind: "Probe",
		metadata: {
			name: "guestbook-frontend",
			namespace: monitoringNamespace.metadata.name,
			labels: { release: "monitoring" },
		},
		spec: {
			jobName: "guestbook-frontend",
			interval: "15s",
			module: "http_2xx",
			prober: {
				url: pulumi.interpolate`${blackboxService.metadata.name}.${monitoringNamespace.metadata.name}.svc:9115`,
			},
			targets: {
				staticConfig: {
					static: [
						pulumi.interpolate`http://frontend.${monitoringNamespace.metadata.name}.svc/`,
					],
				},
			},
		},
	},
	{ dependsOn: [monitoringStack] },
);

const guestbookDashboard = JSON.parse(
	readFileSync("dashboards/guestbook-grafana.json", "utf8"),
);

delete guestbookDashboard.id;

new k8s.core.v1.ConfigMap(
	"guestbook-dashboard",
	{
		metadata: {
			name: "guestbook-dashboard",
			namespace: monitoringNamespace.metadata.name,
			labels: { grafana_dashboard: "1" },
		},
		data: {
			"guestbook-grafana.json": JSON.stringify(guestbookDashboard),
		},
	},
	{ dependsOn: [monitoringStack] },
);

// Export Grafana connection details
export const grafanaUrl = "http://localhost:3000";
export const grafanaAdminUser = "admin";
export const grafanaAdminPassword = grafanaPassword;
