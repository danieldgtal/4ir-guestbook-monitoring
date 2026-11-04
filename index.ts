import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const guestbookNamespace = new k8s.core.v1.Namespace("guestbook", {
	metadata: {
		name: "guestbook",
	},
});

export const namespace = guestbookNamespace.metadata.name;

const ns = guestbookNamespace.metadata.name;
const redisImage = "redis:7.4-alpine";
const requests = { cpu: "100m", memory: "100Mi" };

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
					],
				},
			},
		},
	});

	return new k8s.core.v1.Service(name, {
		metadata: { name, namespace: ns, labels },
		spec: {
			selector: deployment.spec.template.metadata.labels,
			ports: [{ name: "redis", port: 6379, targetPort: "redis" }],
		},
	});
}

const master = deployRedis("redis-master");
const slave = deployRedis("redis-slave", [
	"--replicaof",
	master.metadata.name,
	"6379",
]);

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
