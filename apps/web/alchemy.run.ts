/**
 * Cloudflare deployment of everything that can run on Cloudflare, declared
 * with Alchemy (https://alchemy.run) and applied with
 * `npm run deploy -- --stage <stage>` from this directory.
 *
 * Stages:
 * - `prod` (pushes to main): the site on its custom domain with a www redirect
 *   and Web Analytics; the control plane and the public gateway as Cloudflare
 *   Containers behind one edge Worker (`api.`, `gateway.`, and the preview
 *   wildcard); the Access applications and service token that guard host
 *   tunnels and internal routes; the R2 artifact bucket.
 * - anything else (`pr-<n>` previews, `live_<user>` local runs): the site
 *   only, served from its workers.dev URL. Nothing in the zone is touched.
 *
 * Deliberately not here: the Latitude hosts (Firecracker needs bare metal).
 * They keep their overlay address as identity and publish their internal API
 * through their own Cloudflare Tunnel (docs/nehemiah/adr/0005). See
 * docs/cloudflare.md for the runbook and .env.example for every setting.
 */
import * as Alchemy from 'alchemy';
import * as Cloudflare from 'alchemy/Cloudflare';
import * as Output from 'alchemy/Output';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';

/**
 * Site settings forwarded to the site Worker when present. They surface
 * through `$env/dynamic/*`; a missing value means the matching feature
 * (dashboard, status probes, support page) is unconfigured. In `prod` the
 * control-plane and gateway URLs default to the hostnames deployed here.
 */
const SITE_ENV = [
	'PUBLIC_NEHEMIAH_URL',
	'PRIVATE_NEHEMIAH_URL',
	'PUBLIC_CLERK_PUBLISHABLE_KEY',
	'PUBLIC_CLERK_FRONTEND_API',
	'STATUS_CONTROL_PLANE_URL',
	'STATUS_GATEWAY_URL',
	'PUBLIC_SUPPORT_URL',
	'PUBLIC_SUPPORT_EMAIL'
] as const;

/** Control-plane tuning forwarded verbatim when set (apps/nehemiah/.env.example). */
const CONTROL_PLANE_OPTIONAL_ENV = [
	'STRIPE_WEBHOOK_SECRET',
	'NEHEMIAH_DEFAULT_REGION',
	'NEHEMIAH_HOST_STALE_MS',
	'NEHEMIAH_API_RATE_LIMIT_ENABLED',
	'NEHEMIAH_API_RATE_LIMIT_FAIL_CLOSED',
	'NEHEMIAH_API_RATE_WINDOW_SECONDS',
	'NEHEMIAH_API_PREAUTH_IP_REQUESTS',
	'NEHEMIAH_API_PREAUTH_KEY_REQUESTS',
	'NEHEMIAH_API_PRINCIPAL_REQUESTS',
	'NEHEMIAH_API_PROJECT_REQUESTS',
	'NEHEMIAH_API_ORGANIZATION_REQUESTS',
	'NEHEMIAH_OTEL_EXPORT_INTERVAL_MS',
	'NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS',
	'NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO'
] as const;

/** Gateway tuning forwarded verbatim when set (gateway/config.go). */
const GATEWAY_OPTIONAL_ENV = [
	'NEHEMIAH_OTEL_EXPORT_INTERVAL_MS',
	'NEHEMIAH_OTEL_EXPORT_TIMEOUT_MS',
	'NEHEMIAH_OTEL_TRACE_SAMPLE_RATIO',
	'NEHEMIAH_GATEWAY_STREAM_MAX_DURATION',
	'NEHEMIAH_GATEWAY_TENANT_CONNECTIONS',
	'NEHEMIAH_GATEWAY_TENANT_BYTES_PER_SECOND',
	'NEHEMIAH_GATEWAY_REST_REQUESTS_PER_WINDOW'
] as const;

/** Build contexts are anchored here so the stack works from any cwd. */
const repositoryRoot = `${import.meta.dirname}/../..`;

/** An optional setting; blank values (an unset CI variable) count as unset. */
const optional = (name: string) =>
	Config.String(name).pipe(
		Config.option,
		Config.map(Option.filter((value) => value.trim() !== ''))
	);

const withDefault = (name: string, fallback: string) =>
	optional(name).pipe(Config.map(Option.getOrElse(() => fallback)));

/** A required secret; a missing value fails the deploy with its name. */
const secret = (name: string) => Config.Redacted(name);

/**
 * Container environment values: literals, redacted secrets, or outputs of
 * sibling resources (Alchemy resolves those at apply time and keeps redacted
 * outputs encrypted in state).
 */
type ContainerEnvValue = string | Redacted.Redacted<string>;
type ContainerEnv = Record<string, ContainerEnvValue | Alchemy.Output<ContainerEnvValue>>;

/** Collect the optional settings that are present, keeping them redacted in state. */
const optionalEnv = (names: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const env: ContainerEnv = {};
		for (const name of names) {
			const value = yield* optional(name);
			if (Option.isSome(value)) env[name] = Redacted.make(value.value);
		}
		return env;
	});

export default Alchemy.Stack(
	'boring-computers',
	{ providers: Cloudflare.providers(), state: Cloudflare.state() },
	Effect.gen(function* () {
		const stage = yield* Alchemy.Stage;
		const production = stage === 'prod';
		const siteDomain = yield* withDefault('SITE_DOMAIN', 'boringcomputers.com');
		const apiHostname = yield* withDefault('API_HOSTNAME', `api.${siteDomain}`);
		const gatewayHostname = yield* withDefault('GATEWAY_HOSTNAME', `gateway.${siteDomain}`);

		// ---- The site -----------------------------------------------------------
		const siteDefaults: Record<string, string> = production
			? {
					PUBLIC_NEHEMIAH_URL: `https://${gatewayHostname}`,
					PRIVATE_NEHEMIAH_URL: `https://${apiHostname}`,
					STATUS_CONTROL_PLANE_URL: `https://${apiHostname}`,
					STATUS_GATEWAY_URL: `https://${gatewayHostname}`
				}
			: {};
		const siteEnv: Record<
			string,
			Config.Config<Redacted.Redacted<string>> | Redacted.Redacted<string>
		> = {};
		for (const name of SITE_ENV) {
			if (Option.isSome(yield* optional(name))) siteEnv[name] = Config.Redacted(name);
			else if (siteDefaults[name]) siteEnv[name] = Redacted.make(siteDefaults[name]);
		}

		const site = yield* Cloudflare.Website.SvelteKit('Website', {
			env: siteEnv,
			// The zone must already exist in the account; Alchemy attaches the
			// custom domain (DNS + certificate) and 301s www to the apex.
			domain: production ? { name: siteDomain, redirects: [`www.${siteDomain}`] } : undefined
		});

		if (!production) return { url: site.url };

		// ---- Zone-level pieces: only the production stage owns anything here. ----

		// The zone predates this stack: adopt it for its id and never delete it.
		const zone = yield* Cloudflare.Zone.Zone('Zone', { name: siteDomain }).pipe(
			Alchemy.AdoptPolicy.adopt(true),
			Alchemy.RemovalPolicy.retain()
		);

		// Privacy-first page analytics, injected at the edge (replaces
		// @vercel/analytics, so the app ships no analytics code of its own).
		yield* Cloudflare.Rum.Site('WebAnalytics', { zoneTag: zone.zoneId, autoInstall: true });

		// Release/template artifacts. Retained on destroy: the control plane's
		// S3-compatible client holds customer-adjacent data here.
		const artifacts = yield* Cloudflare.R2.Bucket('Artifacts', {
			name: yield* withDefault('R2_BUCKET', 'nehemiah-artifacts')
		}).pipe(Alchemy.RemovalPolicy.retain());

		// ---- The managed cloud: control plane + gateway as Containers ----------

		// Machine previews must use a different registrable domain from the site
		// (both services refuse anything else), and both refuse to start in
		// production without one, so it is required here.
		const previewBaseDomain = yield* Config.String('PREVIEW_BASE_DOMAIN').pipe(
			Config.map((value) => value.trim().toLowerCase())
		);
		const previewZoneName = yield* withDefault('PREVIEW_ZONE_NAME', previewBaseDomain);
		// Hosts publish their tunnels at <address label>.<this domain>.
		const hostTunnelDomain = yield* withDefault('HOST_TUNNEL_DOMAIN', `hosts.${siteDomain}`);
		const hostCidrs = yield* withDefault('NEHEMIAH_HOST_CIDRS', '10.64.0.0/16,fd00:6e65:6865::/64');
		// The managed-host release version; the control plane rejects daemons
		// that do not report it.
		const serviceVersion = yield* Config.String('NEHEMIAH_SERVICE_VERSION');
		// Telemetry region label for both services (the control plane reads it
		// as NEHEMIAH_DEFAULT_REGION, the gateway as NEHEMIAH_REGION).
		const region = yield* withDefault('NEHEMIAH_DEFAULT_REGION', 'ca-tor-1');
		const otelEndpoint = yield* Config.String('NEHEMIAH_OTEL_ENDPOINT');
		const otelAuthorization = yield* secret('NEHEMIAH_OTEL_AUTHORIZATION');
		const gatewayOtelAuthorization = Option.getOrElse(
			yield* Config.Redacted('GATEWAY_OTEL_AUTHORIZATION').pipe(Config.option),
			() => otelAuthorization
		);
		const databaseUrl = yield* secret('DATABASE_URL');
		// Dashboard sign-in; the control plane refuses to start in production
		// without both.
		const clerkIssuer = yield* Config.String('CLERK_ISSUER');
		const clerkAudience = yield* Config.String('CLERK_AUDIENCE');
		const hostCredentialKey = yield* secret('NEHEMIAH_HOST_CREDENTIAL_KEY');
		const gatewayToken = yield* secret('NEHEMIAH_GATEWAY_TOKEN');
		const gatewaySecret = yield* secret('NEHEMIAH_GATEWAY_SECRET');
		const deviceCodePepper = yield* secret('NEHEMIAH_DEVICE_CODE_PEPPER');
		// The Access service token hosts present on internal routes. Minted by
		// the operator (Zero Trust → Access → Service Auth) so its secret never
		// enters this stack's state; only its id is needed for the policy.
		const fleetAccessTokenId = Option.getOrUndefined(yield* optional('FLEET_ACCESS_TOKEN_ID'));

		// The service token the control plane and gateway present to Access,
		// both toward host tunnels and toward the control plane's internal routes.
		const services = yield* Cloudflare.Access.ServiceToken('ServicesToken', {
			name: `boring-computers-${stage}-services`,
			duration: '8760h'
		});
		// Cloudflare reveals the secret only on create or rotate. A token adopted
		// from the account has none in state, so fail the apply rather than start
		// the containers with an empty credential.
		const servicesSecret = services.clientSecret.pipe(
			Output.map((value) => {
				if (value === undefined) {
					throw new Error(
						'The services Access token has no secret in state; bump clientSecretVersion to mint one.'
					);
				}
				return value;
			})
		);
		const serviceTokenRule = { serviceToken: services.serviceTokenId };

		yield* Cloudflare.Access.Application('HostsAccess', {
			type: 'self_hosted',
			name: `boring-computers-${stage}-hosts`,
			domain: `*.${hostTunnelDomain}`,
			policies: [
				{
					name: 'control plane and gateway',
					decision: 'non_identity',
					include: [serviceTokenRule]
				}
			]
		});
		yield* Cloudflare.Access.Application('InternalRoutesAccess', {
			type: 'self_hosted',
			name: `boring-computers-${stage}-internal`,
			domain: `${apiHostname}/internal`,
			policies: [
				{
					name: 'gateway and fleet service tokens',
					decision: 'non_identity',
					include: [
						serviceTokenRule,
						...(fleetAccessTokenId ? [{ serviceToken: fleetAccessTokenId }] : [])
					]
				}
			]
		});

		const controlPlaneEnv: ContainerEnv = {
			NODE_ENV: 'production',
			NEHEMIAH_HOST: '0.0.0.0',
			PORT: '8081',
			DATABASE_URL: databaseUrl,
			CLERK_ISSUER: clerkIssuer,
			CLERK_AUDIENCE: clerkAudience,
			NEHEMIAH_HOST_CREDENTIAL_KEY: hostCredentialKey,
			NEHEMIAH_GATEWAY_TOKEN: gatewayToken,
			NEHEMIAH_GATEWAY_SECRET: gatewaySecret,
			NEHEMIAH_DEVICE_CODE_PEPPER: deviceCodePepper,
			NEHEMIAH_GATEWAY_URL: `https://${gatewayHostname}`,
			NEHEMIAH_TRUSTED_SITE_DOMAIN: siteDomain,
			NEHEMIAH_PREVIEW_BASE_DOMAIN: previewBaseDomain,
			NEHEMIAH_HOST_CIDRS: hostCidrs,
			NEHEMIAH_HOST_PORT: '8080',
			NEHEMIAH_HOST_TRANSPORT: 'cloudflare-tunnel',
			NEHEMIAH_HOST_TUNNEL_DOMAIN: hostTunnelDomain,
			NEHEMIAH_HOST_ACCESS_CLIENT_ID: services.clientId,
			NEHEMIAH_HOST_ACCESS_CLIENT_SECRET: servicesSecret,
			NEHEMIAH_OTEL_ENABLED: 'true',
			NEHEMIAH_OTEL_ENDPOINT: otelEndpoint,
			NEHEMIAH_OTEL_AUTHORIZATION: otelAuthorization,
			NEHEMIAH_SERVICE_VERSION: serviceVersion,
			NEHEMIAH_INSTANCE_ID: `control-plane-${stage}`,
			NEHEMIAH_DEPLOYMENT_ENVIRONMENT: 'production',
			...(yield* optionalEnv(CONTROL_PLANE_OPTIONAL_ENV))
		};

		const gatewayEnv: ContainerEnv = {
			NEHEMIAH_ENV: 'production',
			NEHEMIAH_GATEWAY_ADDR: '0.0.0.0:8082',
			NEHEMIAH_CONTROL_PLANE_URL: `https://${apiHostname}`,
			NEHEMIAH_GATEWAY_TOKEN: gatewayToken,
			NEHEMIAH_GATEWAY_SECRET: gatewaySecret,
			NEHEMIAH_PREVIEW_BASE_DOMAIN: previewBaseDomain,
			NEHEMIAH_TRUSTED_SITE_DOMAIN: siteDomain,
			NEHEMIAH_HOST_PORT: '8080',
			NEHEMIAH_GATEWAY_ALLOWED_HOST_CIDRS: hostCidrs,
			NEHEMIAH_GATEWAY_HOST_TRANSPORT: 'cloudflare-tunnel',
			NEHEMIAH_GATEWAY_HOST_TUNNEL_DOMAIN: hostTunnelDomain,
			NEHEMIAH_GATEWAY_HOST_ACCESS_CLIENT_ID: services.clientId,
			NEHEMIAH_GATEWAY_HOST_ACCESS_CLIENT_SECRET: servicesSecret,
			NEHEMIAH_GATEWAY_CONTROL_PLANE_ACCESS_CLIENT_ID: services.clientId,
			NEHEMIAH_GATEWAY_CONTROL_PLANE_ACCESS_CLIENT_SECRET: servicesSecret,
			// The edge Worker is the only path into the container, so every peer
			// is the edge and CF-Connecting-IP is authoritative.
			NEHEMIAH_GATEWAY_TRUSTED_EDGE_CIDRS: '0.0.0.0/0,::/0',
			NEHEMIAH_REGION: region,
			NEHEMIAH_OTEL_ENABLED: 'true',
			NEHEMIAH_OTEL_ENDPOINT: otelEndpoint,
			NEHEMIAH_OTEL_AUTHORIZATION: gatewayOtelAuthorization,
			NEHEMIAH_SERVICE_VERSION: serviceVersion,
			NEHEMIAH_INSTANCE_ID: `gateway-${stage}`,
			NEHEMIAH_DEPLOYMENT_ENVIRONMENT: 'production',
			...(yield* optionalEnv(GATEWAY_OPTIONAL_ENV))
		};

		// One Worker fronts both containers (edge/worker.ts). Custom domains
		// carry the API and gateway; the preview wildcard is a zone route.
		const edge = yield* Cloudflare.Worker('Edge', {
			main: 'edge/worker.ts',
			env: {
				API_HOSTNAME: apiHostname,
				// Lets the Worker sign each caller's address for the control plane
				// the way the gateway does (edge/worker.ts).
				NEHEMIAH_GATEWAY_TOKEN: gatewayToken,
				CONTROL_PLANE: Cloudflare.Container('ControlPlane', {
					context: repositoryRoot,
					dockerfile: 'apps/nehemiah/Dockerfile',
					className: 'ControlPlane',
					instanceType: 'standard-2',
					maxInstances: 2,
					env: controlPlaneEnv
				}),
				GATEWAY: Cloudflare.Container('Gateway', {
					context: `${repositoryRoot}/gateway`,
					className: 'Gateway',
					instanceType: 'standard-2',
					maxInstances: 2,
					env: gatewayEnv
				})
			},
			domain: { name: apiHostname, aliases: [gatewayHostname] },
			routes: [{ pattern: `*.${previewBaseDomain}/*`, zoneName: previewZoneName }]
		});

		// A zone route only fires for proxied DNS names; point the wildcard at
		// the documentation placeholder address so Cloudflare terminates it.
		const previewZone = yield* Cloudflare.Zone.Zone('PreviewZone', {
			name: previewZoneName
		}).pipe(Alchemy.AdoptPolicy.adopt(true), Alchemy.RemovalPolicy.retain());
		yield* Cloudflare.DNS.Record('PreviewDns', {
			zoneId: previewZone.zoneId,
			name: `*.${previewBaseDomain}`,
			type: 'A',
			content: '192.0.2.1',
			proxied: true,
			comment: 'Nehemiah machine previews via the edge Worker (managed by alchemy)'
		});

		return {
			url: site.url,
			api: `https://${apiHostname}`,
			gateway: `https://${gatewayHostname}`,
			edgeWorker: edge.workerName,
			hostTunnelDomain,
			servicesAccessClientId: services.clientId,
			bucket: artifacts.bucketName
		};
	})
);
